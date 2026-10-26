import type { EventRecord } from './types.js';
import type { AgentRegistration, Job, Plan, Task } from './types.js';
import type { AtomicJobMutation, DurableStore, Comment, PullRequestState } from './store.js';
import { GitHubProjectionWriter } from './projected-store.js';
import { registerBlockerDependency, resolveBlockerDependencies, type BlockerDependentTarget, type BlockerResolutionSummary } from './blockers.js';
import type { ExecutionProcessRecord } from './process-identity.js';
import type { PullRequestFacts } from './relay-store.js';
import { samePlanDefinition, sameTaskDefinition, DurableDefinitionConflictError, planDefinitionDivergence, taskDefinitionDivergence } from './store-task-definition.js';
import { mergeInboundJobSnapshot, type RelayStore } from './relay-store.js';
import { publishLocalCommit } from './local-commit-events.js';

/**
 * V2 authoritative lifecycle boundary.
 *
 * Job, Plan, Task and Agent reads/writes are SQLite-only. No GitHub marker,
 * remote snapshot, or projection result can create, recover, or mutate them.
 * Inherited PR merge/close/head interfaces are external collaboration adapters,
 * not lifecycle storage. An explicit one-time import must use RelayStore directly.
 */
const TASK_STATE_ORDER: Record<Task['state'], number> = {
  DRAFT: 0, QUEUED: 1, RUNNING: 2, BLOCKED: 3,
  SUCCEEDED: 5, FAILED: 5, CANCELLED: 5,
};

export class LocalAuthorityDurableStore implements DurableStore {
  readonly projection: GitHubProjectionWriter;
  constructor(
    private readonly authority: RelayStore,
    github: DurableStore,
    private readonly relatedStore?: (repository: string, prNumber: number) => DurableStore,
    readonly noGitHub = false,
  ) {
    this.projection = new GitHubProjectionWriter(authority, github, undefined, true);
  }

  async reserveWorkflowLaunch(identity:{jobId:string;taskId:string;executionId:string;attempt:number;leaseOwner:string}):Promise<boolean>{
    if (!this.authority.reserveWorkflowLaunch)throw Error('authoritative workflow launch ledger unavailable');
    return this.authority.reserveWorkflowLaunch(identity);
  }
  async verifyWorkflowLaunch(jobId:string,taskId:string,executionId:string):Promise<'Verified'|'Failed'|'Unknown'>{
    if (!this.authority.verifyWorkflowLaunch)throw Error('authoritative workflow launch verifier unavailable');
    return this.authority.verifyWorkflowLaunch(jobId,taskId,executionId);
  }
  async commitWorkflowMutationAndEvents(jobId: string, mutation: AtomicJobMutation, events: readonly {key:string;event:EventRecord}[]): Promise<Job> {
    if (!this.authority.commitWorkflowMutationAndEvents) throw new Error('SQLite workflow outbox capability unavailable');
    const committed=await this.authority.commitWorkflowMutationAndEvents(jobId,mutation,events);
    publishLocalCommit(committed);
    return structuredClone(committed);
  }
  async commitWorkflowMutationWithEvents(jobId:string,mutation:(job:Job)=>{next:Job;events:readonly {key:string;event:EventRecord}[]}):Promise<Job>{
    if (!this.authority.commitWorkflowMutationWithEvents)throw Error('SQLite workflow outbox capability unavailable');
    const result=await this.authority.commitWorkflowMutationWithEvents(jobId,mutation);
    publishLocalCommit(result);return structuredClone(result);
  }
  async drainWorkflowEvents(publish: (event: EventRecord)=>Promise<void>): Promise<number> {
    if (!this.authority.drainWorkflowEvents) throw new Error('SQLite workflow outbox capability unavailable');
    return this.authority.drainWorkflowEvents(publish);
  }

  /** Queue one retryable PR merge; do not mutate Job lifecycle until external confirmation. */
  async mergePullRequest(expectedHeadSha?: string): Promise<void> {
    if (this.noGitHub) throw new Error('Remote merge unavailable with --no-github; local Graph completion is separate');
    if (!expectedHeadSha) throw new Error('External merge requires immutable expected head SHA');
    const facts = await this.authority.loadPullRequestFacts();
    if (facts?.state === 'MERGED') return;
    if (facts?.state === 'CLOSED') throw new Error('Cannot merge a PR already known closed');
    if (!this.authority.enqueueExternalActionOnce) throw new Error('Atomic external action queue is required');
    await this.authority.enqueueExternalActionOnce({
      idempotencyKey: `merge_pull_request:${expectedHeadSha}`,
      operation: 'merge_pull_request',
      payload: { operation: 'merge_pull_request', expectedHeadSha },
      priority: 200,
    });
  }

