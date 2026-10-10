import { classifyWorkerRejection, reroutableWorkerRejections } from './worker-rejection.js';
import { applyTaskRetryAction } from './task-actions.js';
import { DurableStore } from './store.js'; import { Job, Task, EventRecord, ChatGptTabClosePolicy, type WorkerRequirements } from './types.js';
import { transitionJobEvent, transitionTaskEvent } from './scheduler.js';
import { DurableTaskTransitionRuntime } from './workflow/durable-transition.js'; import { Execution, StartAckTimeout, WorkerAdapter } from './adapters.js'; import { ContinuationAdapter } from './continuation.js';
import { EventBus, eventFor } from './events.js'; import { ObjectivePlanner } from './planner.js';
import type { ExecutionContextRoots } from './execution-context.js';
import type { AccountUsageOverview } from './usage.js';
import type { DecisionEngine, DecisionMode } from './decision.js';
import type { DecisionAuditStore } from './decision-audit.js';
import { WorkflowEffectExecutor, type WorkflowEffectOutcome } from './workflow/effects.js';
import { workflowEffectFailureEvent } from './workflow/contracts.js';
import { ReconcileCoordinator } from './reconcile-coordinator.js';
import { acceptedReportedTag, eventDataWithoutTag } from './task-tag.js';
import { rearmTerminalEventDeadline } from './terminal-event-watchdog.js';
import { createWorkerStartAck } from './worker-start-ack.js';
import { monitorExecutionProcess } from './execution-process-tracker.js';
export type ReconcileOptions = { owner: string; noGitHub?: boolean; now?: Date; leaseMs?: number; maxConcurrent?: number; plannerTimeoutMs?: number; startAckTimeoutMs?: number; postExitTerminalGraceMs?: number; adapters: WorkerAdapter[]; planner?: ObjectivePlanner; continuations?: ContinuationAdapter[]; eventBus?: EventBus; emit?: (event: EventRecord) => void | Promise<void>; usageSnapshotProvider?: () => Promise<AccountUsageOverview>; runtimeSummaryProvider?: () => { chatgptRunning: number }; decisionEngine?: DecisionEngine; decisionMode?: DecisionMode; decisionAuditStore?: DecisionAuditStore; reviewer?: { adapter?: 'codex' | 'chatgpt'; workerId?: string; threadId?: string; requirements?: WorkerRequirements; routing?: Task['routing']; maxAttempts?: number; timeoutMs?: number }; chatgptTabClosePolicy?: ChatGptTabClosePolicy; projectPathForJob?: (job: Job) => string | Promise<string>; executionContextRoots?: ExecutionContextRoots };
export type EventHandlingResult = { applied: boolean; reconcile: boolean; reason: string; reconcileMode?: 'await' | 'detached' };
type LiveExecution = { jobId: string; taskId: string; executionId: string; execution: Execution; controller: AbortController; launchBarrier: number; workerStarted: boolean; processSettled: boolean; processError?: string | null };
type LivePlanner = { executionId: string; controller: AbortController; timer: NodeJS.Timeout };
type TerminalWaiter = { executionId: string; launchBarrier: number; resolve: () => void };
export function executionEventSource(jobId: string, taskId: string, executionId: string): string { return `job/${jobId}/task/${taskId}/execution/${executionId}`; }
function eventSourceId(event: EventRecord): string | undefined { return typeof event.source?.id === 'string' ? event.source.id : undefined; }
function executionIdFromSource(sourceId: string | undefined, jobId: string, taskId: string): string | undefined {
  const prefix = `job/${jobId}/task/${taskId}/execution/`;
  return sourceId?.startsWith(prefix) ? sourceId.slice(prefix.length) || undefined : undefined;
}

const terminalExecutionClaims = new Set<string>();
const activeExecutionOwners = new Map<string, ReconcilerRuntimeBase>();
import { withExecutionBoundary } from './execution-boundary.js';
export { withExecutionBoundary } from './execution-boundary.js';
function claimTerminalExecution(sourceId: string): void {
  terminalExecutionClaims.add(sourceId);
  const cleanup = setTimeout(() => terminalExecutionClaims.delete(sourceId), 60000);
  cleanup.unref();
}
function terminalExecutionClaimed(jobId: string, taskId: string, executionId: string): boolean {
  return terminalExecutionClaims.has(executionEventSource(jobId, taskId, executionId));
}

