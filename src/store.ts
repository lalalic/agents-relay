import { Job, Task } from './types.js';
import { spawn } from 'node:child_process';
import { createSign } from 'node:crypto';
import { parseAgent, parseJob, parseTask, renderAgentComment, renderJobBody, renderJobComment, renderTaskComment, AGENT_MARKER, JOB_MARKER, TASK_MARKER } from './markers.js';
import { AgentRegistration } from './types.js';
export type Comment = { id: number; nodeId?: string; url?: string; body: string; updatedAt: string; authorLogin: string | null };
export type PullRequestState = 'OPEN' | 'MERGED' | 'CLOSED';
export type ManagedJobOverview = { job: Job; githubState: PullRequestState; draft: boolean; mergedAt: string | null; closedAt: string | null };
export async function loadManagedGitHubPullRequestGraphql(client: GitHubClient, repository: string, prNumber: number, trustedAuthors: ReadonlySet<string>): Promise<ManagedJobOverview[]> {
  const [owner, name] = repository.split('/', 2);
  if (!owner || !name || !Number.isInteger(prNumber) || prNumber <= 0 || !client.graphql) return [];
  const query = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){state isDraft merged mergedAt closedAt body comments(last:100){nodes{author{login} body}}}}}';
  const data = await client.graphql(query, { owner, name, number: prNumber }) as Record<string, unknown>;
  const repo = data.repository as Record<string, unknown> | undefined;
  const pr = repo?.pullRequest as Record<string, unknown> | undefined;
  if (!pr) return [];
  const comments = (pr.comments as Record<string, unknown> | undefined)?.nodes;
  const trusted = (Array.isArray(comments) ? comments : []).filter(item => {
    const row = item as Record<string, unknown>; const author = row.author as Record<string, unknown> | undefined;
    return typeof author?.login === 'string' && trustedAuthors.has(author.login);
  });
  const bodyJob = parseJob(typeof pr.body === 'string' ? pr.body : '');
  const commentJobs = trusted.map(item => parseJob(String((item as Record<string, unknown>).body ?? ''))).filter((item): item is Job => item !== null);
  const jobs = bodyJob ? [bodyJob] : commentJobs;
  const tasks = trusted.map(item => parseTask(String((item as Record<string, unknown>).body ?? ''))).filter((item): item is Task => item !== null);
  const state = String(pr.state ?? '').toUpperCase();
  const githubState: PullRequestState = pr.merged === true ? 'MERGED' : state === 'CLOSED' ? 'CLOSED' : 'OPEN';
  return jobs.map(job => {
    job.tasks = tasks.filter(task => task.jobId === job.id || (!task.jobId && jobs.length === 1));
    if (!job.description && typeof pr.body === 'string' && pr.body) job.description = pr.body;
    return { job, githubState, draft: pr.isDraft === true, mergedAt: typeof pr.mergedAt === 'string' ? pr.mergedAt : null, closedAt: typeof pr.closedAt === 'string' ? pr.closedAt : null };
  });
}
export async function loadManagedGitHubJobGraphql(client: GitHubClient, repository: string, prNumber: number, jobId: string, trustedAuthors: ReadonlySet<string>): Promise<ManagedJobOverview | null> {
  return (await loadManagedGitHubPullRequestGraphql(client, repository, prNumber, trustedAuthors)).find(item => item.job.id === jobId) ?? null;
}
const COMPLETED_JOB_HISTORY_LIMIT = 10;
function isCompletedManagedJob(item: ManagedJobOverview): boolean { return ['COMPLETED', 'CANCELLED'].includes(item.job.state) || item.githubState !== 'OPEN'; }
function completedAt(item: ManagedJobOverview): string {
  return [item.job.updatedAt, item.mergedAt, item.closedAt].filter((value): value is string => typeof value === 'string' && value.length > 0).sort().at(-1) ?? '';
}
export function dashboardManagedJobs(items: readonly ManagedJobOverview[]): ManagedJobOverview[] {
  const unfinished = items.filter(item => !isCompletedManagedJob(item));
  const completed = items.filter(isCompletedManagedJob).sort((a, b) => completedAt(b).localeCompare(completedAt(a)) || b.job.prNumber - a.job.prNumber).slice(0, COMPLETED_JOB_HISTORY_LIMIT);
  return [...unfinished, ...completed];
}
export interface DurableStore { load(jobId: string): Promise<Job>; saveJob(job: Job): Promise<void>; appendTask(task: Task): Promise<void>; saveTask(task: Task): Promise<void>; listAgents(): Promise<AgentRegistration[]>; saveAgent(agent: AgentRegistration): Promise<void>; comments(): Promise<Comment[]>; pullRequestState?(): Promise<PullRequestState>; headSha?(): Promise<string | null>; mergePullRequest?(expectedHeadSha?: string): Promise<void>; closePullRequest?(): Promise<void>; updatePullRequestBody?(body: string): Promise<void>; }
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
  async closePullRequest(): Promise<void> {}
  async updatePullRequestBody(_body: string): Promise<void> {}
  async headSha(): Promise<string | null> { const jobs = [...this.values.values()].map(parseJob).filter((x): x is Job => x !== null); return jobs[0]?.headSha ?? jobs[0]?.review?.headSha ?? null; }
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
    jobId: task.jobId, id: task.id, priority: task.priority, storySize: task.storySize ?? 'M', projectName: task.projectName, agentName: task.agentName,
    kind: task.kind ?? 'work', planningDecisionId: task.planningDecisionId, planningSource: task.planningSource, planningRound: task.planningRound, parentTaskId: task.parentTaskId, dependencies: task.dependencies, capabilities: task.capabilities, workerRequirements: task.workerRequirements, workerSelection: task.workerSelection, adapter: task.adapter,
    input: task.input, attachments: task.attachments, output: task.output, routing, chatgptTabClosePolicy: task.chatgptTabClosePolicy ?? 'after-start', continuation: task.continuation ?? null, maxAttempts: task.maxAttempts, timeoutMs: task.timeoutMs
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
  try {
    const comparison = await client.request(path) as Record<string, unknown>;
    return Number(comparison.ahead_by) === 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/404|Not Found/i.test(message)) return true;
    throw error;
  }
}