  async closePullRequest(): Promise<void> {
    if (this.noGitHub) return; // Local cancel is persisted by Graph; there is no remote PR.
    const facts = await this.authority.loadPullRequestFacts();
    if (facts?.state === 'MERGED') throw new Error('Cannot close a PR already merged');
    if (facts?.state === 'CLOSED') return;
    if (!this.authority.enqueueExternalActionOnce) throw new Error('Atomic external action queue is required');
    await this.authority.enqueueExternalActionOnce({
      idempotencyKey: 'close_pull_request',
      operation: 'close_pull_request',
      payload: { operation: 'close_pull_request' },
      priority: 200,
    });
  }

  async recordExecutionProcess(record: ExecutionProcessRecord): Promise<void> {
    await this.authority.recordExecutionProcess(record);
  }

  async loadExecutionProcess(jobId: string, taskId: string, executionId: string): Promise<ExecutionProcessRecord | null> {
    return this.authority.loadExecutionProcess(jobId, taskId, executionId);
  }

  async finishExecutionProcess(jobId: string, taskId: string, executionId: string): Promise<void> {
    await this.authority.finishExecutionProcess(jobId, taskId, executionId);
  }

  async applyPullRequestFacts(facts: PullRequestFacts): Promise<void> {
    await this.authority.savePullRequestFacts(structuredClone(facts));
  }

  async headSha(): Promise<string | null> {
    return (await this.pullRequestHead())?.sha ?? null;
  }

  async registerBlockerDependent(jobId: string, dependent: BlockerDependentTarget): Promise<void> {
    if (!this.relatedStore) throw new Error('Related local store factory is required for blocker dependencies');
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
    if (!this.relatedStore) throw new Error('Related local store factory is required for blocker dependencies');
    return resolveBlockerDependencies({
      blockerStore: this,
      blockerJobId: jobId,
      resolution,
      dependentStore: (repository, prNumber) => this.relatedStore!(repository, prNumber),
    });
  }

  async comments(): Promise<Comment[]> { return []; }

  async pullRequestState(): Promise<PullRequestState> {
    return this.noGitHub ? 'UNKNOWN' : (await this.authority.loadPullRequestFacts())?.state ?? 'UNKNOWN';
  }

  async pullRequestHead(): Promise<{ ref: string; sha: string } | null> {
    return this.noGitHub ? null : (await this.authority.loadPullRequestFacts())?.head ?? null;
  }

  async hydrate(_job: Job): Promise<void> {
    // GitHub snapshots cannot overwrite or create authoritative lifecycle state.
  }

  async load(jobId: string): Promise<Job> {
    const job = await this.authority.loadJob(jobId);
    if (!job) throw new Error(`Local authoritative Job ${jobId} not found`);
    return structuredClone(job);
  }

  async saveJob(job: Job): Promise<void> {
    const incoming = structuredClone(job);
    const existing = await this.authority.loadJob(job.id);
    if (!existing) {
      await this.authority.saveJob(incoming);
      Object.assign(job, structuredClone(incoming));
      publishLocalCommit(incoming);
      return;
    }
    if (!this.authority.mutateJob) throw new Error('Atomic SQLite mutation is required for local lifecycle authority');
    const updated = await this.authority.mutateJob(job.id, current => {
      const children = mergeInboundJobSnapshot(current, incoming);
      const preserveTerminal = ['COMPLETED', 'CANCELLED'].includes(current.state)
        && !['COMPLETED', 'CANCELLED'].includes(incoming.state);
      // A stale snapshot must not undo an already committed Graph activation.
      const preserveActivation = current.state === 'ACTIVE' && incoming.state === 'DRAFT';
      const review = current.review && incoming.review
        && current.review.updatedAt > incoming.review.updatedAt
        ? current.review : incoming.review;
      // Job-level scalar fields obey snapshot freshness. Graph transitions
      // may commit review evidence after a preceding effect has already saved
      // the Job; review itself is merged independently by review.updatedAt.
      const scalarSource = incoming.updatedAt > current.updatedAt ? incoming : current;
      return {
        ...current, ...scalarSource,
        state: preserveTerminal || preserveActivation ? current.state : scalarSource.state,
        updatedAt: current.updatedAt > incoming.updatedAt ? current.updatedAt : incoming.updatedAt,
        tasks: children.tasks,
        ...(children.plans ? { plans: children.plans } : {}),
        ...(review !== undefined ? { review } : {}),
      };
    });
    Object.assign(job, structuredClone(updated));
    publishLocalCommit(updated);
  }