export abstract class ReconcilerRuntimeBase {
  protected readonly live = new Map<string, LiveExecution>();
  protected readonly plannerLive = new Map<string, LivePlanner>();
  protected readonly terminalTimers = new Map<string, NodeJS.Timeout>();
  protected readonly continuationLive = new Set<string>();
  protected readonly launchFailureClaims = new Set<string>();
  protected readonly terminalWaiters = new Map<string, TerminalWaiter>(); private readonly startAckCleanups = new Set<() => Promise<void>>();
  private readonly taskTransitions: DurableTaskTransitionRuntime;
  private readonly eventCoordinator: ReconcileCoordinator;
  private readonly detachedReconciles = new Set<Promise<unknown>>();
  protected readonly workflowEffects = new WorkflowEffectExecutor();
  protected reconciling = false;
  constructor(protected readonly store: DurableStore, protected readonly options: ReconcileOptions) {
    this.taskTransitions = new DurableTaskTransitionRuntime(store);
    this.eventCoordinator = new ReconcileCoordinator(async (jobId, signals) => {
      let shouldReconcile = false;
      let detached = false;
      let taskId = 'job';
      const reasons: string[] = [];
      for (const signal of signals) {
        reasons.push(signal.reason);
        if (!signal.event) { shouldReconcile = true; continue; }
        taskId = signal.event.task_id || taskId;
        const result = await this.applyEvent(signal.event);
        shouldReconcile ||= result.reconcile;
        detached ||= result.reconcile && result.reconcileMode === 'detached';
      }
      if (!shouldReconcile) return;
      const reconciliation = this.reconcile(jobId);
      if (detached) {
        let tracked!: Promise<unknown>;
        tracked = reconciliation.finally(() => this.detachedReconciles.delete(tracked));
        this.detachedReconciles.add(tracked);
        this.detach(tracked, jobId, taskId, `coordinator reconciliation: ${[...new Set(reasons)].join('+')}`);
      } else {
        await reconciliation;
      }
    });
  }
  abstract reconcile(jobId: string): Promise<Job>;
  protected abstract applyReviewEvent(event: EventRecord): Promise<EventHandlingResult>;
  protected async applyJobEffectOutcomes(job: Job, outcomes: readonly WorkflowEffectOutcome[]): Promise<void> {
    for (const outcome of outcomes.filter(item => item.status === 'failed')) {
      const eventName = workflowEffectFailureEvent(outcome.effect);
      try {
        await transitionJobEvent(job, eventName);
        await this.store.saveJob(job);
      } catch {
        // Some effects are observational for a given state; failure is still emitted below.
      }
      await this.emit(eventFor(
        job.id,
        'job',
        null,
        'workflow.effect.failed',
        'failed',
        `${outcome.effect} failed: ${outcome.error ?? 'unknown error'}`,
        'orchestrator',
        { effect: outcome.effect, idempotencyKey: outcome.key, workflowEvent: eventName },
        { agent: 'relay', component: 'agents-relay' },
      ));
    }
  }
  protected async applyTaskEffectOutcomes(job: Job, task: Task, outcomes: readonly WorkflowEffectOutcome[]): Promise<void> {
    for (const outcome of outcomes.filter(item => item.status === 'failed')) {
      const eventName = workflowEffectFailureEvent(outcome.effect);
      try {
        await transitionTaskEvent(task, eventName);
        task.error = outcome.error ?? `${outcome.effect} failed`;
        await this.store.saveTask(task);
      } catch {
        // The effect failure remains observable even if this state has no feedback transition.
      }
      await this.emit(eventFor(
        job.id,
        task.id,
        task.parentTaskId,
        'workflow.effect.failed',
        'failed',
        `${outcome.effect} failed: ${outcome.error ?? 'unknown error'}`,
        'orchestrator',
        { effect: outcome.effect, idempotencyKey: outcome.key, workflowEvent: eventName },
        { agent: 'relay', component: 'agents-relay' },
      ));
    }
  }
  async applyEvent(event: EventRecord): Promise<EventHandlingResult> {
    const sourceId = eventSourceId(event);
    const activeOwner = sourceId ? activeExecutionOwners.get(sourceId) : undefined;
    if (activeOwner && activeOwner !== this) return activeOwner.applyEvent(event);
    if (event.type === 'task.started') return this.markWorkerStarted(event);
    if (['task.completed', 'task.failed', 'task.blocked', 'task.cancelled'].includes(event.type)) {
      const result = await this.applyTerminalEvent(event);
      if (event.type !== 'task.failed' || event.source?.watchdog !== true || event.data?.workflowEvent !== 'watchdog.failed' || result.reconcile) return result;
      // The watchdog has already committed FAILED. The graph owns the recovery
      // action; this correlated event wakes the graph evaluation, not a retry.
      const durable = (await this.store.load(event.job_id)).tasks.find(task => task.id === event.task_id);
      return durable?.state === 'FAILED' && durable.executionHistory?.some(history => history.id === event.data?.executionId)
        ? { applied: true, reconcile: true, reason: 'watchdog.failure-fact' } : result;
    }
    if (['review.started', 'review.approved', 'review.changes_required', 'review.blocked'].includes(event.type)) return this.applyReviewEvent(event);
    if (event.type === 'github.webhook') return { applied: true, reconcile: false, reason: 'github.audit_only' };
    if (event.type === 'job.wake') return { applied: true, reconcile: true, reason: event.type };
    return { applied: false, reconcile: false, reason: event.type };
  }
  async handleEvent(event: EventRecord): Promise<void> {
    await this.eventCoordinator.accept({ jobId: event.job_id, reason: `event.${event.type}`, event });
  }
  async watch(jobId: string): Promise<() => Promise<void>> {
    if (!this.options.eventBus) return async () => {};
    try {
      return await this.options.eventBus.subscribe(jobId, event => this.eventCoordinator.acceptObserved({ jobId: event.job_id, reason: `event.${event.type}`, event }));
    } catch (error) {
      await this.reportTransportFailure(error);
      return async () => {};
    }
  }
  async idle(): Promise<void> { while ([...this.live.values()].some(item => !item.processSettled) || this.plannerLive.size > 0 || this.continuationLive.size > 0 || this.reconciling || !this.eventCoordinator.isIdle()) await new Promise<void>(resolve => setTimeout(resolve, 25)); }
  async close(): Promise<void> {
    await this.eventCoordinator.settle();
    if (this.detachedReconciles.size > 0) await Promise.allSettled([...this.detachedReconciles]);
    await Promise.allSettled([...this.startAckCleanups].map(stop => stop()));
    for (const live of this.live.values()) {
      const sourceId = executionEventSource(live.jobId, live.taskId, live.executionId);
      if (activeExecutionOwners.get(sourceId) === this) activeExecutionOwners.delete(sourceId);
      live.controller.abort();
      live.execution.cancel();
    }
    this.live.clear();
    for (const timer of this.terminalTimers.values()) clearTimeout(timer);
    this.terminalTimers.clear();
    for (const planner of this.plannerLive.values()) {
      clearTimeout(planner.timer);
      planner.controller.abort();
    }
    this.plannerLive.clear();
    for (const waiter of this.terminalWaiters.values()) waiter.resolve();
    this.terminalWaiters.clear();
  }
  async wake(jobId: string): Promise<Job> { return this.reconcile(jobId); }
  protected async startAck(jobId: string, taskId: string, sourceId: string, launchBarrier: number, timeoutMs = this.options.startAckTimeoutMs ?? 60000): Promise<{ ack: Promise<void>; stop: () => Promise<void> }> {
    if (!this.options.eventBus) throw new Error('Worker start acknowledgement requires an event bus');
    return createWorkerStartAck(this.options.eventBus, jobId, taskId, sourceId, timeoutMs, this.startAckCleanups);
  }
  protected registerExecutionOwner(jobId: string, taskId: string, executionId: string): void {
    activeExecutionOwners.set(executionEventSource(jobId, taskId, executionId), this);
    const live = this.live.get(taskId);
    if (live) this.detach(monitorExecutionProcess(this.store, jobId, taskId, executionId, this.options.owner, live.execution), jobId, taskId, 'execution PID correlation');
  }
  protected cancelExecutionGeneration(jobId: string, taskId: string, executionId: string | null | undefined): boolean {
    if (!executionId) return false;
    const sourceId = executionEventSource(jobId, taskId, executionId);
    const owner = activeExecutionOwners.get(sourceId);
    const live = owner?.live.get(taskId);
    if (!owner || !live || live.executionId !== executionId) return false;
    live.controller.abort();
    live.execution.cancel();
    owner.clearExecution(taskId, executionId);
    return true;
  }

