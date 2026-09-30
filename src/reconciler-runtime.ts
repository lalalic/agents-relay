import { DurableStore } from './store.js';
import { Job, Task, EventRecord, ChatGptTabClosePolicy } from './types.js';
import type { WorkerRequirements } from './types.js';
import { transitionJobEvent, transitionTaskEvent } from './scheduler.js';
import { DurableTaskTransitionRuntime } from './workflow/durable-transition.js';
import { Execution, StartAckTimeout, WorkerAdapter } from './adapters.js';
import { ContinuationAdapter } from './continuation.js';
import { EventBus, eventFor } from './events.js';
import { ObjectivePlanner } from './planner.js';
import type { ExecutionContextRoots } from './execution-context.js';
import type { AccountUsageOverview } from './usage.js';
import type { DecisionEngine, DecisionMode } from './decision.js';
import type { DecisionAuditStore } from './decision-audit.js';
import { WorkflowEffectExecutor, type WorkflowEffectOutcome } from './workflow/effects.js';
import { workflowEffectFailureEvent } from './workflow/contracts.js';
import { ReconcileCoordinator } from './reconcile-coordinator.js';
import { acceptedReportedTag, eventDataWithoutTag } from './task-tag.js';

export type ReconcileOptions = { owner: string; now?: Date; leaseMs?: number; maxConcurrent?: number; plannerTimeoutMs?: number; startAckTimeoutMs?: number; adapters: WorkerAdapter[]; planner?: ObjectivePlanner; continuations?: ContinuationAdapter[]; eventBus?: EventBus; emit?: (event: EventRecord) => void | Promise<void>; usageSnapshotProvider?: () => Promise<AccountUsageOverview>; runtimeSummaryProvider?: () => { chatgptRunning: number }; decisionEngine?: DecisionEngine; decisionMode?: DecisionMode; decisionAuditStore?: DecisionAuditStore; reviewer?: { adapter?: 'codex' | 'chatgpt'; workerId?: string; requirements?: WorkerRequirements; routing?: Task['routing']; maxAttempts?: number; timeoutMs?: number }; chatgptTabClosePolicy?: ChatGptTabClosePolicy; projectPathForJob?: (job: Job) => string | Promise<string>; executionContextRoots?: ExecutionContextRoots };
export type EventHandlingResult = { applied: boolean; reconcile: boolean; reason: string; reconcileMode?: 'await' | 'detached' };
type LiveExecution = { jobId: string; taskId: string; executionId: string; execution: Execution; controller: AbortController; launchBarrier: number; workerStarted: boolean; processSettled: boolean };
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
const executionBoundaryLocks = new Map<string, Promise<void>>();

/**
 * Serialize the durable execution-generation boundary across reconciler
 * instances in one relay process. Launch, routing, and terminal persistence
 * must not observe and write the same queued generation concurrently.
 */
