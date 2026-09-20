import { randomUUID } from 'node:crypto';
import { DurableStore } from './store.js';
import { Job, Task, EventRecord, Priority } from './types.js';
import { schedule, transitionTask } from './scheduler.js';
import { Execution, LaunchFailure, WorkerAdapter } from './adapters.js';
import { ContinuationAdapter } from './continuation.js';
import { EventBus, eventFor } from './events.js';
import { ObjectivePlanner, parsePlannerResult, plannerInput, PlannerTaskSpec } from './planner.js';

const PRIORITY_RANK: Record<Priority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
export function compareTaskPriority(a: Task, b: Task, jobPriority: Priority = 'P2'): number { const ar = PRIORITY_RANK[a.priority ?? jobPriority]; const br = PRIORITY_RANK[b.priority ?? jobPriority]; return ar - br || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id); }

export type ReconcileOptions = { owner: string; now?: Date; leaseMs?: number; maxConcurrent?: number; plannerTimeoutMs?: number; adapters: WorkerAdapter[]; planner?: ObjectivePlanner; continuations?: ContinuationAdapter[]; eventBus?: EventBus; emit?: (event: EventRecord) => void | Promise<void> };
type LiveExecution = { taskId: string; execution: Execution; controller: AbortController; timer: NodeJS.Timeout };
type LivePlanner = { executionId: string; controller: AbortController; timer: NodeJS.Timeout };

export function managedWorkerInput(job: Job, task: Task): string {
  if (!['codex', 'chatgpt'].includes(task.adapter) || !job.repository || job.prNumber <= 0) return task.input;
  const prUrl = `https://github.com/${job.repository}/pull/${job.prNumber}`;
  return `[Agents Relay managed task]\nPR: ${prUrl}\nJob: ${job.id}\nTask: ${task.id}\nParent task: ${task.parentTaskId ?? 'none'}\nProject: ${task.projectName ?? 'unspecified'}\n\n${task.input}`;
}