  protected clearTerminalTimer(taskId: string, executionId: string): void {
    const live = this.live.get(taskId);
    if (!live || live.executionId !== executionId) return;
    const timer = this.terminalTimers.get(taskId);
    if (timer) clearTimeout(timer);
    this.terminalTimers.delete(taskId);
  }

  protected clearExecution(taskId: string, executionId?: string | null): void {
    const live = this.live.get(taskId);
    if (!executionId || live?.executionId === executionId) {
      if (live) {
        const sourceId = executionEventSource(live.jobId, live.taskId, live.executionId);
        if (activeExecutionOwners.get(sourceId) === this) activeExecutionOwners.delete(sourceId);
      }
      this.live.delete(taskId);
    }
    const timer = this.terminalTimers.get(taskId);
    if (timer) clearTimeout(timer);
    this.terminalTimers.delete(taskId);
  }
  protected async markWorkerStarted(event: EventRecord): Promise<EventHandlingResult> {
    const live = this.live.get(event.task_id);
    // Event timestamps are worker-authored and may be wrong; exact execution identity is authoritative.
    const transition = await this.taskTransitions.apply(event.job_id, event.task_id, 'task.started', {
      eligible: (job, task) => {
        if (!task.executionId || eventSourceId(event) !== executionEventSource(job.id, task.id, task.executionId)) return false;
        const claimedExecution = task.executionId !== null && task.leaseOwner !== null;
        const exactLiveExecution = live && event.job_id === live.jobId && task.executionId === live.executionId;
        return Boolean(exactLiveExecution || claimedExecution || this.isRecoverableWatchdogFailure(task));
      },
      facts: (_job, task) => ({
        recoverableExecution: this.isRecoverableWatchdogFailure(task)
          && Boolean(task.executionId && eventSourceId(event) === executionEventSource(event.job_id, task.id, task.executionId)),
      }),
      mutate: (_job, task) => {
        task.updatedAt = new Date().toISOString();
      },
    });
    if (!transition?.decision.accepted) return { applied: false, reconcile: false, reason: 'task.started.ignored' };
    if (live?.executionId === transition.task.executionId) live.workerStarted = true;
    return { applied: true, reconcile: transition.from === 'FAILED', reason: transition.from === 'FAILED' ? 'task.started.recovery' : 'task.started', reconcileMode: transition.from === 'FAILED' ? 'detached' : undefined };
  }

