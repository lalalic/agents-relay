import { Job, Task } from './types.js';
import { spawn } from 'node:child_process';
import { parseAgent, parseJob, parseTask, renderAgentComment, renderJobComment, renderTaskComment, AGENT_MARKER, JOB_MARKER, TASK_MARKER } from './markers.js';
import { AgentRegistration } from './types.js';
export type Comment = { id: number; nodeId?: string; body: string; updatedAt: string; authorLogin: string | null };
export type PullRequestState = 'OPEN' | 'MERGED' | 'CLOSED';
export type ManagedJobOverview = { job: Job; githubState: PullRequestState; draft: boolean; mergedAt: string | null; closedAt: string | null };
export async function loadManagedGitHubPullRequestGraphql(repository: string, prNumber: number, trustedAuthors: ReadonlySet<string>): Promise<ManagedJobOverview[]> {
  const [owner, name] = repository.split('/', 2);
  if (!owner || !name || !Number.isInteger(prNumber) || prNumber <= 0) return [];
  const query = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){state isDraft merged mergedAt closedAt body comments(last:100){nodes{author{login} body}}}}}';
  return new Promise<ManagedJobOverview[]>((resolve, reject) => {
    const child = spawn('gh', ['api','graphql','-f',`query=${query}`,'-F',`owner=${owner}`,'-F',`name=${name}`,'-F',`number=${prNumber}`]);
    let stdout=''; let stderr='';
    child.stdout.on('data',(chunk:Buffer)=>{stdout+=chunk.toString();});
    child.stderr.on('data',(chunk:Buffer)=>{stderr+=chunk.toString();});
    child.on('error',reject);
    child.on('close',code=>{
      if(code!==0){reject(new Error(stderr.trim()||`gh graphql exited ${code}`));return;}
      try{
        const payload=JSON.parse(stdout) as Record<string, unknown>;
        const data=payload.data as Record<string, unknown> | undefined;
        const repo=data?.repository as Record<string, unknown> | undefined;
        const pr=repo?.pullRequest as Record<string, unknown> | undefined;
        if(!pr){resolve([]);return;}
        const comments=(pr.comments as Record<string, unknown> | undefined)?.nodes;
        const trusted=(Array.isArray(comments)?comments:[]).filter(item=>{
          const row=item as Record<string, unknown>;
          const author=row.author as Record<string, unknown> | undefined;
          return typeof author?.login==='string'&&trustedAuthors.has(author.login);
        });
        const jobs=trusted.map(item=>parseJob(String((item as Record<string, unknown>).body??''))).filter((item): item is Job=>item!==null);
        const tasks=trusted.map(item=>parseTask(String((item as Record<string, unknown>).body??''))).filter((item): item is Task=>item!==null);
        const state=String(pr.state??'').toUpperCase();
        const githubState: PullRequestState = pr.merged===true ? 'MERGED' : state==='CLOSED' ? 'CLOSED' : 'OPEN';
        resolve(jobs.map(job=>{
          job.tasks=tasks.filter(task=>task.jobId===job.id||(!task.jobId&&jobs.length===1));
          if(!job.description&&typeof pr.body==='string'&&pr.body) job.description=pr.body;
          return {job,githubState,draft:pr.isDraft===true,mergedAt:typeof pr.mergedAt==='string'?pr.mergedAt:null,closedAt:typeof pr.closedAt==='string'?pr.closedAt:null};
        }));
      }catch(error){reject(error);}
    });
  });
}
export async function loadManagedGitHubJobGraphql(repository: string, prNumber: number, jobId: string, trustedAuthors: ReadonlySet<string>): Promise<ManagedJobOverview | null> {
  return (await loadManagedGitHubPullRequestGraphql(repository, prNumber, trustedAuthors)).find(item=>item.job.id===jobId) ?? null;
}
const COMPLETED_JOB_HISTORY_LIMIT = 10;
function isCompletedManagedJob(item: ManagedJobOverview): boolean { return ['COMPLETED', 'CANCELLED'].includes(item.job.state) || item.githubState !== 'OPEN'; }
function completedAt(item: ManagedJobOverview): string { return item.mergedAt ?? item.closedAt ?? item.job.updatedAt; }
export function dashboardManagedJobs(items: readonly ManagedJobOverview[]): ManagedJobOverview[] {
  const unfinished = items.filter(item => !isCompletedManagedJob(item));
  const completed = items.filter(isCompletedManagedJob).sort((a, b) => completedAt(b).localeCompare(completedAt(a)) || b.job.prNumber - a.job.prNumber).slice(0, COMPLETED_JOB_HISTORY_LIMIT);
  return [...unfinished, ...completed];
}
export interface DurableStore { load(jobId: string): Promise<Job>; saveJob(job: Job): Promise<void>; appendTask(task: Task): Promise<void>; saveTask(task: Task): Promise<void>; listAgents(): Promise<AgentRegistration[]>; saveAgent(agent: AgentRegistration): Promise<void>; comments(): Promise<Comment[]>; pullRequestState?(): Promise<PullRequestState>; }
export class InMemoryStore implements DurableStore {
  private readonly values = new Map<string, string>();
  constructor(job?: Job) {
    if (job) {
      this.values.set(`${JOB_MARKER}:${job.id}`, renderJobComment(job));
      for (const task of job.tasks) this.values.set(`${TASK_MARKER}:${task.jobId ?? ''}:${task.id}`, renderTaskComment(task));
    }
  }
  async load(jobId: string): Promise<Job> { const job = await this.findJob(jobId); if (!job) throw new Error(`Job ${jobId} not found`); job.tasks = this.tasksForJob(jobId); return job; }
  async saveJob(job: Job): Promise<void> { this.values.set(`${JOB_MARKER}:${job.id}`, renderJobComment(job)); }
  async appendTask(task: Task): Promise<void> {
    const key = `${TASK_MARKER}:${task.jobId ?? ''}:${task.id}`;
    const existing = this.values.get(key);
    if (existing) {
      const current = parseTask(existing);
      if (current && sameTaskDefinition(current, task)) return;
      throw new Error(`Task ${task.id} already exists with a different definition`);
    }
    this.values.set(key, renderTaskComment(task));
  }
  async saveTask(task: Task): Promise<void> { this.values.set(`${TASK_MARKER}:${task.jobId ?? ''}:${task.id}`, renderTaskComment(task)); }
  async listAgents(): Promise<AgentRegistration[]> { return [...this.values.values()].map(parseAgent).filter((x): x is AgentRegistration => x !== null); }
  async saveAgent(agent: AgentRegistration): Promise<void> { this.values.set(`${AGENT_MARKER}:${agent.id}`, renderAgentComment(agent)); }
  async comments(): Promise<Comment[]> { return [...this.values.values()].map((body, i) => ({ id: i + 1, body, updatedAt: new Date().toISOString(), authorLogin: 'local' })); }
  private findJob(jobId: string): Job | null { return [...this.values.values()].map(parseJob).find((x): x is Job => x !== null && x.id === jobId) ?? null; }
  private tasksForJob(jobId: string): Task[] {
    const jobs = [...this.values.values()].map(parseJob).filter((x): x is Job => x !== null && typeof x.id === 'string' && x.id.length > 0);
    return [...this.values.values()].map(parseTask).filter((x): x is Task => x !== null).filter(task => isTaskForJob(task, jobId, jobs.length === 1));
  }
}
export type GitHubClient = { request(path: string, init?: RequestInit): Promise<unknown>; graphql?(query: string, variables?: Record<string, unknown>): Promise<unknown> };
export type PullRequest = { number: number; title: string; body: string; state: string; head: string; base: string };

