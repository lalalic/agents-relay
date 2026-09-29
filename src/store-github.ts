import type { DurableStore, GitHubClient, Comment, PullRequestState, GitHubPullRequestSeed } from './store.js';
import { Job, Plan, Task, AgentRegistration } from './types.js';
import { parseAgent, parseJob, parsePlan, parseTask, renderAgentComment, renderJobBody, renderPlanComment, renderTaskComment, JOB_MARKER } from './markers.js';
import { isTaskForJob, sameTaskDefinition } from './store-task-definition.js';
import { registerBlockerDependency, resolveBlockerDependencies, type BlockerDependentTarget } from './blockers.js';

const TASK_WRITE_OVERLAY = new Map<string, Comment>();
const PLAN_WRITE_OVERLAY = new Map<string, Comment>();

export class GitHubStore implements DurableStore {
  private prNodeCache: Promise<Record<string, unknown>> | null = null;
  private commentsCache: Comment[] | null = null;
  private commentsFlight: Promise<Comment[]> | null = null;
  private clearReadSnapshot(): void { this.prNodeCache = null; this.commentsCache = null; this.commentsFlight = null; }
  constructor(private readonly client: GitHubClient, private readonly repository: string, private readonly prNumber: number, private readonly trustedAuthors: ReadonlySet<string> = new Set(), seed: GitHubPullRequestSeed | null = null) {
    if (seed) {
      if (Object.keys(seed.prNode).length > 0) this.prNodeCache = Promise.resolve(seed.prNode);
      if (seed.comments) this.commentsCache = [...seed.comments];
    }
  }
  private taskKey(task: Pick<Task, 'jobId' | 'id'>): string { return `${this.repository}#${this.prNumber}:${task.jobId ?? ''}/${task.id}`; }
  private planKey(plan: Pick<Plan, 'jobId' | 'id'>): string { return `${this.repository}#${this.prNumber}:${plan.jobId}/${plan.id}`; }
  private taskKeyFromBody(body: string): string | null { const task = parseTask(body); return task ? this.taskKey(task) : null; }
  private planKeyFromBody(body: string): string | null { const plan = parsePlan(body); return plan ? this.planKey(plan) : null; }
  private overlayTaskWrites(comments: Comment[]): Comment[] {
    if (TASK_WRITE_OVERLAY.size === 0) return comments;
    const result = [...comments];
    for (const [key, overlay] of [...TASK_WRITE_OVERLAY]) {
      const index = result.findIndex(comment => this.taskKeyFromBody(comment.body) === key);
      if (index >= 0) {
        const remote = result[index];
        if (remote.updatedAt && overlay.updatedAt && remote.updatedAt >= overlay.updatedAt) { TASK_WRITE_OVERLAY.delete(key); continue; }
        result[index] = { ...remote, ...overlay, id: remote.id || overlay.id, nodeId: remote.nodeId ?? overlay.nodeId, url: remote.url ?? overlay.url, authorLogin: remote.authorLogin ?? overlay.authorLogin };
      } else { TASK_WRITE_OVERLAY.delete(key); }
    }
    return result;
  }
  private rememberTaskWrite(task: Task, comment: Comment, body: string): void { TASK_WRITE_OVERLAY.set(this.taskKey(task), { ...comment, body }); }
  private overlayPlanWrites(comments: Comment[]): Comment[] {
    if (PLAN_WRITE_OVERLAY.size === 0) return comments;
    const result = [...comments];
    for (const [key, overlay] of [...PLAN_WRITE_OVERLAY]) {
      const index = result.findIndex(comment => this.planKeyFromBody(comment.body) === key);
      if (index >= 0) {
        const remote = result[index];
        if (remote.updatedAt && overlay.updatedAt && remote.updatedAt >= overlay.updatedAt) { PLAN_WRITE_OVERLAY.delete(key); continue; }
        result[index] = { ...remote, ...overlay, id: remote.id || overlay.id, nodeId: remote.nodeId ?? overlay.nodeId, url: remote.url ?? overlay.url, authorLogin: remote.authorLogin ?? overlay.authorLogin };
      } else { PLAN_WRITE_OVERLAY.delete(key); }
    }
    return result;
  }
  private rememberPlanWrite(plan: Plan, comment: Comment, body: string): void { PLAN_WRITE_OVERLAY.set(this.planKey(plan), { ...comment, body }); }
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
    if (this.prNodeCache) return this.prNodeCache;
    const flight = (async (): Promise<Record<string, unknown>> => {
      const { owner, name } = this.repoParts();
      const data = await this.graphql(
        'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){id state merged mergedAt closedAt body headRefName headRefOid}}}',
        { owner, name, number: this.prNumber }
      );
      const repository = data.repository as Record<string, unknown> | undefined;
      const pr = repository?.pullRequest as Record<string, unknown> | undefined;
      if (!pr) throw new Error(`Pull request #${this.prNumber} not found in ${this.repository}`);
      return pr;
    })();
    this.prNodeCache = flight;
    try { return await flight; } catch (error) { if (this.prNodeCache === flight) this.prNodeCache = null; throw error; }
  }
  private async pullRequestBody(): Promise<string> {
    const pr = await this.prNode();
    return typeof pr.body === 'string' ? pr.body : '';
  }
  private async list(): Promise<Comment[]> {
    if (this.commentsCache) return this.overlayPlanWrites(this.overlayTaskWrites(this.commentsCache));
    if (this.commentsFlight) return this.overlayPlanWrites(this.overlayTaskWrites(await this.commentsFlight));
    const flight = (async (): Promise<Comment[]> => {
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
          all.push({ id: Number(value.databaseId ?? 0), nodeId: typeof value.id === 'string' ? value.id : undefined, url: typeof value.url === 'string' ? value.url : undefined, body: String(value.body ?? ''), updatedAt: String(value.updatedAt ?? ''), authorLogin: typeof author?.login === 'string' ? author.login : null });
        }
        const pageInfo = comments?.pageInfo as Record<string, unknown> | undefined;
        cursor = pageInfo?.hasNextPage === true && typeof pageInfo.endCursor === 'string' ? pageInfo.endCursor : null;
      } while (cursor);
      return all;
    })();
    this.commentsFlight = flight;
    try { this.commentsCache = await flight; return this.overlayPlanWrites(this.overlayTaskWrites(this.commentsCache)); }
    finally { if (this.commentsFlight === flight) this.commentsFlight = null; }
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
    this.prNodeCache = null;
  }
  async closePullRequest(): Promise<void> {
    await this.client.request('repos/' + this.repository + '/pulls/' + this.prNumber, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) });
    this.prNodeCache = null;
  }
  async updatePullRequestBody(body: string): Promise<void> {
    await this.client.request('repos/' + this.repository + '/pulls/' + this.prNumber, { method: 'PATCH', body: JSON.stringify({ body }) });
    if (this.prNodeCache) { const current = await this.prNodeCache; this.prNodeCache = Promise.resolve({ ...current, body }); }
  }
  async pullRequestHead(): Promise<{ ref: string; sha: string } | null> {
    const pr = await this.prNode();
    const ref = typeof pr.headRefName === 'string' ? pr.headRefName : '';
    const sha = typeof pr.headRefOid === 'string' ? pr.headRefOid : '';
    return ref && sha ? { ref, sha } : null;
  }
  async headSha(): Promise<string | null> { return (await this.pullRequestHead())?.sha ?? null; }
  async registerBlockerDependent(jobId: string, dependent: BlockerDependentTarget): Promise<void> {
    await registerBlockerDependency({
      blockerStore: this,
      blockerJobId: jobId,
      dependentStore: new GitHubStore(this.client, dependent.repository, dependent.prNumber, this.trustedAuthors),
      dependentJobId: dependent.jobId,
      dependentTaskId: dependent.taskId,
      resolutionMode: dependent.resolutionMode,
    });
  }
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
      this.clearReadSnapshot();
      if (conflicting) throw new Error(`JOB_ID_MISMATCH: PR #${this.prNumber} is bound to ${conflicting.id}, not ${jobId}`);
      throw new Error(`JOB_MARKER_MISSING: Managed GitHub job ${jobId} has no durable ${JOB_MARKER} marker in PR #${this.prNumber}`);
    }
    const soleTrustedJob = jobs.length === 1;
    job.plans = comments.map(comment => { const plan = parsePlan(comment.body); if (!plan || plan.jobId !== jobId) return null; const planUrl = comment.url ?? (comment.id > 0 ? `https://github.com/${this.repository}/pull/${this.prNumber}#issuecomment-${comment.id}` : undefined); return planUrl ? { ...plan, planUrl } : plan; }).filter((x): x is Plan => x !== null).sort((a,b)=>a.round-b.round);
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
  private async comment(body: string): Promise<Comment> {
    const pr = await this.prNode();
    const data = await this.graphql(
      'mutation($subjectId:ID!,$body:String!){addComment(input:{subjectId:$subjectId,body:$body}){commentEdge{node{id databaseId url body updatedAt author{login}}}}}',
      { subjectId: pr.id, body }
    );
    const edge = (data.addComment as Record<string, unknown> | undefined)?.commentEdge as Record<string, unknown> | undefined;
    const node = edge?.node as Record<string, unknown> | undefined;
    const persisted: Comment = {
      id: Number(node?.databaseId ?? 0),
      nodeId: typeof node?.id === 'string' ? node.id : undefined,
      url: typeof node?.url === 'string' ? node.url : undefined,
      body: typeof node?.body === 'string' ? node.body : body,
      updatedAt: typeof node?.updatedAt === 'string' ? node.updatedAt : new Date().toISOString(),
      authorLogin: typeof (node?.author as Record<string, unknown> | undefined)?.login === 'string' ? String((node?.author as Record<string, unknown>).login) : [...this.trustedAuthors][0] ?? null,
    };
    if (this.commentsCache) this.commentsCache.push(persisted);
    return persisted;
  }
  private async updateComment(comment: Comment, body: string): Promise<Comment> {
    if (!comment.nodeId) throw new Error('GitHub comment node id is required for GraphQL update');
    const data = await this.graphql(
      'mutation($id:ID!,$body:String!){updateIssueComment(input:{id:$id,body:$body}){issueComment{id databaseId url body updatedAt author{login}}}}',
      { id: comment.nodeId, body }
    );
    const node = (data.updateIssueComment as Record<string, unknown> | undefined)?.issueComment as Record<string, unknown> | undefined;
    const persisted: Comment = {
      id: Number(node?.databaseId ?? comment.id),
      nodeId: typeof node?.id === 'string' ? node.id : comment.nodeId,
      url: typeof node?.url === 'string' ? node.url : comment.url,
      body: typeof node?.body === 'string' ? node.body : body,
      updatedAt: typeof node?.updatedAt === 'string' ? node.updatedAt : new Date().toISOString(),
      authorLogin: typeof (node?.author as Record<string, unknown> | undefined)?.login === 'string' ? String((node?.author as Record<string, unknown>).login) : comment.authorLogin,
    };
    if (this.commentsCache) { const index = this.commentsCache.findIndex(item => item.nodeId === comment.nodeId || (item.id > 0 && item.id === comment.id)); if (index >= 0) this.commentsCache[index] = persisted; }
    return persisted;
  }
  private async deleteComment(comment: Comment): Promise<void> {
    if (!comment.nodeId) throw new Error('GitHub comment node id is required for GraphQL delete');
    await this.graphql(
      'mutation($id:ID!){deleteIssueComment(input:{id:$id}){clientMutationId}}',
      { id: comment.nodeId }
    );
    if (this.commentsCache) this.commentsCache = this.commentsCache.filter(item => item.nodeId !== comment.nodeId && !(item.id > 0 && item.id === comment.id));
  }
  async saveJob(job: Job): Promise<void> {
    const currentBody = await this.pullRequestBody();
    const bodyJob = parseJob(currentBody);
    if (bodyJob && bodyJob.id !== job.id) throw new Error(`PR #${this.prNumber} body already has a different ${JOB_MARKER} marker`);

    const comments = (await this.list()).filter(comment => this.isTrusted(comment));
    const jobComments = comments.filter(comment => parseJob(comment.body) !== null);
    const conflicts = jobComments.filter(comment => parseJob(comment.body)?.id !== job.id);
    if (conflicts.length > 0) throw new Error(`PR #${this.prNumber} already has a different ${JOB_MARKER} marker`);

    const nextBody = renderJobBody(job);
    if (currentBody !== nextBody) {
      await this.updatePullRequestBody(nextBody);
      const persisted = parseJob(await this.pullRequestBody());
      if (!persisted || persisted.id !== job.id) throw new Error(`Failed to persist ${JOB_MARKER} marker in PR #${this.prNumber} body for job ${job.id}`);
    }

    for (const legacy of jobComments.filter(comment => parseJob(comment.body)?.id === job.id)) await this.deleteComment(legacy);
  }
  async appendPlan(plan: Plan): Promise<void> {
    await this.load(plan.jobId);
    const comments = (await this.list()).filter(comment => this.isTrusted(comment));
    const matches = comments.filter(comment => { const existing = parsePlan(comment.body); return existing !== null && existing.jobId === plan.jobId && existing.id === plan.id; });
    if (matches.length === 0) { const body = renderPlanComment(plan); const persisted = await this.comment(body); this.rememberPlanWrite(plan, persisted, body); return; }
    const existing = parsePlan(matches[0].body);
    if (!existing || JSON.stringify({ ...existing, planUrl: undefined }) !== JSON.stringify({ ...plan, planUrl: undefined })) throw new Error(`Plan ${plan.id} already exists with a different definition`);
    for (const duplicate of matches.slice(1)) await this.deleteComment(duplicate);
  }
  async savePlan(plan: Plan): Promise<void> {
    await this.load(plan.jobId);
    const comments = (await this.list()).filter(comment => this.isTrusted(comment));
    const existing = comments.filter(comment => { const markerPlan = parsePlan(comment.body); return markerPlan !== null && markerPlan.jobId === plan.jobId && markerPlan.id === plan.id; });
    if (existing.length > 0) { const body = renderPlanComment(plan); const persisted = await this.updateComment(existing[0], body); this.rememberPlanWrite(plan, persisted, body); for (const duplicate of existing.slice(1)) await this.deleteComment(duplicate); }
    else await this.appendPlan(plan);
  }
  async appendTask(task: Task): Promise<void> {
    if (!task.jobId) throw new Error('GitHub task requires jobId');
    await this.load(task.jobId);
    const comments = (await this.list()).filter(comment => this.isTrusted(comment));
    const matches = comments.filter(comment => {
      const existing = parseTask(comment.body);
      return existing !== null && existing.jobId === task.jobId && existing.id === task.id;
    });
    if (matches.length === 0) { const body = renderTaskComment(task); const persisted = await this.comment(body); this.rememberTaskWrite(task, persisted, body); return; }
    const parsed = matches.map(comment => ({ comment, task: parseTask(comment.body) as Task }));
    if (parsed.some(item => !sameTaskDefinition(item.task, task))) throw new Error(`Task ${task.id} already exists with a different definition`);
    for (const duplicate of parsed.slice(1)) await this.deleteComment(duplicate.comment);
  }
  async saveTask(task: Task): Promise<void> {
    const comments = (await this.list()).filter(comment => this.isTrusted(comment));
    const existing = comments.filter(comment => { const markerTask = parseTask(comment.body); return markerTask !== null && markerTask.jobId === task.jobId && markerTask.id === task.id; });
    if (existing.length > 0) {
      const body = renderTaskComment(task);
      const persisted = await this.updateComment(existing[0], body);
      this.rememberTaskWrite(task, persisted, body);
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
