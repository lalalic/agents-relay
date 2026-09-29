import type { AgentRegistration, Job, Plan, Task } from './types.js';
import { registerBlockerDependency, resolveBlockerDependencies, type BlockerDependentTarget, type BlockerResolutionSummary } from './blockers.js';
import type { Comment, DurableStore, PullRequestState } from './store.js';
import { sameTaskDefinition } from './store-task-definition.js';
import type { ProjectionOutboxItem, PullRequestFacts, RelayStore } from './relay-store.js';
import type { GitHubPullRequestSeed } from './store.js';

type ProjectedPayload =
  | { operation: 'save_job'; value: Job }
  | { operation: 'append_plan' | 'save_plan'; value: Plan }
  | { operation: 'append_task' | 'save_task'; value: Task }
  | { operation: 'save_agent'; value: AgentRegistration }
  | { operation: 'update_pr_body'; value: string }
  | { operation: 'merge_pull_request'; expectedHeadSha?: string }
  | { operation: 'close_pull_request' };

function taskKey(task: Pick<Task, 'jobId' | 'id'>): string { return `task:${task.jobId ?? ''}:${task.id}`; }
function planKey(plan: Pick<Plan, 'jobId' | 'id'>): string { return `plan:${plan.jobId}:${plan.id}`; }

function retryHeader(error: unknown, name: string): string | null {
  if (!error || typeof error !== 'object') return null;
  const value = error as { headers?: Headers | Record<string, string | number | undefined>; response?: { headers?: Headers | Record<string, string | number | undefined> }; retryAfter?: number | string };
  if (name === 'retry-after' && value.retryAfter !== undefined) return String(value.retryAfter);
  const headers = value.response?.headers ?? value.headers;
  if (!headers) return null;
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name);
  const record = headers as Record<string, string | number | undefined>;
  const hit = Object.entries(record).find(([key]) => key.toLowerCase() === name);
  return hit && hit[1] !== undefined ? String(hit[1]) : null;
}

