import type { DurableStore, GitHubClient, Comment, PullRequestState } from './store.js';
import { Job, Task, AgentRegistration } from './types.js';
import { parseAgent, parseJob, parseTask, renderAgentComment, renderJobBody, renderTaskComment, JOB_MARKER } from './markers.js';
import { isTaskForJob, sameTaskDefinition } from './store-task-definition.js';
import { resolveBlockerDependencies } from './blockers.js';

export class GitHubStore implements DurableStore {
  constructor(private readonly client: GitHubClient, private readonly repository: string, private readonly prNumber: number, private readonly trustedAuthors: ReadonlySet<string> = new Set()) {}
  private isTrusted(comment: Comment): boolean { return comment.authorLogin !== null && this.trustedAuthors.has(comment.authorLogin); }
  private repoParts(): { owner: string; name: string } {
    const [owner, name] = this.repository.split('/', 2);
    if (!owner || !name) throw new Error(`Invalid GitHub repository ${this.repository}`);
    return { owner, name };
  }
  private async graphql(query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.client.graphql) throw new Error('GitHub GraphQL client is required');
    return await this.client.graphql(query, variables) as Record<string, unknown>;
  }
  private async prNode(): Promise<Record<string, unknown>> {
    const { owner, name } = this.repoParts();
    const data = await this.graphql(
      'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){id state merged mergedAt closedAt body headRefName headRefOid}}}',
      { owner, name, number: this.prNumber }
    );
    const repository = data.repository as Record<string, unknown> | undefined;
    const pr = repository?.pullRequest as Record<string, unknown> | undefined;
    if (!pr) throw new Error(`Pull request #${this.prNumber} not found in ${this.repository}`);
    return pr;
  }
  private async pullRequestBody(): Promise<string> {
    const pr = await this.prNode();
    return typeof pr.body === 'string' ? pr.body : '';
  }
  private async list(): Promise<Comment[]> {
    const { owner, name } = this.repoParts();
    const all: Comment[] = [];
    let cursor: string | null = null;
    do {
      const data = await this.graphql(
        'query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){comments(first:100,after:$cursor){nodes{id databaseId url body updatedAt author{login}} pageInfo{hasNextPage endCursor}}}}}',
        { owner, name, number: this.prNumber, cursor }
      );
      const repository = data.repository as Record<string, unknown> | undefined;
      const pr = repository?.pullRequest as Record<string, unknown> | undefined;
      const comments = pr?.comments as Record<string, unknown> | undefined;
      const nodes = Array.isArray(comments?.nodes) ? comments.nodes as Array<Record<string, unknown>> : [];
      for (const value of nodes) {
        const author = value.author as Record<string, unknown> | undefined;
        all.push({
          id: Number(value.databaseId ?? 0),
          nodeId: typeof value.id === 'string' ? value.id : undefined,
          url: typeof value.url === 'string' ? value.url : undefined,
          body: String(value.body ?? ''),
          updatedAt: String(value.updatedAt ?? ''),
          authorLogin: typeof author?.login === 'string' ? author.login : null
        });
      }
      const pageInfo = comments?.pageInfo as Record<string, unknown> | undefined;
      cursor = pageInfo?.hasNextPage === true && typeof pageInfo.endCursor === 'string' ? pageInfo.endCursor : null;
    } while (cursor);
    return all;
  }
  async comments(): Promise<Comment[]> { return this.list(); }
  async pullRequestState(): Promise<PullRequestState> {
    const pr = await this.prNode();
    if (pr.merged === true || typeof pr.mergedAt === 'string') return 'MERGED';
    return String(pr.state ?? '').toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN';
  }
  async mergePullRequest(expectedHeadSha?: string): Promise<void> {
    const payload: Record<string, unknown> = { merge_method: 'squash' };
    if (expectedHeadSha) payload.sha = expectedHeadSha;
    const result = await this.client.request('repos/' + this.repository + '/pulls/' + this.prNumber + '/merge', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }) as Record<string, unknown>;
    if (result.merged !== true) throw new Error(typeof result.message === 'string' ? result.message : 'Pull request #' + this.prNumber + ' was not merged');
  }
  async closePullRequest(): Promise<void> {
    await this.client.request('repos/' + this.repository + '/pulls/' + this.prNumber, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) });
  }
  async updatePullRequestBody(body: string): Promise<void> {
    await this.client.request('repos/' + this.repository + '/pulls/' + this.prNumber, { method: 'PATCH', body: JSON.stringify({ body }) });
  }
  async pullRequestHead(): Promise<{ ref: string; sha: string } | null> {
    const pr = await this.prNode();
    const ref = typeof pr.headRefName === 'string' ? pr.headRefName : '';
    const sha = typeof pr.headRefOid === 'string' ? pr.headRefOid : '';
    return ref && sha ? { ref, sha } : null;
  }
  async headSha(): Promise<string | null> { return (await this.pullRequestHead())?.sha ?? null; }
  async resolveBlockerDependents(jobId: string, resolution: 'merge' | 'verified') {
    return await resolveBlockerDependencies({ blockerStore: this, blockerJobId: jobId, resolution, dependentStore: (repository, prNumber) => new GitHubStore(this.client, repository, prNumber, this.trustedAuthors) });
  }
  async load(jobId: string): Promise<Job> {
    const comments = (await this.list()).filter(comment => this.isTrusted(comment));
    const bodyJob = parseJob(await this.pullRequestBody());
    const commentJobs = comments.map(x => parseJob(x.body)).filter((x): x is Job => x !== null && typeof x.id === 'string' && x.id.length > 0);
    const jobs = bodyJob ? [bodyJob] : commentJobs;
    const job = jobs.find(x => x.id === jobId);
    if (!job) {
      const conflicting = bodyJob ?? commentJobs[0];
      if (conflicting) throw new Error(`JOB_ID_MISMATCH: PR #${this.prNumber} is bound to ${conflicting.id}, not ${jobId}`);
      throw new Error(`JOB_MARKER_MISSING: Managed GitHub job ${jobId} has no durable ${JOB_MARKER} marker in PR #${this.prNumber}`);
    }
    const soleTrustedJob = jobs.length === 1;
    job.tasks = comments.map(comment => {
      const task = parseTask(comment.body);
      if (!task) return null;
      const taskUrl = comment.url ?? (comment.id > 0 ? `https://github.com/${this.repository}/pull/${this.prNumber}#issuecomment-${comment.id}` : undefined);
      return taskUrl ? { ...task, taskUrl } : task;
    }).filter((x): x is Task => x !== null).filter(task => isTaskForJob(task, jobId, soleTrustedJob));
    return job;
  }
  async validateJobBinding(jobId: string): Promise<void> {
    const body = await this.pullRequestBody();
    const bodyHasMarker = body.includes(`<!-- ${JOB_MARKER} `);
    const bodyJob = parseJob(body);
    if (bodyHasMarker && !bodyJob) throw new Error(`JOB_MARKER_MALFORMED: PR #${this.prNumber} body contains a ${JOB_MARKER} marker that cannot be parsed`);
    if (bodyJob) {
      if (bodyJob.id !== jobId) throw new Error(`JOB_ID_MISMATCH: PR #${this.prNumber} is bound to ${bodyJob.id}, not ${jobId}`);
      return;
    }
    const comments = (await this.list()).filter(comment => this.isTrusted(comment));
    const markerComments = comments.filter(comment => comment.body.includes(JOB_MARKER));
    const parsed = markerComments.map(comment => parseJob(comment.body));
    const malformed = parsed.filter(job => job === null).length;
    if (malformed > 0) throw new Error(`JOB_MARKER_MALFORMED: PR #${this.prNumber} contains ${malformed} trusted ${JOB_MARKER} marker(s) that cannot be parsed`);
    const jobs = parsed.filter((job): job is Job => job !== null);
    const matches = jobs.filter(job => job.id === jobId);
    if (matches.length === 0) {
      if (jobs.length > 0) throw new Error(`JOB_ID_MISMATCH: PR #${this.prNumber} is bound to ${jobs.map(job => job.id).join(', ')}, not ${jobId}`);
      throw new Error(`JOB_MARKER_MISSING: Managed GitHub job ${jobId} has no durable ${JOB_MARKER} marker in PR #${this.prNumber}`);
    }
    if (matches.length > 1) throw new Error(`JOB_MARKER_DUPLICATED: PR #${this.prNumber} contains ${matches.length} trusted ${JOB_MARKER} markers for job ${jobId}`);
    if (jobs.length > 1) throw new Error(`JOB_BINDING_CONFLICT: PR #${this.prNumber} contains trusted ${JOB_MARKER} markers for multiple job ids`);
  }
  async listAgents(): Promise<AgentRegistration[]> { return (await this.list()).filter(comment => this.isTrusted(comment)).map(x => parseAgent(x.body)).filter((x): x is AgentRegistration => x !== null); }
  private async comment(body: string): Promise<void> {
    const pr = await this.prNode();
    await this.graphql(
      'mutation($subjectId:ID!,$body:String!){addComment(input:{subjectId:$subjectId,body:$body}){commentEdge{node{id}}}}',
      { subjectId: pr.id, body }
    );
  }
  private async updateComment(comment: Comment, body: string): Promise<void> {
    if (!comment.nodeId) throw new Error('GitHub comment node id is required for GraphQL update');
    await this.graphql(
      'mutation($id:ID!,$body:String!){updateIssueComment(input:{id:$id,body:$body}){issueComment{id}}}',
      { id: comment.nodeId, body }
    );
  }
  private async deleteComment(comment: Comment): Promise<void> {
    if (!comment.nodeId) throw new Error('GitHub comment node id is required for GraphQL delete');
    await this.graphql(
      'mutation($id:ID!){deleteIssueComment(input:{id:$id}){clientMutationId}}',
      { id: comment.nodeId }
    );
  }
  async saveJob(job: Job): Promise<void> {
    const currentBody = await this.pullRequestBody();
    const bodyJob = parseJob(currentBody);
    if (bodyJob && bodyJob.id !== job.id) throw new Error(`PR #${this.prNumber} body already has a different ${JOB_MARKER} marker`);

    const comments = (await this.list()).filter(comment => this.isTrusted(comment));
    const jobComments = comments.filter(comment => parseJob(comment.body) !== null);
    const conflicts = jobComments.filter(comment => parseJob(comment.body)?.id !== job.id);
    if (conflicts.length > 0) throw new Error(`PR #${this.prNumber} already has a different ${JOB_MARKER} marker`);

    await this.updatePullRequestBody(renderJobBody(job));

    const persisted = parseJob(await this.pullRequestBody());
    if (!persisted || persisted.id !== job.id) throw new Error(`Failed to persist ${JOB_MARKER} marker in PR #${this.prNumber} body for job ${job.id}`);

    for (const legacy of jobComments.filter(comment => parseJob(comment.body)?.id === job.id)) await this.deleteComment(legacy);
  }
  async appendTask(task: Task): Promise<void> {
    if (!task.jobId) throw new Error('GitHub task requires jobId');
    await this.load(task.jobId);
    const comments = (await this.list()).filter(comment => this.isTrusted(comment));
    const matches = comments.filter(comment => {
      const existing = parseTask(comment.body);
      return existing !== null && existing.jobId === task.jobId && existing.id === task.id;
    });
    if (matches.length === 0) { await this.comment(renderTaskComment(task)); return; }
    const parsed = matches.map(comment => ({ comment, task: parseTask(comment.body) as Task }));
    if (parsed.some(item => !sameTaskDefinition(item.task, task))) throw new Error(`Task ${task.id} already exists with a different definition`);
    for (const duplicate of parsed.slice(1)) await this.deleteComment(duplicate.comment);
  }
  async saveTask(task: Task): Promise<void> {
    const comments = (await this.list()).filter(comment => this.isTrusted(comment));
    const existing = comments.filter(comment => { const markerTask = parseTask(comment.body); return markerTask !== null && markerTask.jobId === task.jobId && markerTask.id === task.id; });
    if (existing.length > 0) {
      await this.updateComment(existing[0], renderTaskComment(task));
      for (const duplicate of existing.slice(1)) await this.deleteComment(duplicate);
    } else await this.appendTask(task);
  }
  async saveAgent(agent: AgentRegistration): Promise<void> {
    const comments = (await this.list()).filter(comment => this.isTrusted(comment));
    const existing = comments.find(comment => parseAgent(comment.body)?.id === agent.id);
    if (existing) await this.updateComment(existing, renderAgentComment(agent));
    else await this.comment(renderAgentComment(agent));
  }
}