function immutableTaskDefinition(task: Task): unknown {
  const routing = task.routing ? {
    provider: task.routing.provider, model: task.routing.model, profile: task.routing.profile,
    reasoning: task.routing.reasoning, cwd: task.routing.cwd, projectId: task.routing.projectId
  } : undefined;
  return {
    jobId: task.jobId, id: task.id, priority: task.priority, projectName: task.projectName, agentName: task.agentName,
    parentTaskId: task.parentTaskId, dependencies: task.dependencies, capabilities: task.capabilities, adapter: task.adapter,
    input: task.input, routing, continuation: task.continuation ?? null, maxAttempts: task.maxAttempts, timeoutMs: task.timeoutMs
  };
}
function sameTaskDefinition(left: Task, right: Task): boolean {
  return JSON.stringify(immutableTaskDefinition(left)) === JSON.stringify(immutableTaskDefinition(right));
}
async function githubGraphql(client: GitHubClient, query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!client.graphql) throw new Error('GitHub GraphQL client is required');
  return await client.graphql(query, variables) as Record<string, unknown>;
}
function repositoryParts(repository: string): { owner: string; name: string } {
  const [owner, name] = repository.split('/', 2);
  if (!owner || !name) throw new Error(`Invalid GitHub repository ${repository}`);
  return { owner, name };
}
async function headHasNoAheadCommits(client: GitHubClient, repository: string, base: string, head: string): Promise<boolean> {
  const path = `repos/${repository}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
  const comparison = await client.request(path) as Record<string, unknown>;
  return Number(comparison.ahead_by) === 0;
}

async function bootstrapEmptyHeadCommit(client: GitHubClient, repository: string, head: string): Promise<void> {
  const { owner, name } = repositoryParts(repository);
  const data = await githubGraphql(
    client,
    'query($owner:String!,$name:String!,$qualified:String!){repository(owner:$owner,name:$name){ref(qualifiedName:$qualified){target{oid}}}}',
    { owner, name, qualified: `refs/heads/${head}` }
  );
  const repo = data.repository as Record<string, unknown> | undefined;
  const ref = repo?.ref as Record<string, unknown> | undefined;
  const target = ref?.target as Record<string, unknown> | undefined;
  const expectedHeadOid = typeof target?.oid === 'string' ? target.oid : '';
  if (!expectedHeadOid) throw new Error(`Unable to resolve head branch ${head}`);
  const created = await githubGraphql(
    client,
    'mutation($repositoryNameWithOwner:String!,$branchName:String!,$expectedHeadOid:GitObjectID!){createCommitOnBranch(input:{branch:{repositoryNameWithOwner:$repositoryNameWithOwner,branchName:$branchName},message:{headline:"chore: bootstrap Agents Relay job"},expectedHeadOid:$expectedHeadOid}){commit{oid}}}',
    { repositoryNameWithOwner: repository, branchName: head, expectedHeadOid }
  );
  const result = created.createCommitOnBranch as Record<string, unknown> | undefined;
  const commit = result?.commit as Record<string, unknown> | undefined;
  if (typeof commit?.oid !== 'string' || commit.oid.length === 0) throw new Error(`Unable to create bootstrap commit for ${head}`);
}

function pullRequest(value: unknown): PullRequest {
  const item = value as Record<string, unknown>;
  const head = item.head as Record<string, unknown> | undefined;
  const base = item.base as Record<string, unknown> | undefined;
  const number = Number(item.number);
  const headRef = typeof item.headRefName === 'string' ? item.headRefName : typeof head?.ref === 'string' ? head.ref : '';
  const baseRef = typeof item.baseRefName === 'string' ? item.baseRefName : typeof base?.ref === 'string' ? base.ref : '';
  if (!Number.isInteger(number) || number <= 0 || !headRef || !baseRef) throw new Error('Invalid GitHub pull request response');
  return { number, title: String(item.title ?? ''), body: String(item.body ?? ''), state: String(item.state ?? ''), head: headRef, base: baseRef };
}

export async function resolvePullRequest(client: GitHubClient, repository: string, options: { prNumber?: number; head?: string; base?: string; title?: string; body?: string }): Promise<PullRequest> {
  const { owner, name } = repositoryParts(repository);
  if (options.prNumber) {
    const data = await githubGraphql(
      client,
      'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){number title body state headRefName baseRefName}}}',
      { owner, name, number: options.prNumber }
    );
    const repo = data.repository as Record<string, unknown> | undefined;
    const pr = repo?.pullRequest;
    if (!pr) throw new Error(`Pull request #${options.prNumber} not found`);
    return pullRequest(pr);
  }
  if (!options.head) throw new Error('--head is required when --pr is not provided');
  const base = options.base || 'main';
  const find = async (): Promise<PullRequest | null> => {
    const data = await githubGraphql(
      client,
      'query($owner:String!,$name:String!,$head:String!,$base:String!){repository(owner:$owner,name:$name){pullRequests(first:20,states:OPEN,headRefName:$head,baseRefName:$base){nodes{number title body state headRefName baseRefName}}}}',
      { owner, name, head: options.head, base }
    );
    const repo = data.repository as Record<string, unknown> | undefined;
    const connection = repo?.pullRequests as Record<string, unknown> | undefined;
    const nodes = Array.isArray(connection?.nodes) ? connection.nodes : [];
    const match = nodes.map(pullRequest).find(pr => pr.head === options.head && pr.base === base);
    return match ?? null;
  };
  const existing = await find();
  if (existing) return existing;
  if (!options.title) throw new Error('--title is required when creating a pull request');
  if (await headHasNoAheadCommits(client, repository, base, options.head)) {
    await bootstrapEmptyHeadCommit(client, repository, options.head);
    const afterBootstrap = await find();
    if (afterBootstrap) return afterBootstrap;
  }
  const repositoryData = await githubGraphql(client, 'query($owner:String!,$name:String!){repository(owner:$owner,name:$name){id}}', { owner, name });
  const repo = repositoryData.repository as Record<string, unknown> | undefined;
  if (typeof repo?.id !== 'string') throw new Error(`Repository ${repository} not found`);
  const create = async (): Promise<PullRequest> => {
    const data = await githubGraphql(
      client,
      'mutation($repositoryId:ID!,$base:String!,$head:String!,$title:String!,$body:String!){createPullRequest(input:{repositoryId:$repositoryId,baseRefName:$base,headRefName:$head,title:$title,body:$body}){pullRequest{number title body state headRefName baseRefName}}}',
      { repositoryId: repo.id, base, head: options.head, title: options.title, body: options.body ?? '' }
    );
    const result = data.createPullRequest as Record<string, unknown> | undefined;
    if (!result?.pullRequest) throw new Error('GitHub createPullRequest returned no pull request');
    return pullRequest(result.pullRequest);
  };
  try {
    return await create();
  } catch (error) {
    const raced = await find();
    if (raced) return raced;
    const message = error instanceof Error ? error.message : String(error);
    if (/No commits between|no commits between/i.test(message)) {
      await bootstrapEmptyHeadCommit(client, repository, options.head);
      const afterBootstrap = await find();
      if (afterBootstrap) return afterBootstrap;
      return create();
    }
    throw error;
  }
}
export class GhApiClient implements GitHubClient {
  private cooldownUntil = 0;
  private rateLimitFailures = 0;
  rateLimitStatus(): { limited: boolean; cooldownUntil: string | null } {
    const limited = Date.now() < this.cooldownUntil;
    return { limited, cooldownUntil: limited ? new Date(this.cooldownUntil).toISOString() : null };
  }
  async graphql(query: string, variables: Record<string, unknown> = {}): Promise<unknown> {
    const payload = JSON.stringify({ query, variables });
    return new Promise<unknown>((resolve, reject) => {
      const child = spawn('gh', ['api', 'graphql', '--input', '-']);
      let stdout = ''; let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on('error', reject);
      child.stdin.write(payload); child.stdin.end();
      child.on('close', code => {
        if (code !== 0) { reject(new Error(stderr.trim() || `gh graphql exited ${code}`)); return; }
        try {
          const parsed = JSON.parse(stdout) as Record<string, unknown>;
          if (Array.isArray(parsed.errors) && parsed.errors.length > 0) throw new Error(JSON.stringify(parsed.errors));
          resolve(parsed.data ?? parsed);
        } catch (error) { reject(error); }
      });
    });
  }
  async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const now = Date.now();
    if (now < this.cooldownUntil) throw new Error(`GitHub API cooldown active until ${new Date(this.cooldownUntil).toISOString()}`);
    const args = ['api', path]; const method = String(init.method ?? 'GET');
    if (method !== 'GET') args.push('--method', method); if (init.body) args.push('--input', '-');
    return new Promise<unknown>((resolve, reject) => {
      const child = spawn('gh', args); let stdout = ''; let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on('error', reject); if (init.body) child.stdin.write(String(init.body)); child.stdin.end();
      child.on('close', code => {
        if (code !== 0) {
          const message = stderr.trim() || `gh api exited ${code}`;
          if (/rate limit|secondary rate|HTTP 429/i.test(message)) {
            this.rateLimitFailures += 1;
            const delay = Math.min(15 * 60_000, 60_000 * (2 ** Math.min(this.rateLimitFailures - 1, 4)));
            this.cooldownUntil = Date.now() + delay;
          }
          reject(new Error(message)); return;
        }
        this.rateLimitFailures = 0; this.cooldownUntil = 0;
        if (stdout.trim()) { try { resolve(JSON.parse(stdout) as unknown); } catch { resolve(stdout); } } else resolve(null);
      });
    });
  }
  async currentLogin(): Promise<string> {
    try {
      const value = await this.graphql('query { viewer { login } }') as Record<string, unknown>;
      const viewer = value.viewer as Record<string, unknown> | undefined;
      if (typeof viewer?.login === 'string' && viewer.login.length > 0) return viewer.login;
    } catch { /* fall back to gh's locally known active account below */ }
    return new Promise<string>((resolve, reject) => {
      const child = spawn('gh', ['auth', 'status', '--active', '--json', 'hosts']);
      let stdout = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.on('error', reject);
      child.on('close', () => {
        try {
          const value = JSON.parse(stdout) as Record<string, unknown>;
          const hosts = value.hosts as Record<string, unknown[]> | undefined;
          const github = hosts?.['github.com'];
          const active = Array.isArray(github) ? github.find(item => (item as Record<string, unknown>).active === true) as Record<string, unknown> | undefined : undefined;
          if (typeof active?.login === 'string' && active.login.length > 0) { resolve(active.login); return; }
        } catch { /* handled below */ }
        reject(new Error('gh authentication did not return a login'));
      });
    });
  }
}
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
      'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){id state merged mergedAt closedAt}}}',
      { owner, name, number: this.prNumber }
    );
    const repository = data.repository as Record<string, unknown> | undefined;
    const pr = repository?.pullRequest as Record<string, unknown> | undefined;
    if (!pr) throw new Error(`Pull request #${this.prNumber} not found in ${this.repository}`);
    return pr;
  }
  private async list(): Promise<Comment[]> {
    const { owner, name } = this.repoParts();
    const all: Comment[] = [];
    let cursor: string | null = null;
    do {
      const data = await this.graphql(
        'query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){comments(first:100,after:$cursor){nodes{id databaseId body updatedAt author{login}} pageInfo{hasNextPage endCursor}}}}}',
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
  async load(jobId: string): Promise<Job> {
    const comments = (await this.list()).filter(comment => this.isTrusted(comment));
    const jobs = comments.map(x => parseJob(x.body)).filter((x): x is Job => x !== null && typeof x.id === 'string' && x.id.length > 0);
    const job = jobs.find(x => x.id === jobId);
    if (!job) throw new Error(`Managed GitHub job ${jobId} has no durable ${JOB_MARKER} marker in PR #${this.prNumber}; run agents-relay job adopt --repo ${this.repository} --pr ${this.prNumber} --id ${jobId}`);
    const soleTrustedJob = jobs.length === 1;
    job.tasks = comments.map(x => parseTask(x.body)).filter((x): x is Task => x !== null).filter(task => isTaskForJob(task, jobId, soleTrustedJob));
    return job;
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
    const comments = (await this.list()).filter(comment => this.isTrusted(comment));
    const jobComments = comments.filter(comment => parseJob(comment.body) !== null);
    const conflicts = jobComments.filter(comment => parseJob(comment.body)?.id !== job.id);
    if (conflicts.length > 0) throw new Error(`PR #${this.prNumber} already has a different ${JOB_MARKER} marker`);
    const matches = jobComments.filter(comment => parseJob(comment.body)?.id === job.id);
    if (matches.length === 0) await this.comment(renderJobComment(job));
    else {
      await this.updateComment(matches[0], renderJobComment(job));
      for (const duplicate of matches.slice(1)) await this.deleteComment(duplicate);
    }
    const durable = (await this.list()).filter(comment => this.isTrusted(comment)).filter(comment => parseJob(comment.body)?.id === job.id);
    if (durable.length !== 1) throw new Error(`Failed to persist exactly one ${JOB_MARKER} marker for job ${job.id}`);
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

export async function listManagedGitHubJobs(client: GitHubClient, repository: string, trustedAuthors: ReadonlySet<string>): Promise<ManagedJobOverview[]> {
  if (!client.graphql) throw new Error('GitHub GraphQL client is required');
  const [owner, name] = repository.split('/', 2);
  if (!owner || !name) throw new Error(`Invalid GitHub repository ${repository}`);
  const output: ManagedJobOverview[] = [];
  let cursor: string | null = null;
  do {
    const data = await client.graphql(
      'query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){pullRequests(first:50,after:$cursor,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number body state isDraft merged mergedAt closedAt comments(first:100){nodes{author{login} body}}} pageInfo{hasNextPage endCursor}}}}',
      { owner, name, cursor }
    ) as Record<string, unknown>;
    const repo = data.repository as Record<string, unknown> | undefined;
    const connection = repo?.pullRequests as Record<string, unknown> | undefined;
    const nodes = Array.isArray(connection?.nodes) ? connection.nodes as Array<Record<string, unknown>> : [];
    for (const pr of nodes) {
      const comments = pr.comments as Record<string, unknown> | undefined;
      const rows = Array.isArray(comments?.nodes) ? comments.nodes as Array<Record<string, unknown>> : [];
      const trusted = rows.filter(item => {
        const author = item.author as Record<string, unknown> | undefined;
        return typeof author?.login === 'string' && trustedAuthors.has(author.login);
      });
      const jobs = trusted.map(item => parseJob(String(item.body ?? ''))).filter((item): item is Job => item !== null);
      const tasks = trusted.map(item => parseTask(String(item.body ?? ''))).filter((item): item is Task => item !== null);
      const state = String(pr.state ?? '').toUpperCase();
      const githubState: PullRequestState = pr.merged === true || state === 'MERGED' ? 'MERGED' : state === 'CLOSED' ? 'CLOSED' : 'OPEN';
      const number = Number(pr.number);
      for (const job of jobs) {
        if (!job.description && typeof pr.body === 'string' && pr.body) job.description = pr.body;
        if (Number.isInteger(number) && number > 0) job.prNumber = number;
        job.repository = repository;
        job.tasks = tasks.filter(task => task.jobId === job.id || (!task.jobId && jobs.length === 1));
        output.push({ job, githubState, draft: pr.isDraft === true, mergedAt: typeof pr.mergedAt === 'string' ? pr.mergedAt : null, closedAt: typeof pr.closedAt === 'string' ? pr.closedAt : null });
      }
    }
    const pageInfo = connection?.pageInfo as Record<string, unknown> | undefined;
    cursor = pageInfo?.hasNextPage === true && typeof pageInfo.endCursor === 'string' ? pageInfo.endCursor : null;
  } while (cursor);
  return output.sort((a, b) => b.job.prNumber - a.job.prNumber);
}

function isTaskForJob(task: Task, jobId: string, soleTrustedJob: boolean): boolean {
  if (task.jobId === jobId) return true;
  return !task.jobId && soleTrustedJob;
}