export function githubProjectionRetryAt(error: unknown, attempt: number, now = new Date()): Date {
  const retryAfter = Number(retryHeader(error, 'retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return new Date(now.getTime() + retryAfter * 1000);
  const reset = Number(retryHeader(error, 'x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > now.getTime() / 1000) return new Date(reset * 1000 + 1000);
  const backoffMs = Math.min(300_000, 1_000 * (2 ** Math.min(8, Math.max(0, attempt))));
  return new Date(now.getTime() + backoffMs);
}

export class GitHubProjectionWriter {
  constructor(private readonly relay: RelayStore, private readonly github: DurableStore) {}

  async flushOnce(limit = 50, now = new Date()): Promise<{ projected: number; deferred: number }> {
    const items = await this.relay.claimDueProjections(limit, now);
    let projected = 0;
    let deferred = 0;
    for (const item of items) {
      try {
        await this.apply(item);
        await this.relay.completeProjection(item.id);
        projected += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.relay.retryProjection(item.id, message, githubProjectionRetryAt(error, item.attempts, now));
        deferred += 1;
      }
    }
    return { projected, deferred };
  }

  private async apply(item: ProjectionOutboxItem): Promise<void> {
    const payload = item.payload as ProjectedPayload;
    switch (payload.operation) {
      case 'save_job': await this.github.saveJob(payload.value); return;
      case 'append_plan': await this.github.appendPlan(payload.value); return;
      case 'save_plan': await this.github.savePlan(payload.value); return;
      case 'append_task': await this.github.appendTask(payload.value); return;
      case 'save_task': await this.github.saveTask(payload.value); return;
      case 'save_agent': await this.github.saveAgent(payload.value); return;
      case 'update_pr_body':
        if (!this.github.updatePullRequestBody) throw new Error('GitHub projection target cannot update PR body');
        await this.github.updatePullRequestBody(payload.value);
        return;
      case 'merge_pull_request':
        if (!this.github.mergePullRequest) throw new Error('GitHub projection target cannot merge pull request');
        await this.github.mergePullRequest(payload.expectedHeadSha);
        return;
      case 'close_pull_request':
        if (!this.github.closePullRequest) throw new Error('GitHub projection target cannot close pull request');
        await this.github.closePullRequest();
        return;
    }
  }
}

export class ProjectedDurableStore implements DurableStore {
  readonly projection: GitHubProjectionWriter;
  private readonly seededFacts: PullRequestFacts | null;

  constructor(
    private readonly relay: RelayStore,
    private readonly github: DurableStore,
    seed: GitHubPullRequestSeed | null = null,
    private readonly relatedStore?: (repository: string, prNumber: number) => DurableStore,
  ) {
    this.projection = new GitHubProjectionWriter(relay, github);
    this.seededFacts = pullRequestFactsFromSeed(seed);
    if (this.seededFacts) void this.relay.savePullRequestFacts(this.seededFacts).catch(() => { /* local seed is best effort; reads retain the seed */ });
  }

  /** Seed local operational truth from a trusted discovery snapshot without creating a projection echo. */
  async hydrate(job: Job): Promise<void> {
    if (!(await this.relay.loadJob(job.id))) await this.relay.saveJob(structuredClone(job));
  }

  async load(jobId: string): Promise<Job> {
    const local = await this.relay.loadJob(jobId);
    if (local) return structuredClone(local);
    const remote = await this.github.load(jobId);
    await this.relay.saveJob(remote);
    return structuredClone(remote);
  }

  async saveJob(job: Job): Promise<void> {
    const value = structuredClone(job);
    await this.relay.saveJobWithProjection(value, {
      idempotencyKey: `save_job:${job.id}`,
      coalesceKey: `job:${job.id}`,
      operation: 'save_job',
      payload: { operation: 'save_job', value } satisfies ProjectedPayload,
      priority: ['COMPLETED', 'CANCELLED'].includes(job.state) ? 100 : 20,
    });
  }

  async appendPlan(plan: Plan): Promise<void> {
    const job = await this.load(plan.jobId);
    const existing = (job.plans ?? []).find(item => item.id === plan.id);
    if (existing) {
      if (JSON.stringify({ ...existing, planUrl: undefined }) === JSON.stringify({ ...plan, planUrl: undefined })) return;
      throw new Error(`Plan ${plan.id} already exists with a different definition`);
    }
    job.plans = [...(job.plans ?? []), structuredClone(plan)].sort((a, b) => a.round - b.round);
    await this.relay.saveJobWithProjection(job, {
      idempotencyKey: `append_plan:${plan.jobId}:${plan.id}`,
      operation: 'append_plan',
      payload: { operation: 'append_plan', value: plan } satisfies ProjectedPayload,
      priority: 30,
    });
  }

  async savePlan(plan: Plan): Promise<void> {
    const job = await this.load(plan.jobId);
    const plans = [...(job.plans ?? [])];
    const index = plans.findIndex(item => item.id === plan.id);
    if (index >= 0) plans[index] = structuredClone(plan); else plans.push(structuredClone(plan));
    job.plans = plans.sort((a, b) => a.round - b.round);
    await this.relay.saveJobWithProjection(job, {
      idempotencyKey: `save_plan:${plan.jobId}:${plan.id}`,
      coalesceKey: planKey(plan),
      operation: 'save_plan',
      payload: { operation: 'save_plan', value: plan } satisfies ProjectedPayload,
      priority: 30,
    });
  }

  async appendTask(task: Task): Promise<void> {
    if (!task.jobId) throw new Error('Projected task requires jobId');
    const job = await this.load(task.jobId);
    const existing = job.tasks.find(item => item.id === task.id);
    if (existing) {
      if (sameTaskDefinition(existing, task)) return;
      throw new Error(`Task ${task.id} already exists with a different definition`);
    }
    job.tasks = [...job.tasks, structuredClone(task)];
    await this.relay.saveJobWithProjection(job, {
      idempotencyKey: `append_task:${task.jobId}:${task.id}`,
      operation: 'append_task',
      payload: { operation: 'append_task', value: task } satisfies ProjectedPayload,
      priority: 40,
    });
  }

  async saveTask(task: Task): Promise<void> {
    if (!task.jobId) throw new Error('Projected task requires jobId');
    const job = await this.load(task.jobId);
    const tasks = [...job.tasks];
    const index = tasks.findIndex(item => item.id === task.id);
    if (index >= 0) tasks[index] = structuredClone(task); else tasks.push(structuredClone(task));
    job.tasks = tasks;
    const value = structuredClone(task);
    const terminal = ['SUCCEEDED', 'FAILED', 'BLOCKED', 'UNBLOCKED', 'CANCELLED'].includes(task.state);
    await this.relay.saveJobWithProjection(job, {
      idempotencyKey: `save_task:${task.jobId}:${task.id}`,
      coalesceKey: taskKey(task),
      operation: 'save_task',
      payload: { operation: 'save_task', value } satisfies ProjectedPayload,
      priority: terminal ? 100 : 50,
    });
  }

  async listAgents(): Promise<AgentRegistration[]> {
    const local = await this.relay.loadAgents();
    if (local !== null) return structuredClone(local);
    const remote = await this.github.listAgents();
    await this.relay.saveAgents(remote);
    return structuredClone(remote);
  }

  async saveAgent(agent: AgentRegistration): Promise<void> {
    if (await this.relay.loadAgents() === null) {
      await this.relay.saveAgents(await this.github.listAgents());
    }
    const value = structuredClone(agent);
    await this.relay.saveAgentWithProjection(value, {
      idempotencyKey: `save_agent:${agent.id}`,
      coalesceKey: `agent:${agent.id}`,
      operation: 'save_agent',
      payload: { operation: 'save_agent', value } satisfies ProjectedPayload,
      priority: 10,
    });
  }

  async comments(): Promise<Comment[]> { return this.github.comments(); }
  async pullRequestState(): Promise<PullRequestState> {
    return (await this.ensurePullRequestFacts()).state;
  }
  async pullRequestHead(): Promise<{ ref: string; sha: string } | null> {
    return (await this.ensurePullRequestFacts()).head;
  }
  async headSha(): Promise<string | null> { return (await this.pullRequestHead())?.sha ?? null; }
  async mergePullRequest(expectedHeadSha?: string): Promise<void> {
    await this.relay.enqueueProjection({
      idempotencyKey: `merge_pull_request:${expectedHeadSha ?? 'current'}`,
      operation: 'merge_pull_request',
      payload: { operation: 'merge_pull_request', expectedHeadSha } satisfies ProjectedPayload,
      priority: 200,
    });
  }
  async closePullRequest(): Promise<void> {
    await this.relay.enqueueProjection({
      idempotencyKey: 'close_pull_request',
      operation: 'close_pull_request',
      payload: { operation: 'close_pull_request' } satisfies ProjectedPayload,
      priority: 200,
    });
  }
  async updatePullRequestBody(body: string): Promise<void> {
    await this.relay.enqueueProjection({
      idempotencyKey: 'update_pr_body',
      coalesceKey: 'pr_body',
      operation: 'update_pr_body',
      payload: { operation: 'update_pr_body', value: body } satisfies ProjectedPayload,
      priority: 80,
    });
  }
  async registerBlockerDependent(jobId: string, dependent: BlockerDependentTarget): Promise<void> {
    if (!this.relatedStore) throw new Error('Projected store requires a related-store factory for blocker dependencies');
    await registerBlockerDependency({
      blockerStore: this,
      blockerJobId: jobId,
      dependentStore: this.relatedStore(dependent.repository, dependent.prNumber),
      dependentJobId: dependent.jobId,
      dependentTaskId: dependent.taskId,
      resolutionMode: dependent.resolutionMode,
    });
  }
  async resolveBlockerDependents(jobId: string, resolution: 'merge' | 'verified'): Promise<BlockerResolutionSummary> {
    if (!this.relatedStore) throw new Error('Projected store requires a related-store factory for blocker dependencies');
    return resolveBlockerDependencies({
      blockerStore: this,
      blockerJobId: jobId,
      resolution,
      dependentStore: (repository, prNumber) => this.relatedStore!(repository, prNumber),
    });
  }

  private async ensurePullRequestFacts(): Promise<PullRequestFacts> {
    const local = await localPullRequestFacts(this.relay, this.seededFacts);
    if (local) return local;
    if (!this.github.pullRequestState || !this.github.pullRequestHead) throw new Error('Pull request facts have not been observed locally');
    const [state, head] = await Promise.all([this.github.pullRequestState(), this.github.pullRequestHead()]);
    const facts: PullRequestFacts = { state, head, observedAt: new Date().toISOString() };
    await this.relay.savePullRequestFacts(facts);
    return facts;
  }
}

function pullRequestFactsFromSeed(seed: GitHubPullRequestSeed | null): PullRequestFacts | null {
  const pr = seed?.prNode;
  if (!pr || Object.keys(pr).length === 0) return null;
  const rawState = typeof pr.state === 'string' ? pr.state.toUpperCase() : '';
  const state: PullRequestState | null = pr.merged === true || rawState === 'MERGED' ? 'MERGED' : rawState === 'CLOSED' ? 'CLOSED' : rawState === 'OPEN' ? 'OPEN' : null;
  if (!state) return null;
  const ref = typeof pr.headRefName === 'string' ? pr.headRefName : '';
  const sha = typeof pr.headRefOid === 'string' ? pr.headRefOid : '';
  return { state, head: ref && sha ? { ref, sha } : null, observedAt: new Date().toISOString() };
}

async function localPullRequestFacts(relay: RelayStore, seededFacts: PullRequestFacts | null): Promise<PullRequestFacts | null> {
  return await relay.loadPullRequestFacts() ?? seededFacts;
}
