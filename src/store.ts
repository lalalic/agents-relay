import { Job, Plan, Task } from './types.js';
import type { BlockerDependentTarget, BlockerResolutionSummary } from './blockers.js';
import { spawn } from 'node:child_process';
import { createSign } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { parseAgent, parseJob, parsePlan, parseTask, renderAgentComment, renderJobBody, renderJobComment, renderPlanComment, renderTaskComment, AGENT_MARKER, JOB_MARKER, PLAN_MARKER, TASK_MARKER } from './markers.js';
import { AgentRegistration } from './types.js';
import { isTaskForJob, sameTaskDefinition } from './store-task-definition.js';
import { PackagePublication, parsePackagePublicationMarker } from './github-webhook.js';
import { GitHubRuntimeRateUsage, GitHubTransportResponse, emptyGitHubRuntimeRateUsage, observeRuntimeRateLimit, parseGitHubCliHeaders, runtimeRejection } from './github-runtime-usage.js';
export type Comment = { id: number; nodeId?: string; url?: string; body: string; updatedAt: string; authorLogin: string | null };
export type PullRequestState = 'OPEN' | 'MERGED' | 'CLOSED';
function publicationFromComments(rows: Array<Record<string, unknown>>, trustedAuthors: ReadonlySet<string>): PackagePublication | null {
  const allowed = rows.filter(item => {
    const author = item.author as Record<string, unknown> | undefined;
    const login = typeof author?.login === 'string' ? author.login : '';
    return trustedAuthors.has(login) || login === 'github-actions[bot]' || login === 'github-actions';
  });
  return allowed.map(item => parsePackagePublicationMarker(String(item.body ?? ''))).filter((item): item is PackagePublication => item !== null).at(-1) ?? null;
}
export type ManagedJobOverview = { job: Job; githubState: PullRequestState; draft: boolean; mergedAt: string | null; closedAt: string | null; publication?: PackagePublication | null };
export type GitHubPullRequestSeed = { prNode: Record<string, unknown>; comments: Comment[] | null };
export type ManagedGitHubPullRequestSnapshot = { overviews: ManagedJobOverview[]; seed: GitHubPullRequestSeed };
export async function loadManagedGitHubPullRequestSnapshotGraphql(client: GitHubClient, repository: string, prNumber: number, trustedAuthors: ReadonlySet<string>): Promise<ManagedGitHubPullRequestSnapshot> {
  const [owner, name] = repository.split('/', 2);
  if (!owner || !name || !Number.isInteger(prNumber) || prNumber <= 0 || !client.graphql) return { overviews: [], seed: { prNode: {}, comments: null } };
  const query = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){id state isDraft merged mergedAt closedAt body headRefName headRefOid comments(last:100){totalCount nodes{id databaseId url updatedAt author{login} body}}}}}';
  const data = await client.graphql(query, { owner, name, number: prNumber }) as Record<string, unknown>;
  const repo = data.repository as Record<string, unknown> | undefined;
  const pr = repo?.pullRequest as Record<string, unknown> | undefined;
  if (!pr) return { overviews: [], seed: { prNode: {}, comments: null } };
  const commentConnection = pr.comments as Record<string, unknown> | undefined;
  const commentRows = (Array.isArray(commentConnection?.nodes) ? commentConnection.nodes : []) as Array<Record<string, unknown>>;
  const totalCount = Number(commentConnection?.totalCount ?? commentRows.length);
  const seedComments: Comment[] | null = Number.isFinite(totalCount) && totalCount <= commentRows.length ? commentRows.map(row => {
    const author = row.author as Record<string, unknown> | undefined;
    return {
      id: Number(row.databaseId ?? 0),
      nodeId: typeof row.id === 'string' ? row.id : undefined,
      url: typeof row.url === 'string' ? row.url : undefined,
      body: String(row.body ?? ''),
      updatedAt: String(row.updatedAt ?? ''),
      authorLogin: typeof author?.login === 'string' ? author.login : null,
    };
  }) : null;
  const trusted = commentRows.filter(item => {
    const author = item.author as Record<string, unknown> | undefined;
    return typeof author?.login === 'string' && trustedAuthors.has(author.login);
  });
  const bodyJob = parseJob(typeof pr.body === 'string' ? pr.body : '');
  const commentJobs = trusted.map(item => parseJob(String(item.body ?? ''))).filter((item): item is Job => item !== null);
  const jobs = bodyJob ? [bodyJob] : commentJobs;
  const publication = publicationFromComments(commentRows, trustedAuthors);
  const plans = trusted.map(row => { const plan = parsePlan(String(row.body ?? '')); if (!plan) return null; const planUrl = typeof row.url === 'string' ? row.url : Number.isInteger(row.databaseId) ? `https://github.com/${repository}/pull/${prNumber}#issuecomment-${row.databaseId}` : undefined; return planUrl ? { ...plan, planUrl } : plan; }).filter((item): item is Plan => item !== null);
  const tasks = trusted.map(row => {
    const task = parseTask(String(row.body ?? ''));
    if (!task) return null;
    const taskUrl = typeof row.url === 'string' ? row.url : Number.isInteger(row.databaseId) ? `https://github.com/${repository}/pull/${prNumber}#issuecomment-${row.databaseId}` : undefined;
    return taskUrl ? { ...task, taskUrl } : task;
  }).filter((item): item is Task => item !== null);
  const state = String(pr.state ?? '').toUpperCase();
  const githubState: PullRequestState = pr.merged === true ? 'MERGED' : state === 'CLOSED' ? 'CLOSED' : 'OPEN';
  const overviews = jobs.map(job => {
    job.plans = plans.filter(plan => plan.jobId === job.id).sort((a,b)=>a.round-b.round);
    job.tasks = tasks.filter(task => task.jobId === job.id || (!task.jobId && jobs.length === 1));
    if (!job.description && typeof pr.body === 'string' && pr.body) job.description = pr.body;
    if (typeof pr.headRefOid === 'string' && pr.headRefOid) job.headSha = pr.headRefOid;
    return { job, githubState, draft: pr.isDraft === true, mergedAt: typeof pr.mergedAt === 'string' ? pr.mergedAt : null, closedAt: typeof pr.closedAt === 'string' ? pr.closedAt : null, publication };
  });
  return { overviews, seed: { prNode: pr, comments: seedComments } };
}
export async function loadManagedGitHubPullRequestGraphql(client: GitHubClient, repository: string, prNumber: number, trustedAuthors: ReadonlySet<string>): Promise<ManagedJobOverview[]> {
  return (await loadManagedGitHubPullRequestSnapshotGraphql(client, repository, prNumber, trustedAuthors)).overviews;
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
export interface DurableStore { load(jobId: string): Promise<Job>; saveJob(job: Job): Promise<void>; appendPlan(plan: Plan): Promise<void>; savePlan(plan: Plan): Promise<void>; appendTask(task: Task): Promise<void>; saveTask(task: Task): Promise<void>; listAgents(): Promise<AgentRegistration[]>; saveAgent(agent: AgentRegistration): Promise<void>; comments(): Promise<Comment[]>; pullRequestState?(): Promise<PullRequestState>; pullRequestHead?(): Promise<{ ref: string; sha: string } | null>; headSha?(): Promise<string | null>; mergePullRequest?(expectedHeadSha?: string): Promise<void>; closePullRequest?(): Promise<void>; updatePullRequestBody?(body: string): Promise<void>; registerBlockerDependent?(jobId: string, dependent: BlockerDependentTarget): Promise<void>; resolveBlockerDependents?(jobId: string, resolution: 'merge' | 'verified'): Promise<BlockerResolutionSummary>; }
export class InMemoryStore implements DurableStore {
  private readonly values = new Map<string, string>();
  constructor(job?: Job) {
    if (job) {
      this.values.set(`${JOB_MARKER}:${job.id}`, renderJobComment(job));
      for (const plan of job.plans ?? []) this.values.set(`${PLAN_MARKER}:${plan.jobId}:${plan.id}`, renderPlanComment(plan));
      for (const task of job.tasks) this.values.set(`${TASK_MARKER}:${task.jobId ?? ''}:${task.id}`, renderTaskComment(task));
    }
  }
  async load(jobId: string): Promise<Job> { const job = await this.findJob(jobId); if (!job) throw new Error(`Job ${jobId} not found`); job.plans = this.plansForJob(jobId); job.tasks = this.tasksForJob(jobId); return job; }
  async saveJob(job: Job): Promise<void> { this.values.set(`${JOB_MARKER}:${job.id}`, renderJobComment(job)); }
  async appendPlan(plan: Plan): Promise<void> { const key = `${PLAN_MARKER}:${plan.jobId}:${plan.id}`; const existing = this.values.get(key); if (existing) { const current = parsePlan(existing); if (current && JSON.stringify(current) === JSON.stringify(plan)) return; throw new Error(`Plan ${plan.id} already exists with a different definition`); } this.values.set(key, renderPlanComment(plan)); }
  async savePlan(plan: Plan): Promise<void> { this.values.set(`${PLAN_MARKER}:${plan.jobId}:${plan.id}`, renderPlanComment(plan)); }
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
  private plansForJob(jobId: string): Plan[] { return [...this.values.values()].map(parsePlan).filter((x): x is Plan => x !== null && x.jobId === jobId).sort((a,b)=>a.round-b.round); }
  private tasksForJob(jobId: string): Task[] {
    const jobs = [...this.values.values()].map(parseJob).filter((x): x is Job => x !== null && typeof x.id === 'string' && x.id.length > 0);
    return [...this.values.values()].map(parseTask).filter((x): x is Task => x !== null).filter(task => isTaskForJob(task, jobId, jobs.length === 1));
  }
}
export type GitHubGraphqlDiagnostics = { operations: Record<string, number>; contexts: Record<string, number> };
export type GitHubClient = { request(path: string, init?: RequestInit): Promise<unknown>; graphql?(query: string, variables?: Record<string, unknown>): Promise<unknown>; withRequestContext?<T>(context: string, work: () => Promise<T>): Promise<T> };
export async function withGitHubRequestContext<T>(client: GitHubClient, context: string, work: () => Promise<T>): Promise<T> { return client.withRequestContext ? client.withRequestContext(context, work) : work(); }
export type GitHubRateLimitBucket = { limit: number; used: number; remaining: number; reset: number };
export type GitHubRateLimitSnapshot = { observedAt: string; resources: { core?: GitHubRateLimitBucket; graphql?: GitHubRateLimitBucket; search?: GitHubRateLimitBucket } };
export { createGitHubAppJwt, GhApiClient } from './github-client.js';
export type { GitHubAppAuthOptions } from './github-client.js';
export type PullRequest = { number: number; title: string; body: string; state: string; head: string; base: string };

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

export { GitHubStore } from './store-github.js';

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
      const publication = publicationFromComments(rows, trustedAuthors);
      const tasks = trusted.map(item => parseTask(String(item.body ?? ''))).filter((item): item is Task => item !== null);
      const state = String(pr.state ?? '').toUpperCase();
      const githubState: PullRequestState = pr.merged === true || state === 'MERGED' ? 'MERGED' : state === 'CLOSED' ? 'CLOSED' : 'OPEN';
      for (const job of jobs) {
        if (!job.description && typeof pr.body === 'string' && pr.body) job.description = pr.body;
        job.prNumber = number; job.repository = repository;
        job.tasks = tasks.filter(task => task.jobId === job.id || (!task.jobId && jobs.length === 1));
        output.push({ job, githubState, draft: pr.isDraft === true, mergedAt: typeof pr.mergedAt === 'string' ? pr.mergedAt : null, closedAt: typeof pr.closedAt === 'string' ? pr.closedAt : null, publication });
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