async function bootstrapEmptyHeadCommit(client: GitHubClient, repository: string, base: string, head: string): Promise<void> {
  const { owner, name } = repositoryParts(repository);
  const data = await githubGraphql(
    client,
    'query($owner:String!,$name:String!,$head:String!,$base:String!){repository(owner:$owner,name:$name){head:ref(qualifiedName:$head){target{... on Commit{oid tree{oid}}}} base:ref(qualifiedName:$base){target{... on Commit{oid tree{oid}}}}}}',
    { owner, name, head: `refs/heads/${head}`, base: `refs/heads/${base}` }
  );
  const repo = data.repository as Record<string, unknown> | undefined;
  const headRef = repo?.head as Record<string, unknown> | undefined;
  const baseRef = repo?.base as Record<string, unknown> | undefined;
  const target = (headRef?.target ?? baseRef?.target) as Record<string, unknown> | undefined;
  const tree = target?.tree as Record<string, unknown> | undefined;
  const expectedHeadOid = typeof target?.oid === 'string' ? target.oid : '';
  const treeOid = typeof tree?.oid === 'string' ? tree.oid : '';
  if (!expectedHeadOid || !treeOid) throw new Error(`Unable to resolve head branch ${head} or base branch ${base}`);
  if (!headRef) {
    await client.request(`repos/${repository}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${head}`, sha: expectedHeadOid }),
    });
  }

  const created = await client.request(`repos/${repository}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({
      message: 'chore: bootstrap Agents Relay job',
      tree: treeOid,
      parents: [expectedHeadOid],
    }),
  }) as Record<string, unknown>;
  const commitOid = typeof created.sha === 'string' ? created.sha : '';
  if (!commitOid) throw new Error(`Unable to create bootstrap commit for ${head}`);

  await client.request(`repos/${repository}/git/refs/heads/${head}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commitOid, force: false }),
  });
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
    await bootstrapEmptyHeadCommit(client, repository, base, options.head);
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
      await bootstrapEmptyHeadCommit(client, repository, base, options.head);
      const afterBootstrap = await find();
      if (afterBootstrap) return afterBootstrap;
      return create();
    }
    throw error;
  }
}
export type GitHubAppAuthOptions = { appId: string; installationId: string; privateKey: string };

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