  protected isRecoverableWatchdogFailure(task: Task): boolean {
    if (['worker_start_timeout', 'terminal_event_timeout', 'worker_exit_before_start', 'worker_exit_without_terminal_event', 'worker_delivery_after_start'].includes(task.failureReason ?? '')) return true;
    const error = task.error ?? '';
    return error.includes('worker_start_timeout')
      || error.includes('timed out waiting for the mandatory terminal worker event')
      || error.includes('exited before publishing task.started')
      || error.includes('exited after task.started without publishing a terminal task event')
      || error.includes('Worker delivery failed after task.started');
  }

  protected isCorrelatedWorkerEvent(task: Task, event: EventRecord): boolean {
    return task.executionId !== null && eventSourceId(event) === executionEventSource(event.job_id, task.id, task.executionId);
  }
  protected finalizeReviewExecution(jobId: string, task: Task, event: EventRecord): boolean {
    if (!task.executionId) return true;
    const sourceId = eventSourceId(event);
    const expected = executionEventSource(jobId, task.id, task.executionId);
    if ((task.adapter === 'codex' || task.adapter === 'chatgpt') && sourceId !== expected) return false;
    claimTerminalExecution(expected);
    const executionId = task.executionId;
    this.clearExecution(task.id, executionId);
    task.leaseOwner = null;
    task.leaseExpiresAt = null;
    task.executionId = null;
    task.updatedAt = new Date().toISOString();
    this.terminalWaiters.get(task.id)?.resolve();
    this.terminalWaiters.delete(task.id);
    return true;
  }