  async appendPlan(plan: Plan): Promise<void> {
    await this.mutate(plan.jobId, job => {
    const existing = (job.plans ?? []).find(item => item.id === plan.id);
    if (existing) {
      if (samePlanDefinition(existing, plan)) return job;
      throw new DurableDefinitionConflictError('plan', 'append_plan', plan.jobId, plan.id, plan, existing, planDefinitionDivergence(existing, plan));
    }
    job.plans = [...(job.plans ?? []), structuredClone(plan)].sort((a, b) => a.round - b.round);
    return job;
    });
  }

  async createJobIfAbsent(job: Job): Promise<Job> {
    if (this.authority.createJobIfAbsent) return this.authority.createJobIfAbsent(job);
    const existing = await this.authority.loadJob(job.id);
    if (existing) return existing;
    await this.authority.saveJob(job);
    return structuredClone(job);
  }

  async savePlan(plan: Plan): Promise<void> {
    await this.mutate(plan.jobId, job => {
    const plans = [...(job.plans ?? [])];
    const index = plans.findIndex(item => item.id === plan.id);
    if (index < 0) plans.push(structuredClone(plan));
    else if (plans[index].updatedAt <= plan.updatedAt) plans[index] = structuredClone(plan);
    job.plans = plans.sort((a, b) => a.round - b.round);
    return job;
    });
  }

  async appendTask(task: Task): Promise<void> {
    if (!task.jobId) throw new Error('Local authoritative task requires jobId');
    await this.mutate(task.jobId, job => {
    const existing = job.tasks.find(item => item.id === task.id);
    if (existing) {
      if (sameTaskDefinition(existing, task)) return job;
      throw new DurableDefinitionConflictError('task', 'append_task', task.jobId!, task.id, task, existing, taskDefinitionDivergence(existing, task));
    }
    job.tasks.push(structuredClone(task));
    return job;
    });
  }

  async saveTask(task: Task): Promise<void> {
    if (!task.jobId) throw new Error('Local authoritative task requires jobId');
    await this.mutate(task.jobId, job => {
    const index = job.tasks.findIndex(item => item.id === task.id);
    if (index < 0) throw new Error(`Local authoritative Task ${task.id} not found`);
    const current = job.tasks[index];
    if (current.attempt > task.attempt || current.updatedAt > task.updatedAt) return job;
    if (current.attempt === task.attempt && current.updatedAt === task.updatedAt
        && TASK_STATE_ORDER[current.state] >= TASK_STATE_ORDER[task.state]) return job;
    job.tasks[index] = { ...structuredClone(task), comments: current.comments ?? task.comments };
    return job;
    });
  }

  /**
   * Apply all related lifecycle changes to one freshly loaded Job snapshot.
   * RelayStore owns the SQLite transaction; callers must not call saveJob,
   * savePlan, or saveTask from inside this callback.
   */
  async mutateJob(jobId: string, mutation: AtomicJobMutation): Promise<Job> {
    if (!this.authority.mutateJob) throw new Error('Atomic SQLite mutation is required for local lifecycle authority');
    const changed = await this.authority.mutateJob(jobId, mutation);
    publishLocalCommit(changed);
    return structuredClone(changed);
  }

  private async mutate(jobId: string, mutation: AtomicJobMutation): Promise<void> {
    await this.mutateJob(jobId, mutation);
  }

  async listAgents(): Promise<AgentRegistration[]> {
    return structuredClone(await this.authority.loadAgents() ?? []);
  }

  async saveAgent(agent: AgentRegistration): Promise<void> {
    if (!this.authority.upsertAgent) throw new Error('Atomic SQLite agent upsert is required');
    await this.authority.upsertAgent(structuredClone(agent));
  }
}