export function createGitHubAppJwt(options: GitHubAppAuthOptions, now = Math.floor(Date.now() / 1000)): string {
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: options.appId }));
  const unsigned = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256'); signer.update(unsigned); signer.end();
  return `${unsigned}.${signer.sign(options.privateKey).toString('base64url')}`;
}

export class GhApiClient implements GitHubClient {
  private cooldownUntil = 0;
  private rateLimitFailures = 0;
  private installationToken: { value: string; expiresAt: number } | null = null;
  constructor(private readonly appAuth: GitHubAppAuthOptions | null = null) {}
  rateLimitStatus(): { limited: boolean; cooldownUntil: string | null } {
    const limited = Date.now() < this.cooldownUntil;
    return { limited, cooldownUntil: limited ? new Date(this.cooldownUntil).toISOString() : null };
  }
  private assertAvailable(): void {
    if (Date.now() < this.cooldownUntil) throw new Error(`GitHub API cooldown active until ${new Date(this.cooldownUntil).toISOString()}`);
  }
  private noteFailure(message: string): void {
    if (!/rate limit|secondary rate|HTTP 429/i.test(message)) return;
    this.rateLimitFailures += 1;
    const delay = Math.min(15 * 60_000, 60_000 * (2 ** Math.min(this.rateLimitFailures - 1, 4)));
    this.cooldownUntil = Date.now() + delay;
  }
  private noteSuccess(): void { if (Date.now() >= this.cooldownUntil) this.rateLimitFailures = 0; }
  private appJwt(now = Math.floor(Date.now() / 1000)): string {
    if (!this.appAuth) throw new Error('GitHub App authentication is not configured');
    return createGitHubAppJwt(this.appAuth, now);
  }
  private async appRequest(path: string, method: 'GET' | 'POST' = 'GET'): Promise<Record<string, unknown>> {
    const response = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.appJwt()}`,
        'x-github-api-version': '2026-03-10',
        'user-agent': 'agents-relay',
      },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`GitHub App API ${response.status}: ${text}`);
    return JSON.parse(text) as Record<string, unknown>;
  }
  private async installationAccessToken(): Promise<string> {
    if (!this.appAuth) throw new Error('GitHub App authentication is not configured');
    if (this.installationToken && this.installationToken.expiresAt - Date.now() > 5 * 60_000) return this.installationToken.value;
    const parsed = await this.appRequest(`/app/installations/${this.appAuth.installationId}/access_tokens`, 'POST');
    const token = typeof parsed.token === 'string' ? parsed.token : '';
    const expiresAt = typeof parsed.expires_at === 'string' ? Date.parse(parsed.expires_at) : 0;
    if (!token || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('GitHub App installation token response was invalid');
    this.installationToken = { value: token, expiresAt };
    return token;
  }
  private async commandEnv(): Promise<NodeJS.ProcessEnv> {
    if (!this.appAuth) return process.env;
    const token = await this.installationAccessToken();
    return { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token };
  }
  private async spawnGh(args: string[], input?: string, env: NodeJS.ProcessEnv = process.env, rateLimited = true): Promise<string> {
    if (rateLimited) this.assertAvailable();
    return new Promise<string>((resolve, reject) => {
      const child = spawn('gh', args, { env }); let stdout = ''; let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on('error', reject); if (input !== undefined) child.stdin.write(input); child.stdin.end();
      child.on('close', code => {
        if (code !== 0) { const message = stderr.trim() || `gh exited ${code}`; if (rateLimited) this.noteFailure(message); reject(new Error(message)); return; }
        if (rateLimited) this.noteSuccess(); resolve(stdout);
      });
    });
  }
  async graphql(query: string, variables: Record<string, unknown> = {}): Promise<unknown> {
    this.assertAvailable();
    const payload = JSON.stringify({ query, variables });
    const stdout = await this.spawnGh(['api', 'graphql', '--input', '-'], payload, await this.commandEnv());
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      const message = JSON.stringify(parsed.errors); this.noteFailure(message); throw new Error(message);
    }
    return parsed.data ?? parsed;
  }
  async request(path: string, init: RequestInit = {}): Promise<unknown> {
    this.assertAvailable();
    const args = ['api', path]; const method = String(init.method ?? 'GET');
    if (method !== 'GET') args.push('--method', method); if (init.body) args.push('--input', '-');
    const stdout = await this.spawnGh(args, init.body ? String(init.body) : undefined, await this.commandEnv());
    if (!stdout.trim()) return null;
    try { return JSON.parse(stdout) as unknown; } catch { return stdout; }
  }
  async localLogin(): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      const child = spawn('gh', ['auth', 'status', '--active', '--json', 'hosts']); let stdout = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.on('error', () => resolve(null));
      child.on('close', () => {
        try {
          const value = JSON.parse(stdout) as Record<string, unknown>; const hosts = value.hosts as Record<string, unknown[]> | undefined;
          const github = hosts?.['github.com']; const active = Array.isArray(github) ? github.find(item => (item as Record<string, unknown>).active === true) as Record<string, unknown> | undefined : undefined;
          resolve(typeof active?.login === 'string' && active.login.length > 0 ? active.login : null);
        } catch { resolve(null); }
      });
    });
  }
  async currentLogin(): Promise<string> {
    if (this.appAuth) {
      const app = await this.appRequest('/app');
      if (typeof app.slug === 'string' && app.slug.length > 0) return `${app.slug}[bot]`;
      throw new Error('GitHub App identity lookup returned no slug');
    } else {
      const local = await this.localLogin();
      if (local) return local;
      try {
        const value = await this.graphql('query { viewer { login } }') as Record<string, unknown>;
        const viewer = value.viewer as Record<string, unknown> | undefined;
        if (typeof viewer?.login === 'string' && viewer.login.length > 0) return viewer.login;
      } catch { /* handled below */ }
    }
    const local = await this.localLogin();
    if (local) return local;
    throw new Error('gh authentication did not return a login');
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
      'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){id state merged mergedAt closedAt body}}}',
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
  async headSha(): Promise<string | null> {
    const { owner, name } = this.repoParts();
    const data = await this.graphql('query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid}}}', { owner, name, number: this.prNumber });
    const repository = data.repository as Record<string, unknown> | undefined;
    const pr = repository?.pullRequest as Record<string, unknown> | undefined;
    return typeof pr?.headRefOid === 'string' ? pr.headRefOid : null;
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

export async function listManagedGitHubJobs(client: GitHubClient, repository: string, trustedAuthors: ReadonlySet<string>): Promise<ManagedJobOverview[]> {
  if (!client.graphql) throw new Error('GitHub GraphQL client is required');
  const [owner, name] = repository.split('/', 2);
  if (!owner || !name) throw new Error(`Invalid GitHub repository ${repository}`);
  const output: ManagedJobOverview[] = [];
  const seen = new Set<number>();
  const collect = (nodes: Array<Record<string, unknown>>): void => {
    for (const pr of nodes) {
      const number = Number(pr.number);
      if (!Number.isInteger(number) || number <= 0 || seen.has(number)) continue;
      seen.add(number);
      const comments = pr.comments as Record<string, unknown> | undefined;
      const rows = Array.isArray(comments?.nodes) ? comments.nodes as Array<Record<string, unknown>> : [];
      const trusted = rows.filter(item => {
        const author = item.author as Record<string, unknown> | undefined;
        return typeof author?.login === 'string' && trustedAuthors.has(author.login);
      });
      const bodyJob = parseJob(typeof pr.body === 'string' ? pr.body : '');
      const commentJobs = trusted.map(item => parseJob(String(item.body ?? ''))).filter((item): item is Job => item !== null);
      const jobs = bodyJob ? [bodyJob] : commentJobs;
      const tasks = trusted.map(item => parseTask(String(item.body ?? ''))).filter((item): item is Task => item !== null);
      const state = String(pr.state ?? '').toUpperCase();
      const githubState: PullRequestState = pr.merged === true || state === 'MERGED' ? 'MERGED' : state === 'CLOSED' ? 'CLOSED' : 'OPEN';
      for (const job of jobs) {
        if (!job.description && typeof pr.body === 'string' && pr.body) job.description = pr.body;
        job.prNumber = number; job.repository = repository;
        job.tasks = tasks.filter(task => task.jobId === job.id || (!task.jobId && jobs.length === 1));
        output.push({ job, githubState, draft: pr.isDraft === true, mergedAt: typeof pr.mergedAt === 'string' ? pr.mergedAt : null, closedAt: typeof pr.closedAt === 'string' ? pr.closedAt : null });
      }
    }
  };
  let cursor: string | null = null;
  let firstPage = true;
  do {
    const query = firstPage
      ? 'query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){open:pullRequests(first:50,after:$cursor,states:OPEN,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number body state isDraft merged mergedAt closedAt comments(first:100){nodes{author{login} body}}} pageInfo{hasNextPage endCursor}} recentMerged:pullRequests(first:20,states:MERGED,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number body state isDraft merged mergedAt closedAt comments(first:100){nodes{author{login} body}}}} recentClosed:pullRequests(first:20,states:CLOSED,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number body state isDraft merged mergedAt closedAt comments(first:100){nodes{author{login} body}}}}}}'
      : 'query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){open:pullRequests(first:50,after:$cursor,states:OPEN,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number body state isDraft merged mergedAt closedAt comments(first:100){nodes{author{login} body}}} pageInfo{hasNextPage endCursor}}}}';
    const data = await client.graphql(query, { owner, name, cursor }) as Record<string, unknown>;
    const repo = data.repository as Record<string, unknown> | undefined;
    const open = repo?.open as Record<string, unknown> | undefined;
    collect(Array.isArray(open?.nodes) ? open.nodes as Array<Record<string, unknown>> : []);
    if (firstPage) {
      const recentMerged = repo?.recentMerged as Record<string, unknown> | undefined;
      collect(Array.isArray(recentMerged?.nodes) ? recentMerged.nodes as Array<Record<string, unknown>> : []);
      const recentClosed = repo?.recentClosed as Record<string, unknown> | undefined;
      collect(Array.isArray(recentClosed?.nodes) ? recentClosed.nodes as Array<Record<string, unknown>> : []);
    }
    const pageInfo = open?.pageInfo as Record<string, unknown> | undefined;
    cursor = pageInfo?.hasNextPage === true && typeof pageInfo.endCursor === 'string' ? pageInfo.endCursor : null;
    firstPage = false;
  } while (cursor);
  return output.sort((a, b) => b.job.prNumber - a.job.prNumber);
}

function isTaskForJob(task: Task, jobId: string, soleTrustedJob: boolean): boolean {
  if (task.jobId === jobId) return true;
  return !task.jobId && soleTrustedJob;
}