export class Reconciler {
  private readonly live = new Map<string, LiveExecution>();
  private readonly plannerLive = new Map<string, LivePlanner>();
  private readonly continuationLive = new Set<string>();
  private reconciling = false;
  constructor(private readonly store: DurableStore, private readonly options: ReconcileOptions) {}
  async watch(jobId: string): Promise<() => Promise<void>> { if (!this.options.eventBus) return async () => {}; try { return await this.options.eventBus.subscribe(jobId, async event => { if (event.type !== 'job.wake' && event.type !== 'github.webhook') return; await this.reconcile(jobId); }); } catch (error) { await this.reportTransportFailure(error); return async () => {}; } }
  async idle(): Promise<void> { while (this.live.size > 0 || this.plannerLive.size > 0 || this.continuationLive.size > 0 || this.reconciling) await new Promise<void>(resolve => setTimeout(resolve, 25)); }
  async wake(jobId: string): Promise<Job> { return this.reconcile(jobId); }
  async reconcile(jobId: string): Promise<Job> {
    if (this.reconciling) return this.store.load(jobId);
    this.reconciling = true;
    try {
      const job = await this.store.load(jobId);
      const previousState = job.state;
      const prState = await this.store.pullRequestState?.() ?? 'OPEN';
      const now = (this.options.now ?? new Date()).getTime();
      await this.recoverFinishedWorkers(job);
      if (prState !== 'OPEN') {
        const reason = prState === 'MERGED' ? 'Pull request merged' : 'Pull request closed';
        for (const task of job.tasks.filter(item => !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(item.state))) {
          this.live.get(task.id)?.execution.cancel(); this.plannerLive.get(task.id)?.controller.abort();
          transitionTask(task, 'CANCELLED'); task.error = reason; task.leaseOwner = null; task.leaseExpiresAt = null; await this.store.saveTask(task);
        }
      }
      await this.recoverLostExecutions(job, now);
      for (const task of job.tasks) if (task.state === 'CANCELLED') { this.live.get(task.id)?.execution.cancel(); this.plannerLive.get(task.id)?.controller.abort(); }
      let scheduled = schedule(await this.store.load(jobId));
      if (prState === 'OPEN' && scheduled.executionMode === 'autonomous') {
        scheduled = schedule(await this.maybeCreatePlanner(scheduled));
      }
      if (prState === 'MERGED') { scheduled.state = 'COMPLETED'; scheduled.updatedAt = new Date().toISOString(); }
      if (prState === 'CLOSED') { scheduled.state = 'CANCELLED'; scheduled.updatedAt = new Date().toISOString(); }
      if (scheduled.state !== previousState) await this.store.saveJob(scheduled);
      if (prState === 'OPEN') {
        for (const task of scheduled.tasks.filter(item => item.state === 'SUCCEEDED' && (item.continuation || scheduled.continuation) && !item.continuationDeliveredAt)) this.detach(this.deliverContinuation(scheduled, task), scheduled.id, task.id, 'continuation');
        const capacity = Math.max(0, (this.options.maxConcurrent ?? 4) - this.live.size - this.plannerLive.size);
        for (const task of scheduled.tasks.filter(t => t.state === 'READY').sort((a, b) => compareTaskPriority(a, b, scheduled.priority ?? 'P2')).slice(0, capacity)) {
          if (task.kind === 'planner') await this.launchPlanner(scheduled, task);
          else await this.launch(scheduled, task);
        }
      }
      const finalState = schedule(await this.store.load(jobId));
      if (prState === 'MERGED') { finalState.state = 'COMPLETED'; finalState.updatedAt = new Date().toISOString(); }
      if (prState === 'CLOSED') { finalState.state = 'CANCELLED'; finalState.updatedAt = new Date().toISOString(); }
      if (finalState.state !== scheduled.state || finalState.updatedAt !== scheduled.updatedAt) await this.store.saveJob(finalState);
      if (finalState.state === 'COMPLETED' || prState !== 'OPEN') await this.cleanupThreads(finalState);
      return this.store.load(jobId);
    } finally { this.reconciling = false; }
  }
  private async recoverLostExecutions(job: Job, now: number): Promise<void> {
    for (const task of job.tasks.filter(item => item.state === 'RUNNING')) {
      const expired = task.leaseExpiresAt !== null && new Date(task.leaseExpiresAt).getTime() <= now;
      const ownerLost = task.leaseOwner !== null && task.leaseOwner !== this.options.owner;
      if (!expired && !ownerLost) continue;
      this.live.get(task.id)?.execution.cancel();
      const planner = this.plannerLive.get(task.id);
      if (planner) { clearTimeout(planner.timer); planner.controller.abort(); this.plannerLive.delete(task.id); }
      if (task.attempt < task.maxAttempts) {
        transitionTask(task, 'READY'); task.leaseOwner = null; task.leaseExpiresAt = null; await this.store.saveTask(task);
      } else {
        transitionTask(task, 'FAILED'); task.error = expired ? 'Lease expired after maximum attempts' : 'Execution owner restarted after maximum attempts'; task.leaseOwner = null; task.leaseExpiresAt = null; await this.store.saveTask(task);
      }
    }
  }
  private async maybeCreatePlanner(job: Job): Promise<Job> {
    if (job.executionMode !== 'autonomous') return job;
    const planners = job.tasks.filter(task => task.kind === 'planner').sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    if (planners.some(task => ['QUEUED', 'READY', 'RUNNING', 'WAITING'].includes(task.state))) return job;
    if (job.tasks.some(task => task.state === 'FAILED' || task.state === 'BLOCKED')) return job;
    if (job.tasks.some(task => task.kind !== 'planner' && !['SUCCEEDED', 'CANCELLED'].includes(task.state))) return job;
    const latest = planners.at(-1);
    if (latest?.plannerResult?.objective_status === 'satisfied') return job;
    const used = new Set(job.tasks.map(task => task.id));
    let number = planners.length + 1;
    let id = `planner-${number}`;
    while (used.has(id)) { number += 1; id = `planner-${number}`; }
    const now = new Date().toISOString();
    const task: Task = { jobId: job.id, id, kind: 'planner', agentName: 'planner', parentTaskId: latest?.id ?? null, dependencies: [], capabilities: ['planner'], adapter: 'orchestrator', input: plannerInput({ job, tasks: job.tasks, objective: job.objective ?? job.description ?? job.title, previousPlannerTaskId: latest?.id ?? null }), continuation: null, continuationDeliveredAt: null, state: 'QUEUED', attempt: 0, maxAttempts: 3, leaseOwner: null, leaseExpiresAt: null, executionId: null, threadId: null, result: null, plannerResult: null, error: null, timeoutMs: this.options.plannerTimeoutMs ?? 300000, createdAt: now, updatedAt: now };
    await this.store.appendTask(task);
    await this.emit(eventFor(job.id, task.id, task.parentTaskId, 'planner.created', 'queued', `Planner task ${task.id} created`, 'orchestrator'));
    return this.store.load(job.id);
  }
  private async recoverFinishedWorkers(job: Job): Promise<void> {
    for (const task of job.tasks.filter(item => item.state === 'RUNNING' && !this.live.has(item.id) && item.threadId)) {
      const adapter = this.options.adapters.find(candidate => candidate.name === task.adapter);
      if (!adapter?.recover) continue;
      let result: Task['result'] | null = null;
      try { result = await adapter.recover(task); } catch { result = null; }
      if (!result) continue;
      task.result = result; task.error = null; task.leaseOwner = null; task.leaseExpiresAt = null;
      transitionTask(task, 'SUCCEEDED');
      await this.store.saveTask(task);
      await this.emit(eventFor(job.id, task.id, task.parentTaskId, 'task.recovered', 'succeeded', `Recovered completed task ${task.id} from durable worker thread`, 'orchestrator', { threadId: task.threadId }));
    }
  }
  private async launch(job: Job, task: Task): Promise<void> {
    const adapter = this.options.adapters.find(x => x.name === task.adapter);
    if (!adapter) { transitionTask(task, 'FAILED'); task.error = `No adapter ${task.adapter}`; await this.store.saveTask(task); return; }
    const leaseMs = Math.max(this.options.leaseMs ?? 300000, task.timeoutMs); const startedAt = (this.options.now ?? new Date()).getTime();
    transitionTask(task, 'RUNNING'); task.attempt += 1; task.leaseOwner = this.options.owner; task.leaseExpiresAt = new Date(startedAt + leaseMs).toISOString(); task.executionId = randomUUID(); await this.store.saveTask(task);
    await this.emit(eventFor(job.id, task.id, task.parentTaskId, 'task.started', 'running', `Task ${task.id} started`, 'user', { adapter: adapter.id, model: task.routing?.model }));
    const controller = new AbortController(); let execution: Execution;
    const workerTask = { ...task, input: managedWorkerInput(job, task) };
    try { execution = adapter.launch(workerTask, controller.signal); } catch (error) { await this.finish(job.id, task.id, task.executionId, null, error instanceof Error ? error.message : String(error), { retryable: false }); return; }
    // A worker may reject before durable execution metadata finishes saving. Attach a guard immediately so Node never treats that race as an unhandled rejection; the durable completion handler below still records the outcome.
    void execution.promise.catch(() => undefined);
    task.executionId = execution.id; await this.store.saveTask(task);
    let threadPersistence = Promise.resolve();
    const persistThread = (threadId: string): void => {
      threadPersistence = threadPersistence.then(() => this.persistThread(job.id, task.id, execution.id, threadId));
    };
    execution.onThreadStarted = persistThread;
    if (execution.threadId) persistThread(execution.threadId);
    const timer = setTimeout(() => { controller.abort(); execution.cancel(); }, task.timeoutMs);
    this.live.set(task.id, { taskId: task.id, execution, controller, timer });
    this.detach(execution.promise.then(
      async result => { await threadPersistence; await this.finish(job.id, task.id, execution.id, result, null); },
      async error => { await threadPersistence; await this.finish(job.id, task.id, execution.id, null, error instanceof Error ? error.message : String(error), { retryable: !(error instanceof LaunchFailure) }); },
    ), job.id, task.id, 'worker completion');
  }
  private async launchPlanner(job: Job, task: Task): Promise<void> {
    const planner = this.options.planner;
    if (!planner) { task.attempt = task.maxAttempts; task.error = 'No objective planner configured'; transitionTask(task, 'FAILED'); await this.store.saveTask(task); await this.emit(eventFor(job.id, task.id, task.parentTaskId, 'planner.failed', 'failed', `Planner ${task.id}: ${task.error}`, 'user')); return; }
    const startedAt = (this.options.now ?? new Date()).getTime();
    transitionTask(task, 'RUNNING'); task.attempt += 1; task.leaseOwner = this.options.owner; task.leaseExpiresAt = new Date(startedAt + Math.max(this.options.leaseMs ?? 300000, task.timeoutMs)).toISOString(); task.executionId = randomUUID();
    await this.store.saveTask(task);
    await this.emit(eventFor(job.id, task.id, task.parentTaskId, 'planner.started', 'running', `Planner task ${task.id} started`, 'orchestrator'));
    const controller = new AbortController(); const executionId = task.executionId;
    const timer = setTimeout(() => controller.abort(), task.timeoutMs);
    this.plannerLive.set(task.id, { executionId: executionId as string, controller, timer });
    let promise: Promise<import('./planner.js').PlannerResult>;
    try { promise = planner.plan({ job, tasks: job.tasks, objective: job.objective ?? job.description ?? job.title, previousPlannerTaskId: task.parentTaskId }, controller.signal); }
    catch (error) { await this.finishPlanner(job.id, task.id, executionId, error instanceof Error ? error : new Error(String(error))); return; }
    this.detach(promise.then(result => this.finishPlanner(job.id, task.id, executionId, null, result), error => this.finishPlanner(job.id, task.id, executionId, error instanceof Error ? error : new Error(String(error)))), job.id, task.id, 'planner completion');
  }
  private async finishPlanner(jobId: string, taskId: string, executionId: string | null, error: Error | null, raw?: import('./planner.js').PlannerResult): Promise<void> {
    const live = this.plannerLive.get(taskId);
    if (live?.executionId === executionId) { clearTimeout(live.timer); this.plannerLive.delete(taskId); }
    const job = await this.store.load(jobId); const task = job.tasks.find(item => item.id === taskId);
    if (!task || (executionId !== null && task.executionId !== executionId)) return;
    if (task.state === 'CANCELLED') return;
    if (error) {
      task.error = error.message; task.leaseOwner = null; task.leaseExpiresAt = null; transitionTask(task, task.attempt < task.maxAttempts ? 'READY' : 'FAILED'); await this.store.saveTask(task);
      await this.emit(eventFor(job.id, task.id, task.parentTaskId, task.state === 'FAILED' ? 'planner.failed' : 'planner.retry', task.state === 'FAILED' ? 'failed' : 'queued', `Planner ${task.id}: ${error.message}`, 'user')); this.detach(this.reconcile(jobId), jobId, task.id, 'planner retry reconciliation'); return;
    }
    try {
      const result = parsePlannerResult(raw);
      for (const spec of result.next_tasks) {
        const child = this.plannerChild(job, task, spec);
        const existing = job.tasks.find(item => item.id === child.id);
        if (!existing) await this.store.appendTask(child);
        else if (!samePlannerChildDefinition(existing, child)) throw new Error(`Planner task ${child.id} already exists with a different definition`);
      }
      task.plannerResult = result; task.result = { summary: result.assessment, data: { objective_status: result.objective_status, next_tasks: result.next_tasks } }; task.error = null; task.leaseOwner = null; task.leaseExpiresAt = null; transitionTask(task, 'SUCCEEDED'); await this.store.saveTask(task);
      await this.emit(eventFor(job.id, task.id, task.parentTaskId, 'planner.completed', 'succeeded', `Planner ${task.id} completed: ${result.objective_status}`, 'orchestrator', { objective_status: result.objective_status }));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught); task.error = message; task.leaseOwner = null; task.leaseExpiresAt = null; transitionTask(task, task.attempt < task.maxAttempts ? 'READY' : 'FAILED'); await this.store.saveTask(task); await this.emit(eventFor(job.id, task.id, task.parentTaskId, 'planner.failed', 'failed', `Planner ${task.id}: ${message}`, 'user'));
    }
    this.detach(this.reconcile(jobId), jobId, task.id, 'planner follow-up reconciliation');
  }
  private plannerChild(job: Job, planner: Task, spec: PlannerTaskSpec): Task {
    const now = new Date().toISOString();
    return { jobId: job.id, id: spec.id, kind: 'work', priority: spec.priority ?? job.priority, projectName: spec.projectName, agentName: spec.agentName, parentTaskId: planner.id, dependencies: spec.dependencies ?? [], capabilities: spec.capabilities ?? [], adapter: spec.adapter ?? 'shell', input: spec.input, routing: spec.routing, continuation: spec.continuation ?? null, continuationDeliveredAt: null, state: 'QUEUED', attempt: 0, maxAttempts: spec.maxAttempts ?? 3, leaseOwner: null, leaseExpiresAt: null, executionId: null, threadId: null, result: null, plannerResult: null, error: null, timeoutMs: spec.timeoutMs ?? 300000, createdAt: now, updatedAt: now };
  }
  private async persistThread(jobId: string, taskId: string, executionId: string, threadId: string): Promise<void> { const job = await this.store.load(jobId); const task = job.tasks.find(item => item.id === taskId); if (task?.executionId === executionId && task.state === 'RUNNING') { task.threadId = threadId; task.threadDeletedAt = null; task.threadCleanupError = null; await this.store.saveTask(task); await this.emit(eventFor(jobId, taskId, task.parentTaskId, 'thread.started', 'running', `Worker thread ${threadId} started`, 'orchestrator', { threadId })); } }
  private async finish(jobId: string, taskId: string, executionId: string | null, result: Task['result'], error: string | null, options: { retryable?: boolean } = {}): Promise<void> {
    const live = this.live.get(taskId); if (live?.execution.id === executionId) { clearTimeout(live.timer); this.live.delete(taskId); }
    const job = await this.store.load(jobId); const task = job.tasks.find(item => item.id === taskId); if (!task || task.executionId !== executionId) return;
    if (task.state === 'CANCELLED') { await this.store.saveTask(task); return; }
    if (error === null) { task.result = result; task.error = null; task.leaseOwner = null; task.leaseExpiresAt = null; transitionTask(task, 'SUCCEEDED'); await this.store.saveTask(task); await this.emit(eventFor(job.id, task.id, task.parentTaskId, 'task.completed', 'succeeded', `Task ${task.id} completed`)); await this.deliverContinuation(job, task); }
    else { const retryable = options.retryable !== false && task.attempt < task.maxAttempts; task.error = error; task.leaseOwner = null; task.leaseExpiresAt = null; transitionTask(task, retryable ? 'READY' : 'FAILED'); await this.store.saveTask(task); await this.emit(eventFor(job.id, task.id, task.parentTaskId, task.state === 'FAILED' ? 'task.failed' : 'task.retry', task.state === 'FAILED' ? 'failed' : 'queued', `Task ${task.id}: ${error}`, task.state === 'FAILED' ? 'user' : 'orchestrator')); }
    this.detach(this.reconcile(jobId), jobId, task.id, 'worker follow-up reconciliation');
  }
  private async cleanupThreads(job: Job): Promise<void> {
    const adapter = this.options.adapters.find(candidate => candidate.name === 'chatgpt' && candidate.deleteThread);
    if (!adapter?.deleteThread) return;
    for (const task of job.tasks.filter(item => item.adapter === 'chatgpt' && item.threadId && !item.threadDeletedAt)) {
      try {
        await adapter.deleteThread(task.threadId as string, task);
        task.threadDeletedAt = new Date().toISOString(); task.threadCleanupError = null; await this.store.saveTask(task);
        await this.emit(eventFor(job.id, task.id, task.parentTaskId, 'thread.deleted', 'succeeded', `Worker thread ${task.threadId} deleted`, 'orchestrator', { threadId: task.threadId }));
      } catch (error) {
        task.threadCleanupError = error instanceof Error ? error.message : String(error); await this.store.saveTask(task);
        await this.emit(eventFor(job.id, task.id, task.parentTaskId, 'thread.delete.failed', 'failed', `Worker thread cleanup failed: ${task.threadCleanupError}`, 'orchestrator', { threadId: task.threadId }));
      }
    }
  }
  private async deliverContinuation(job: Job, task: Task): Promise<void> {
    const continuation = task.continuation ?? job.continuation;
    if (!continuation || task.continuationDeliveredAt || this.continuationLive.has(task.id)) return;
    const adapter = this.options.continuations?.find(candidate => candidate.kind === continuation.kind);
    if (!adapter) { task.error = `No continuation adapter for ${continuation.kind}`; await this.store.saveTask(task); return; }
    this.continuationLive.add(task.id);
    try { await adapter.continue(task.result?.summary ?? '', continuation); const fresh = await this.store.load(job.id); const durable = fresh.tasks.find(item => item.id === task.id); if (durable?.state === 'SUCCEEDED' && !durable.continuationDeliveredAt) { durable.continuationDeliveredAt = new Date().toISOString(); await this.store.saveTask(durable); } }
    catch (error) { await this.emit(eventFor(job.id, task.id, task.parentTaskId, 'continuation.failed', 'failed', `Continuation failed: ${error instanceof Error ? error.message : String(error)}`, 'user')); }
    finally { this.continuationLive.delete(task.id); }
  }
  private async emit(event: EventRecord): Promise<void> { try { if (this.options.emit) await this.options.emit(event); } catch { /* observability cannot block durable execution */ } try { if (this.options.eventBus) await this.options.eventBus.publish(event); } catch (error) { await this.reportTransportFailure(error); } }
  private detach(promise: Promise<unknown>, jobId: string, taskId: string, context: string): void {
    void promise.catch(error => this.reportDetachedFailure(jobId, taskId, context, error));
  }
  private async reportDetachedFailure(jobId: string, taskId: string, context: string, error: unknown): Promise<void> {
    if (!this.options.emit) return;
    const message = error instanceof Error ? error.message : String(error);
    try { await this.options.emit(eventFor(jobId, taskId, null, 'runtime.persistence.failed', 'failed', `${context} failed: ${message}`, 'orchestrator')); } catch { /* detached failure reporting must never crash the daemon */ }
  }
  private async reportTransportFailure(error: unknown): Promise<void> { if (this.options.emit) { try { await this.options.emit(eventFor('system', 'event-bus', null, 'event.transport.failed', 'failed', `Event transport unavailable: ${error instanceof Error ? error.message : String(error)}`, 'orchestrator')); } catch { /* reporting is best effort */ } } }
}

function samePlannerChildDefinition(left: Task, right: Task): boolean {
  return JSON.stringify({ id: left.id, input: left.input, priority: left.priority, projectName: left.projectName, agentName: left.agentName, dependencies: left.dependencies, capabilities: left.capabilities, adapter: left.adapter, routing: left.routing, continuation: left.continuation ?? null, maxAttempts: left.maxAttempts, timeoutMs: left.timeoutMs }) === JSON.stringify({ id: right.id, input: right.input, priority: right.priority, projectName: right.projectName, agentName: right.agentName, dependencies: right.dependencies, capabilities: right.capabilities, adapter: right.adapter, routing: right.routing, continuation: right.continuation ?? null, maxAttempts: right.maxAttempts, timeoutMs: right.timeoutMs });
}