  protected async failLaunch(jobId: string, taskId: string, executionId: string | null, message: string, phase: 'launch' | 'delivery' | 'start-ack' = 'launch'): Promise<void> {
    const claim = executionId ?? `${jobId}:${taskId}`;
    if (this.launchFailureClaims.has(claim)) return;
    this.launchFailureClaims.add(claim);
    const cleanup = setTimeout(() => this.launchFailureClaims.delete(claim), 60000);
    cleanup.unref();
    const workflowEvent = phase === 'start-ack' ? 'worker.start_ack_failed' : 'worker.delivery_failed';
    const transition = await this.taskTransitions.apply(jobId, taskId, workflowEvent, {
      eligible: (_job, task) => task.executionId === executionId,
      mutate: (_job, task) => {
        this.clearExecution(task.id, executionId);
        task.error = `Worker ${phase} failed: ${message}`;
        task.failureReason = phase === 'start-ack' ? 'worker_start_timeout' : undefined;
        task.leaseOwner = null;
        task.leaseExpiresAt = null;
      },
    });
    if (!transition) return;
    if (!transition.decision.accepted) {
      await this.emit(eventFor(
        jobId,
        taskId,
        transition.task.parentTaskId,
        'task.process.delivery_failed',
        'failed',
        `Worker ${phase} reported after lifecycle moved to ${transition.from}: ${message}`,
        'orchestrator',
        { phase, authoritative: false, executionId, workflowEvent },
        { agent: 'relay', component: 'agents-relay' },
      ));
      return;
    }
    const event = eventFor(
      jobId,
      taskId,
      transition.task.parentTaskId,
      'task.failed',
      'failed',
      transition.task.error ?? `Worker ${phase} failed: ${message}`,
      'user',
      { phase, reason: transition.task.failureReason, workflowEvent },
      { agent: 'relay', component: 'agents-relay', watchdog: true },
    );
    this.detach(this.emit(event), jobId, taskId, 'worker failure event');
    // failLaunch already committed the authoritative FAILED state. The emitted
    // task.failed observation may be ignored as a duplicate, so explicitly wake
    // graph reconciliation from the durable failure fact. This is required for
    // automatic Troubleshooter recovery, including reviewer start-ack failures.
    this.detach(this.eventCoordinator.accept({ jobId, reason: `worker-${phase}-failure` }), jobId, taskId, 'worker failure reconcile wake');
  }

