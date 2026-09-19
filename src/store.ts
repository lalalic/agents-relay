import { Job, Task } from './types.js';
import { spawn } from 'node:child_process';
import { parseAgent, parseJob, parseTask, renderAgentComment, renderJobComment, renderTaskComment, AGENT_MARKER, JOB_MARKER, TASK_MARKER } from './markers.js';
import { AgentRegistration } from './types.js';
export type Comment = { id: number; body: string; updatedAt: string; authorLogin: string | null };
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
export type GitHubClient = { request(path: string, init?: RequestInit): Promise<unknown> };
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
async function bootstrapEmptyHeadCommit(client: GitHubClient, repository: string, head: string): Promise<void> {
  const ref = await client.request(`/repos/${repository}/git/ref/heads/${head}`) as Record<string, unknown>;
  const object = ref.object as Record<string, unknown> | undefined;
  if (typeof object?.sha !== 'string' || object.sha.length === 0) throw new Error(`Unable to resolve head branch ${head}`);
  const parentSha = object.sha;
  const commit = await client.request(`/repos/${repository}/git/commits/${parentSha}`) as Record<string, unknown>;
  const tree = commit.tree as Record<string, unknown> | undefined;
  if (typeof tree?.sha !== 'string' || tree.sha.length === 0) throw new Error(`Unable to resolve tree for head branch ${head}`);
  const created = await client.request(`/repos/${repository}/git/commits`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'chore: bootstrap Agents Relay job', tree: tree.sha, parents: [parentSha] })
  }) as Record<string, unknown>;
  if (typeof created.sha !== 'string' || created.sha.length === 0) throw new Error(`Unable to create bootstrap commit for ${head}`);
  await client.request(`/repos/${repository}/git/refs/heads/${head}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sha: created.sha, force: false })
  });
}

function pullRequest(value: unknown): PullRequest {
  const item = value as Record<string, unknown>;
  const head = item.head as Record<string, unknown> | undefined;
  const base = item.base as Record<string, unknown> | undefined;
  const number = Number(item.number);
  if (!Number.isInteger(number) || number <= 0 || typeof head?.ref !== 'string' || typeof base?.ref !== 'string') throw new Error('Invalid GitHub pull request response');
  return { number, title: String(item.title ?? ''), body: String(item.body ?? ''), state: String(item.state ?? ''), head: head.ref, base: base.ref };
}

export async function resolvePullRequest(client: GitHubClient, repository: string, options: { prNumber?: number; head?: string; base?: string; title?: string; body?: string }): Promise<PullRequest> {
  if (options.prNumber) return pullRequest(await client.request(`/repos/${repository}/pulls/${options.prNumber}`));
  if (!options.head) throw new Error('--head is required when --pr is not provided');
  const base = options.base || 'main';
  const owner = repository.split('/')[0];
  const query = `/repos/${repository}/pulls?state=open&head=${encodeURIComponent(`${owner}:${options.head}`)}&base=${encodeURIComponent(base)}&per_page=100`;
  const find = async (): Promise<PullRequest | null> => {
    const response = await client.request(query);
    if (!Array.isArray(response)) throw new Error('GitHub pull request list response was not an array');
    const match = response.map(pullRequest).find(pr => pr.head === options.head && pr.base === base);
    return match ?? null;
  };
  const existing = await find();
  if (existing) return existing;
  if (!options.title) throw new Error('--title is required when creating a pull request');
  try {
    return pullRequest(await client.request(`/repos/${repository}/pulls`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: options.title, body: options.body ?? '', head: options.head, base })
    }));
  } catch (error) {
    const raced = await find();
    if (raced) return raced;
    const message = error instanceof Error ? error.message : String(error);
    let noCommitsBetween = /No commits between/i.test(message);
    if (!noCommitsBetween && /HTTP 422/i.test(message)) {
      try {
        const comparison = await client.request(`/repos/${repository}/compare/${base}...${options.head}`) as Record<string, unknown>;
        noCommitsBetween = Number(comparison.ahead_by) === 0;
      } catch {
        noCommitsBetween = false;
      }
    }
    if (noCommitsBetween) {
      await bootstrapEmptyHeadCommit(client, repository, options.head);
      const afterBootstrap = await find();
      if (afterBootstrap) return afterBootstrap;
      return pullRequest(await client.request(`/repos/${repository}/pulls`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: options.title, body: options.body ?? '', head: options.head, base })
      }));
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
      const value = await this.request('/user') as Record<string, unknown>;
      if (typeof value.login === 'string' && value.login.length > 0) return value.login;
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
  private async list(): Promise<Comment[]> { const all: Comment[] = []; for (let page = 1; page <= 100; page += 1) { const data = await this.client.request(`/repos/${this.repository}/issues/${this.prNumber}/comments?per_page=100&page=${page}`); if (!Array.isArray(data)) throw new Error('GitHub comments response was not an array'); const values = data.map((x: unknown) => { const v = x as Record<string, unknown>; const user = v.user as Record<string, unknown> | null | undefined; return { id: Number(v.id), body: String(v.body ?? ''), updatedAt: String(v.updated_at ?? ''), authorLogin: typeof user?.login === 'string' ? user.login : null }; }); all.push(...values); if (values.length < 100) break; } return all; }
  async comments(): Promise<Comment[]> { return this.list(); }
  async pullRequestState(): Promise<PullRequestState> { const value = await this.client.request(`/repos/${this.repository}/pulls/${this.prNumber}`) as Record<string, unknown>; if (value.merged === true || typeof value.merged_at === 'string') return 'MERGED'; return String(value.state ?? '').toLowerCase() === 'closed' ? 'CLOSED' : 'OPEN'; }
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
  private async comment(body: string): Promise<void> { await this.client.request(`/repos/${this.repository}/issues/${this.prNumber}/comments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body }) }); }
  async saveJob(job: Job): Promise<void> {
    const comments = (await this.list()).filter(comment => this.isTrusted(comment));
    const jobComments = comments.filter(comment => parseJob(comment.body) !== null);
    const conflicts = jobComments.filter(comment => parseJob(comment.body)?.id !== job.id);
    if (conflicts.length > 0) throw new Error(`PR #${this.prNumber} already has a different ${JOB_MARKER} marker`);
    const matches = jobComments.filter(comment => parseJob(comment.body)?.id === job.id);
    if (matches.length === 0) await this.comment(renderJobComment(job));
    else {
      await this.client.request(`/repos/${this.repository}/issues/comments/${matches[0].id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: renderJobComment(job) }) });
      for (const duplicate of matches.slice(1)) await this.client.request(`/repos/${this.repository}/issues/comments/${duplicate.id}`, { method: 'DELETE' });
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
    for (const duplicate of parsed.slice(1)) await this.client.request(`/repos/${this.repository}/issues/comments/${duplicate.comment.id}`, { method: 'DELETE' });
  }
  async saveTask(task: Task): Promise<void> {
    const comments = (await this.list()).filter(comment => this.isTrusted(comment));
    const existing = comments.filter(comment => { const markerTask = parseTask(comment.body); return markerTask !== null && markerTask.jobId === task.jobId && markerTask.id === task.id; });
    if (existing.length > 0) {
      await this.client.request(`/repos/${this.repository}/issues/comments/${existing[0].id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: renderTaskComment(task) }) });
      for (const duplicate of existing.slice(1)) await this.client.request(`/repos/${this.repository}/issues/comments/${duplicate.id}`, { method: 'DELETE' });
    } else await this.appendTask(task);
  }
  async saveAgent(agent: AgentRegistration): Promise<void> {
    const comments = (await this.list()).filter(comment => this.isTrusted(comment));
    const existing = comments.find(comment => parseAgent(comment.body)?.id === agent.id);
    if (existing) await this.client.request(`/repos/${this.repository}/issues/comments/${existing.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: renderAgentComment(agent) }) });
    else await this.comment(renderAgentComment(agent));
  }
}

export async function listManagedGitHubJobs(client: GitHubClient, repository: string, trustedAuthors: ReadonlySet<string>): Promise<ManagedJobOverview[]> {
  const pullRequests: Array<Record<string, unknown>> = [];
  for (let page = 1; ; page += 1) {
    const value = await client.request(`/repos/${repository}/pulls?state=all&per_page=100&page=${page}`);
    if (!Array.isArray(value)) throw new Error('GitHub pull request list response was not an array');
    const pageValues = value as Array<Record<string, unknown>>; pullRequests.push(...pageValues);
    if (pageValues.length < 100) break;
  }
  const output: ManagedJobOverview[] = [];
  const commentConcurrency = 8;
  for (let index = 0; index < pullRequests.length; index += commentConcurrency) {
    const batch = pullRequests.slice(index, index + commentConcurrency);
    const loaded = await Promise.all(batch.map(async pr => {
      const number = Number(pr.number);
      if (!Number.isInteger(number) || number <= 0) return { pr, comments: null as unknown[] | null };
      const comments = await client.request(`/repos/${repository}/issues/${number}/comments?per_page=100`);
      return { pr, comments: Array.isArray(comments) ? comments : null };
    }));
    for (const { pr, comments } of loaded) {
      if (!comments) continue;
      const trusted = comments.filter(item => { const row = item as Record<string, unknown>; const user = row.user as Record<string, unknown> | undefined; return typeof user?.login === 'string' && trustedAuthors.has(user.login); });
      const jobs = trusted.map(item => parseJob(String((item as Record<string, unknown>).body ?? ''))).filter((item): item is Job => item !== null);
      const tasks = trusted.map(item => parseTask(String((item as Record<string, unknown>).body ?? ''))).filter((item): item is Task => item !== null);
      const githubState: PullRequestState = pr.merged_at ? 'MERGED' : String(pr.state ?? '').toLowerCase() === 'closed' ? 'CLOSED' : 'OPEN';
      for (const job of jobs) {
        if (!job.description && typeof pr.body === 'string' && pr.body) job.description = pr.body;
        job.tasks = tasks.filter(task => task.jobId === job.id || (!task.jobId && jobs.length === 1));
        output.push({ job, githubState, draft: pr.draft === true, mergedAt: typeof pr.merged_at === 'string' ? pr.merged_at : null, closedAt: typeof pr.closed_at === 'string' ? pr.closed_at : null });
      }
    }
  }
  return output.sort((a, b) => b.job.prNumber - a.job.prNumber);
}

function isTaskForJob(task: Task, jobId: string, soleTrustedJob: boolean): boolean {
  if (task.jobId === jobId) return true;
  return !task.jobId && soleTrustedJob;
}