export async function withExecutionBoundary<T>(jobId: string, taskId: string, work: () => Promise<T>): Promise<T> {
  const key = `${jobId}/${taskId}`;
  const previous = executionBoundaryLocks.get(key);
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  executionBoundaryLocks.set(key, current);
  if (previous) await previous;
  try {
    return await work();
  } finally {
    release();
    if (executionBoundaryLocks.get(key) === current) executionBoundaryLocks.delete(key);
  }
}
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
  protected readonly terminalWaiters = new Map<string, TerminalWaiter>();
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
    if (['task.completed', 'task.failed', 'task.blocked', 'task.cancelled'].includes(event.type)) return this.applyTerminalEvent(event);
    if (['review.started', 'review.approved', 'review.changes_required', 'review.blocked'].includes(event.type)) return this.applyReviewEvent(event);
    if (event.type === 'job.wake' || event.type === 'github.webhook') return { applied: true, reconcile: true, reason: event.type };
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
    let resolveAck!: () => void;
    let rejectAck!: (error: Error) => void;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const ack = new Promise<void>((resolve, reject) => { resolveAck = resolve; rejectAck = reject; });
    const unsubscribe = await this.options.eventBus.subscribe(jobId, async event => {
      if (settled || event.type !== 'task.started' || event.job_id !== jobId || event.task_id !== taskId) return;
      if (eventSourceId(event) !== sourceId) return;
      if (!event.timestamp || new Date(event.timestamp).getTime() < launchBarrier) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveAck();
    });
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void unsubscribe();
      rejectAck(new StartAckTimeout(`Task ${taskId} worker_start_timeout: no worker task.started start-ack`));
    }, timeoutMs);
    let stopped = false;
    const stop = async (): Promise<void> => { if (stopped) return; stopped = true; if (timer) clearTimeout(timer); await unsubscribe(); };
    return { ack, stop };
  }

  protected registerExecutionOwner(jobId: string, taskId: string, executionId: string): void {
    activeExecutionOwners.set(executionEventSource(jobId, taskId, executionId), this);
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
    if (live && event.job_id === live.jobId && event.timestamp && new Date(event.timestamp).getTime() < live.launchBarrier) return { applied: false, reconcile: false, reason: 'task.started.stale' };
    const transition = await this.taskTransitions.apply(event.job_id, event.task_id, 'task.started', {
      eligible: (job, task) => {
        if (!task.executionId || eventSourceId(event) !== executionEventSource(job.id, task.id, task.executionId)) return false;
        const claimedExecution = task.executionId !== null && task.leaseOwner !== null;
        const exactLiveExecution = live && event.job_id === live.jobId && task.executionId === live.executionId;
        return Boolean(exactLiveExecution || claimedExecution || this.isRecoverableWatchdogFailure(task));
      },
      facts: (_job, task) => ({
        recoverableExecution: this.isRecoverableWatchdogFailure(task)
          && (!event.timestamp || new Date(event.timestamp).getTime() >= new Date(task.updatedAt).getTime()),
      }),
      mutate: (_job, task) => {
        task.updatedAt = event.timestamp || new Date().toISOString();
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
  }

  protected async runtimeSettled(jobId: string, taskId: string, executionId: string, result: Task['result'], error: string | null): Promise<void> {
    const live = this.live.get(taskId);
    if (live?.executionId === executionId) live.processSettled = true;
    const job = await this.store.load(jobId);
    const task = job.tasks.find(item => item.id === taskId);
    if (!task || (task.executionId !== executionId && !terminalExecutionClaimed(jobId, taskId, executionId))) return;
    if (task.adapter !== 'chatgpt') this.clearTerminalTimer(taskId, executionId);
    await this.emit(eventFor(
      jobId, taskId, task.parentTaskId,
      task.adapter === 'chatgpt' ? 'task.process.async_exited' : 'task.process.exited',
      error ? 'failed' : 'succeeded',
      error ?? result?.summary ?? 'Worker runtime exited',
      'orchestrator',
      { authoritative: false, waitingForTerminalEvent: true, processError: error },
      { agent: 'relay', component: 'agents-relay' },
    ));
  }

  protected async timeoutTask(jobId: string, taskId: string, executionId: string): Promise<void> {
    const live = this.live.get(taskId);
    if (live?.executionId === executionId) {
      live.controller.abort();
      live.execution.cancel();
    }
    const transition = await this.taskTransitions.apply(jobId, taskId, 'watchdog.failed', {
      eligible: (_job, task) => task.executionId === executionId,
      mutate: (_job, task) => {
        this.clearExecution(task.id, executionId);
        task.error = `Task ${taskId} timed out waiting for the mandatory terminal worker event`;
        task.failureReason = 'terminal_event_timeout';
        task.leaseOwner = null;
        task.leaseExpiresAt = null;
      },
    });
    if (!transition?.decision.accepted) {
      this.clearExecution(taskId, executionId);
      return;
    }
    const event = eventFor(
      jobId,
      taskId,
      transition.task.parentTaskId,
      'task.failed',
      'failed',
      transition.task.error ?? `Task ${taskId} timed out waiting for the mandatory terminal worker event`,
      'user',
      { reason: 'terminal_event_timeout', timeoutMs: transition.task.timeoutMs, workflowEvent: 'watchdog.failed' },
      { agent: 'relay', component: 'agents-relay', watchdog: true },
    );
    this.detach(this.emit(event), jobId, taskId, 'timeout failure event');
  }

  protected async applyTerminalEvent(event: EventRecord, trustedInternal = false): Promise<EventHandlingResult> {
    const transition = await withExecutionBoundary(event.job_id, event.task_id, () => this.taskTransitions.apply(event.job_id, event.task_id, event.type, {
      eligible: (_job, task) => {
        if (!['codex', 'chatgpt', 'orchestrator'].includes(task.adapter)) return false;
        const modelBacked = task.adapter === 'codex' || task.adapter === 'chatgpt';
        if (!trustedInternal && modelBacked && !this.isCorrelatedWorkerEvent(task, event)) {
          const eventExecutionId = executionIdFromSource(eventSourceId(event), _job.id, task.id);
          const prior = eventExecutionId ? task.executionHistory?.find(item => item.id === eventExecutionId) : undefined;
          // A duplicate launch can leave one worker orphaned after another worker
          // has already produced the terminal fact. Accept only a known execution
          // from the same durable attempt and only when its fact is newer than its
          // launch. A prior retry attempt cannot complete a newer generation.
          if (!prior || prior.attempt !== task.attempt || !event.timestamp || new Date(event.timestamp).getTime() < new Date(prior.startedAt).getTime()) return false;
        }
        const terminalWaiter = this.terminalWaiters.get(task.id);
        return !terminalWaiter || Boolean(event.timestamp && new Date(event.timestamp).getTime() >= terminalWaiter.launchBarrier);
      },
      facts: (_job, task) => {
        const processExitedAfterPublishedTerminal = task.failureReason === 'worker_exit_without_terminal_event';
        const freshEnough = processExitedAfterPublishedTerminal
          || !event.timestamp
          || new Date(event.timestamp).getTime() >= new Date(task.updatedAt).getTime();
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
        task.updatedAt = event.timestamp || new Date().toISOString();
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