  protected async runtimeSettled(jobId: string, taskId: string, executionId: string, result: Task['result'], error: string | null): Promise<void> {
    const live = this.live.get(taskId);
    if (live?.executionId === executionId) { live.processSettled = true; live.processError = error; }
    const job = await this.store.load(jobId);
    const task = job.tasks.find(item => item.id === taskId);
    // Async transport settlement is an independent, non-authoritative observation.
    // A worker terminal event may already have claimed the Task; do not suppress
    // transport-exit evidence merely because business completion won the race.
    if (!task) return;
    const correlated = task.executionId === executionId || task.executionHistory?.some(item => item.id === executionId);
    if (!correlated) return;
    if (task.adapter !== 'chatgpt' && (task.executionId !== executionId || terminalExecutionClaimed(jobId, taskId, executionId))) return;
    if (task.adapter !== 'chatgpt' && task.executionId === executionId && live?.executionId === executionId)
      rearmTerminalEventDeadline(this.terminalTimers, taskId, task.timeoutMs - (Date.now() - live.launchBarrier),
        this.options.postExitTerminalGraceMs ?? 15_000, () => this.detach(this.timeoutTask(jobId, taskId, executionId), jobId, taskId, 'post-exit terminal event timeout'));
    await this.emit(eventFor(
      jobId, taskId, task.parentTaskId,
      task.adapter === 'chatgpt' ? 'task.process.async_exited' : 'task.process.exited',
      live?.execution.processExit ? (live.execution.processExit.exitCode === 0 ? 'succeeded' : 'failed') : (error ? 'failed' : 'succeeded'),
      result?.summary ?? (live?.execution.processExit?.terminationReason === 'parent-shutdown' ? 'Worker interrupted by daemon shutdown' : error ? `Worker exited: ${error}${live?.execution.processExit ? ` (exit=${live.execution.processExit.exitCode ?? 'null'}${live.execution.processExit.signal ? ` signal=${live.execution.processExit.signal}` : ''})` : ''}` : 'Worker runtime exited'), 'orchestrator',
      { authoritative: false, waitingForTerminalEvent: true, exitCode: live?.execution.processExit?.exitCode ?? null,
        signal: live?.execution.processExit?.signal ?? null, terminationReason: live?.execution.processExit?.terminationReason ?? null, stderr: live?.execution.processExit?.stderr ?? '', processError: error, executionId, pid: live?.execution.pid ?? null },
      { id: executionEventSource(jobId, taskId, executionId), agent: 'relay', component: 'agents-relay' },
    ));
  }
  protected async timeoutTask(jobId: string, taskId: string, executionId: string): Promise<void> {
    const live = this.live.get(taskId);
    if (live?.executionId === executionId) {
      live.controller.abort();
      live.execution.cancel();
    }
    const exit = live?.executionId === executionId && live.processSettled ? live.execution.processExit : undefined;
    const rawError = live?.executionId === executionId && live.processSettled ? (live.processError || exit?.stderr || '').trim() : '';
    const failedExit = Boolean(exit && (exit.exitCode !== 0 || exit.signal));
    const failureReason = failedExit ? classifyWorkerRejection(rawError) : 'terminal_event_timeout';
    const failureMessage = failedExit ? (rawError || `Worker exited with code ${exit?.exitCode ?? 'null'}${exit?.signal ? `, signal ${exit.signal}` : ''}`) : `Task ${taskId} timed out waiting for the mandatory terminal worker event`;
    const transition = await this.taskTransitions.apply(jobId, taskId, 'watchdog.failed', {
      eligible: (_job, task) => task.executionId === executionId,
      mutate: (_job, task) => {
        this.clearExecution(task.id, executionId);
        task.error = failureMessage;
        task.failureReason = failureReason;
        task.leaseOwner = null;
        task.leaseExpiresAt = null;
      },
    });
    if (!transition?.decision.accepted) {
      this.clearExecution(taskId, executionId);
      return;
    }
    let reroutedTask: Task | null = null;
    // Provider quota failures are recoverable. Commit the retry + route exclusion
    // before publishing task.failed so event-driven reconciliation can never see
    // an intermediate FAILED state and spawn a Troubleshooter for quota exhaustion.
    if (reroutableWorkerRejections.has(failureReason) && transition.task.attempt < transition.task.maxAttempts) {
      const current = (await this.store.load(jobId)).tasks.find(task => task.id === taskId);
      if (current?.state === 'FAILED' && current.failureReason === failureReason && current.attempt === transition.task.attempt) {
        const failedRoute = current.routing;
        await applyTaskRetryAction(current);
        if (failedRoute) {
          const duplicate = current.routingExclusions?.some(item => item.provider === failedRoute.provider && item.model === failedRoute.model && item.profile === failedRoute.profile);
          if (!duplicate) current.routingExclusions = [...(current.routingExclusions ?? []), {
            provider: failedRoute.provider,
            model: failedRoute.model,
            ...(failedRoute.profile ? { profile: failedRoute.profile } : {}),
            reason: 'rate_limit_exceeded',
            at: new Date().toISOString(),
          }];
        }
        current.routing = undefined;
        current.workerSelection = undefined;
        await this.store.saveTask(current);
        reroutedTask = current;
      }
    }
    const event = eventFor(
      jobId,
      taskId,
      transition.task.parentTaskId,
      'task.failed',
      'failed',
      transition.task.error ?? failureMessage,
      'user',
      { reason: failureReason, exitCode: exit?.exitCode ?? null, signal: exit?.signal ?? null, timeoutMs: transition.task.timeoutMs, workflowEvent: 'watchdog.failed', executionId },
      { agent: 'relay', component: 'agents-relay', watchdog: true },
    );
    await this.emit(event);
    if (reroutedTask) {
      await this.emit(eventFor(jobId, taskId, reroutedTask.parentTaskId,
        'task.rerouting', 'queued', `Worker rejection ${failureReason}; retrying with fresh routing and usage data`,
        'orchestrator', { previousFailure: failureReason, attempt: reroutedTask.attempt, maxAttempts: reroutedTask.maxAttempts }));
      await this.eventCoordinator.accept({ jobId, reason: 'worker-rejection-reroute' });
    }
  }
  protected async applyTerminalEvent(event: EventRecord, trustedInternal = false): Promise<EventHandlingResult> {
    const liveAtTerminal = this.live.get(event.task_id); const terminalEventExecutionId = executionIdFromSource(eventSourceId(event), event.job_id, event.task_id);
    const transition = await withExecutionBoundary(event.job_id, event.task_id, () => this.taskTransitions.apply(event.job_id, event.task_id, event.type, {
      eligible: (_job, task) => {
        if (!['codex', 'chatgpt', 'orchestrator'].includes(task.adapter)) return false;
        // Reviewer business terminal state is owned by review.approved / review.changes_required / review.blocked.
        // A generic task.completed may arrive before the review decision and must not consume the execution generation.
        if (task.agentName === 'reviewer' && event.type === 'task.completed') return false;
        const modelBacked = task.adapter === 'codex' || task.adapter === 'chatgpt';
        if (!trustedInternal && modelBacked && !this.isCorrelatedWorkerEvent(task, event)) {
          const eventExecutionId = executionIdFromSource(eventSourceId(event), _job.id, task.id);
          const prior = eventExecutionId ? task.executionHistory?.find(item => item.id === eventExecutionId) : undefined;
          // A duplicate launch can leave one worker orphaned after another worker
          // has already produced the terminal fact. Accept only a known execution
          // from the same durable attempt. A prior retry attempt cannot complete a newer generation.
          if (!prior || prior.attempt !== task.attempt) return false;
        }
        const terminalWaiter = this.terminalWaiters.get(task.id);
        return !terminalWaiter || Boolean(task.executionId && terminalWaiter.executionId === task.executionId && this.isCorrelatedWorkerEvent(task, event));
      },
      facts: (_job, task) => {
        const processExitedAfterPublishedTerminal = task.failureReason === 'worker_exit_without_terminal_event';
        const freshEnough = processExitedAfterPublishedTerminal || this.isCorrelatedWorkerEvent(task, event);
        return { recoverableExecution: this.isRecoverableWatchdogFailure(task) && freshEnough };
      },
      mutate: (job, task) => {
        const modelBacked = task.adapter === 'codex' || task.adapter === 'chatgpt';
        const acceptedExecutionId = task.executionId;
        const eventExecutionId = executionIdFromSource(eventSourceId(event), job.id, task.id);
        const terminalExecutionId = eventExecutionId ?? acceptedExecutionId;
        if (modelBacked && terminalExecutionId) claimTerminalExecution(executionEventSource(job.id, task.id, terminalExecutionId));
        if (eventExecutionId && acceptedExecutionId && eventExecutionId !== acceptedExecutionId) {
          this.cancelExecutionGeneration(job.id, task.id, eventExecutionId);
        }
        this.clearExecution(task.id, acceptedExecutionId);
        task.leaseOwner = null;
        task.leaseExpiresAt = null;
        task.executionId = null;
        task.updatedAt = new Date().toISOString();
        this.terminalWaiters.get(task.id)?.resolve();
        this.terminalWaiters.delete(task.id);
        const reportedTag = acceptedReportedTag(job, event.data);
        if (reportedTag) task.tag = reportedTag;
        if (event.type === 'task.completed') {
          task.result = { summary: event.message || `Task ${task.id} completed`, data: eventDataWithoutTag(event.data) };
          task.error = null;
          task.failureReason = undefined;
        } else if (event.type === 'task.failed') {
          task.error = event.message || `Task ${task.id} failed`;
          task.failureReason = typeof event.data?.reason === 'string' ? event.data.reason : undefined;
        } else if (event.type === 'task.blocked') {
          task.error = event.message || `Task ${task.id} blocked`;
          const data = event.data ?? {};
          const head = ['candidate_head', 'candidate_head_sha', 'pr_head', 'head_sha']
            .map(key => data[key])
            .find(value => typeof value === 'string' && value.length > 0);
          task.blockedBaseline = {
            blockedAt: event.timestamp || task.updatedAt,
            headSha: typeof head === 'string' ? head : job.headSha,
            reason: task.error,
          };
          task.unblock = undefined;
        } else if (event.type === 'task.cancelled') {
          task.error = event.message || `Task ${task.id} cancelled`;
        }
      },
    }));
    if (!transition?.decision.accepted) return { applied: false, reconcile: false, reason: `${event.type}.ignored` };
    if (transition.task.adapter === 'codex' && liveAtTerminal && !liveAtTerminal.processSettled && liveAtTerminal.jobId === event.job_id && (!terminalEventExecutionId || liveAtTerminal.executionId === terminalEventExecutionId)) { liveAtTerminal.controller.abort(); liveAtTerminal.execution.cancel(); }
    if (event.type === 'task.completed') await this.deliverContinuation(transition.job, transition.task);
    const reviewWorker = transition.task.agentName === 'reviewer';
    return { applied: true, reconcile: !reviewWorker, reason: reviewWorker ? `${event.type}.review-worker` : event.type, reconcileMode: reviewWorker ? undefined : 'detached' };
  }
  protected terminalWait(taskId: string, executionId: string, launchBarrier: number): { promise: Promise<void>; cancel: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>(resolver => { resolve = resolver; });
    this.terminalWaiters.set(taskId, { executionId, launchBarrier, resolve });
    return {
      promise,
      cancel: () => {
        const current = this.terminalWaiters.get(taskId);
        if (current?.executionId === executionId) this.terminalWaiters.delete(taskId);
      },
    };
  }
  protected async deliverContinuation(job: Job, task: Task): Promise<void> {
    const continuation = task.continuation ?? job.continuation;
    if (!continuation || task.continuationDeliveredAt || this.continuationLive.has(task.id)) return;
    const adapter = this.options.continuations?.find(candidate => candidate.kind === continuation.kind);
    if (!adapter) { task.error = `No continuation adapter for ${continuation.kind}`; await this.store.saveTask(task); return; }
    this.continuationLive.add(task.id);
    try { await adapter.continue(task.result?.summary ?? '', continuation); const fresh = await this.store.load(job.id); const durable = fresh.tasks.find(item => item.id === task.id); if (durable?.state === 'SUCCEEDED' && !durable.continuationDeliveredAt) { durable.continuationDeliveredAt = new Date().toISOString(); await this.store.saveTask(durable); } }
    catch (error) { await this.emit(eventFor(job.id, task.id, task.parentTaskId, 'continuation.failed', 'failed', `Continuation failed: ${error instanceof Error ? error.message : String(error)}`, 'user')); }
    finally { this.continuationLive.delete(task.id); }
  }
  protected async emit(event: EventRecord): Promise<void> { try { if (this.options.emit) await this.options.emit(event); } catch { /* observability cannot block durable execution */ } try { if (this.options.eventBus) await this.options.eventBus.publish(event); } catch (error) { await this.reportTransportFailure(error); } }
  protected detach(promise: Promise<unknown>, jobId: string, taskId: string, context: string): void {
    void promise.catch(error => this.reportDetachedFailure(jobId, taskId, context, error));
  }
  protected async reportDetachedFailure(jobId: string, taskId: string, context: string, error: unknown): Promise<void> {
    if (!this.options.emit) return;
    const message = error instanceof Error ? error.message : String(error);
    try { await this.options.emit(eventFor(jobId, taskId, null, 'runtime.persistence.failed', 'failed', `${context} failed: ${message}`, 'orchestrator')); } catch { /* detached failure reporting must never crash the daemon */ }
  }
  protected async reportTransportFailure(error: unknown): Promise<void> { if (this.options.emit) { try { await this.options.emit(eventFor('system', 'event-bus', null, 'event.transport.failed', 'failed', `Event transport unavailable: ${error instanceof Error ? error.message : String(error)}`, 'orchestrator')); } catch { /* reporting is best effort */ } } }
}
