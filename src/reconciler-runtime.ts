import { DurableStore } from './store.js';
import { Job, Task, EventRecord, ChatGptTabClosePolicy } from './types.js';
import type { WorkerRequirements } from './types.js';
import { transitionJobEvent, transitionTaskEvent } from './scheduler.js';
import { Execution, StartAckTimeout, WorkerAdapter } from './adapters.js';
import { ContinuationAdapter } from './continuation.js';
import { EventBus, eventFor } from './events.js';
import { ObjectivePlanner } from './planner.js';
import type { ExecutionContextRoots } from './execution-context.js';
import type { AccountUsageOverview } from './usage.js';
import type { DecisionEngine, DecisionMode } from './decision.js';
import { WorkflowEffectExecutor, type WorkflowEffectOutcome } from './workflow/effects.js';
import { workflowEffectFailureEvent } from './workflow/contracts.js';

export type ReconcileOptions = { owner: string; now?: Date; leaseMs?: number; maxConcurrent?: number; plannerTimeoutMs?: number; startAckTimeoutMs?: number; terminalExitGraceMs?: number; adapters: WorkerAdapter[]; planner?: ObjectivePlanner; continuations?: ContinuationAdapter[]; eventBus?: EventBus; emit?: (event: EventRecord) => void | Promise<void>; usageSnapshotProvider?: () => Promise<AccountUsageOverview>; decisionEngine?: DecisionEngine; decisionMode?: DecisionMode; reviewer?: { adapter?: 'codex' | 'chatgpt'; workerId?: string; requirements?: WorkerRequirements; routing?: Task['routing']; maxAttempts?: number; timeoutMs?: number }; chatgptTabClosePolicy?: ChatGptTabClosePolicy; projectPathForJob?: (job: Job) => string | Promise<string>; executionContextRoots?: ExecutionContextRoots };
type LiveExecution = { jobId: string; taskId: string; executionId: string; execution: Execution; controller: AbortController; launchBarrier: number; workerStarted: boolean };
type LivePlanner = { executionId: string; controller: AbortController; timer: NodeJS.Timeout };
type TerminalWaiter = { executionId: string; launchBarrier: number; resolve: () => void };

export function executionEventSource(jobId: string, taskId: string, executionId: string): string { return `job/${jobId}/task/${taskId}/execution/${executionId}`; }
function eventSourceId(event: EventRecord): string | undefined { return typeof event.source?.id === 'string' ? event.source.id : undefined; }

const terminalExecutionClaims = new Set<string>();
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
  protected readonly terminalExitGraceTimers = new Map<string, NodeJS.Timeout>();
  protected readonly continuationLive = new Set<string>();
  protected readonly launchFailureClaims = new Set<string>();
  protected readonly terminalWaiters = new Map<string, TerminalWaiter>();
  protected readonly workflowEffects = new WorkflowEffectExecutor();
  protected reconciling = false;
  constructor(protected readonly store: DurableStore, protected readonly options: ReconcileOptions) {}
  abstract reconcile(jobId: string): Promise<Job>;
  protected abstract applyReviewEvent(event: EventRecord): Promise<void>;

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
  async handleEvent(event: EventRecord): Promise<void> {
    if (event.type === 'task.started') {
      await this.markWorkerStarted(event);
      return;
    }
    if (['task.completed', 'task.failed', 'task.blocked', 'task.cancelled'].includes(event.type)) {
      await this.applyTerminalEvent(event);
      return;
    }
    if (['review.started', 'review.approved', 'review.changes_required', 'review.blocked'].includes(event.type)) { await this.applyReviewEvent(event); return; }
    if (event.type === 'job.wake' || event.type === 'github.webhook') await this.reconcile(event.job_id);
  }
  async watch(jobId: string): Promise<() => Promise<void>> {
    if (!this.options.eventBus) return async () => {};
    try {
      return await this.options.eventBus.subscribe(jobId, event => this.handleEvent(event));
    } catch (error) {
      await this.reportTransportFailure(error);
      return async () => {};
    }
  }
  async idle(): Promise<void> { while (this.live.size > 0 || this.plannerLive.size > 0 || this.continuationLive.size > 0 || this.reconciling) await new Promise<void>(resolve => setTimeout(resolve, 25)); }
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

  protected clearExecution(taskId: string, executionId?: string | null): void {
    const live = this.live.get(taskId);
    if (!executionId || live?.executionId === executionId) this.live.delete(taskId);
    const timer = this.terminalTimers.get(taskId);
    if (timer) clearTimeout(timer);
    this.terminalTimers.delete(taskId);
    const graceTimer = this.terminalExitGraceTimers.get(taskId);
    if (graceTimer) clearTimeout(graceTimer);
    this.terminalExitGraceTimers.delete(taskId);
  }

  protected async markWorkerStarted(event: EventRecord): Promise<void> {
    const live = this.live.get(event.task_id);
    if (live && event.job_id === live.jobId && event.timestamp && new Date(event.timestamp).getTime() < live.launchBarrier) return;
    const job = await this.store.load(event.job_id);
    const task = job.tasks.find(item => item.id === event.task_id);
    if (!task || !task.executionId || eventSourceId(event) !== executionEventSource(job.id, task.id, task.executionId)) return;
    const claimedExecution = task.state === 'QUEUED' && task.executionId !== null && task.leaseOwner !== null;
    const exactLiveExecution = live && event.job_id === live.jobId && task.executionId === live.executionId;
    if ((exactLiveExecution || claimedExecution) && task.state === 'QUEUED') {
      await transitionTaskEvent(task, 'task.started');
      task.failureReason = undefined;
      task.error = null;
      task.updatedAt = event.timestamp || new Date().toISOString();
      await this.store.saveTask(task);
      if (live) live.workerStarted = true;
      return;
    }
    if (task.state !== 'FAILED' || !this.isRecoverableWatchdogFailure(task)) return;
    if (event.timestamp && new Date(event.timestamp).getTime() < new Date(task.updatedAt).getTime()) return;
    await transitionTaskEvent(task, 'reconcile.started');
    task.failureReason = undefined;
    task.error = null;
    task.updatedAt = event.timestamp || new Date().toISOString();
    await this.store.saveTask(task);
    this.detach(this.reconcile(job.id), job.id, task.id, 'late worker-start reconciliation');
  }

  protected isRecoverableWatchdogFailure(task: Task): boolean {
    if (['worker_start_timeout', 'terminal_event_timeout', 'worker_exit_before_start', 'worker_exit_without_terminal_event'].includes(task.failureReason ?? '')) return true;
    const error = task.error ?? '';
    return error.includes('worker_start_timeout')
      || error.includes('timed out waiting for the mandatory terminal worker event')
      || error.includes('exited before publishing task.started')
      || error.includes('exited after task.started without publishing a terminal task event');
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
    const job = await this.store.load(jobId);
    const task = job.tasks.find(item => item.id === taskId);
    if (!task || task.executionId !== executionId || !['QUEUED', 'RUNNING'].includes(task.state)) return;
    const event = eventFor(jobId, taskId, task.parentTaskId, 'task.failed', 'failed', `Worker ${phase} failed: ${message}`, 'user', { phase, reason: phase === 'start-ack' ? 'worker_start_timeout' : undefined }, { agent: 'relay', component: 'agents-relay', watchdog: true });
    if (task.state === 'QUEUED') {
      this.clearExecution(task.id, executionId);
      task.error = event.message;
      task.failureReason = phase === 'start-ack' ? 'worker_start_timeout' : undefined;
      task.leaseOwner = null; task.leaseExpiresAt = null;
      await transitionTaskEvent(task, 'fail');
      await this.store.saveTask(task);
    } else {
      await this.applyTerminalEvent(event, true);
    }
    await this.emit(event);
  }

  protected async runtimeSettled(jobId: string, taskId: string, executionId: string, result: Task['result'], error: string | null): Promise<void> {
    const live = this.live.get(taskId);
    const liveWorkerStarted = live?.executionId === executionId && live.workerStarted;
    if (live?.executionId === executionId) this.live.delete(taskId);
    const job = await this.store.load(jobId);
    const task = job.tasks.find(item => item.id === taskId);
    const workerStarted = liveWorkerStarted || task?.state === 'RUNNING';
    if (!task || task.executionId !== executionId) return;
    await this.emit(eventFor(
      jobId, taskId, task.parentTaskId,
      task.adapter === 'chatgpt' ? 'task.process.async_exited' : 'task.process.exited',
      error ? 'failed' : 'succeeded',
      error ?? result?.summary ?? 'Worker runtime exited',
      'orchestrator',
      { authoritative: false, waitingForTerminalEvent: true, processError: error },
      { agent: 'relay', component: 'agents-relay' },
    ));
    if (['QUEUED', 'RUNNING'].includes(task.state) && task.adapter === 'codex' && !terminalExecutionClaimed(jobId, taskId, executionId)) this.scheduleUnexpectedExit(jobId, taskId, executionId, workerStarted === true);
  }

  protected scheduleUnexpectedExit(jobId: string, taskId: string, executionId: string, workerStarted: boolean): void {
    const graceMs = Math.max(1, this.options.terminalExitGraceMs ?? 1000);
    const timer = setTimeout(() => {
      this.terminalExitGraceTimers.delete(taskId);
      this.detach(this.failUnexpectedExit(jobId, taskId, executionId, workerStarted), jobId, taskId, 'unexpected worker process exit');
    }, graceMs);
    this.terminalExitGraceTimers.set(taskId, timer);
  }

  protected async failUnexpectedExit(jobId: string, taskId: string, executionId: string, workerStarted: boolean): Promise<void> {
    if (terminalExecutionClaimed(jobId, taskId, executionId)) return;
    const job = await this.store.load(jobId);
    const task = job.tasks.find(item => item.id === taskId);
    if (!task || task.executionId !== executionId || !['QUEUED', 'RUNNING'].includes(task.state) || terminalExecutionClaimed(jobId, taskId, executionId)) return;
    const reason = workerStarted ? 'worker_exit_without_terminal_event' : 'worker_exit_before_start';
    const message = workerStarted
      ? `Worker ${taskId} exited after task.started without publishing a terminal task event`
      : `Worker ${taskId} exited before publishing task.started`;
    const event = eventFor(jobId, taskId, task.parentTaskId, 'task.failed', 'failed', message, 'user', { reason, terminalGraceMs: this.options.terminalExitGraceMs ?? 1000 }, { agent: 'relay', component: 'agents-relay', watchdog: true });
    if (task.state === 'QUEUED') {
      this.clearExecution(task.id, executionId);
      task.error = message;
      task.failureReason = reason;
      task.leaseOwner = null;
      task.leaseExpiresAt = null;
      await transitionTaskEvent(task, 'fail');
      await this.store.saveTask(task);
    } else {
      await this.applyTerminalEvent(event, true);
    }
    await this.emit(event);
  }

  protected async timeoutTask(jobId: string, taskId: string, executionId: string): Promise<void> {
    const live = this.live.get(taskId);
    if (live?.executionId === executionId) {
      live.controller.abort();
      live.execution.cancel();
    }
    const job = await this.store.load(jobId);
    const task = job.tasks.find(item => item.id === taskId);
    if (!task || task.executionId !== executionId || !['QUEUED', 'RUNNING'].includes(task.state)) {
      this.clearExecution(taskId, executionId);
      return;
    }
    const event = eventFor(jobId, taskId, task.parentTaskId, 'task.failed', 'failed', `Task ${taskId} timed out waiting for the mandatory terminal worker event`, 'user', { reason: 'terminal_event_timeout', timeoutMs: task.timeoutMs });
    if (task.state === 'QUEUED') {
      task.error = event.message;
      task.failureReason = 'terminal_event_timeout';
      task.leaseOwner = null; task.leaseExpiresAt = null;
      await transitionTaskEvent(task, 'fail');
      await this.store.saveTask(task);
      this.clearExecution(task.id, executionId);
    } else {
      await this.applyTerminalEvent(event, true);
    }
    await this.emit(event);
  }

  protected async applyTerminalEvent(event: EventRecord, trustedInternal = false): Promise<void> {
    const job = await this.store.load(event.job_id);
    const task = job.tasks.find(item => item.id === event.task_id);
    if (!task || !['codex', 'chatgpt', 'orchestrator'].includes(task.adapter)) return;
    const modelBacked = task.adapter === 'codex' || task.adapter === 'chatgpt';
    if (!trustedInternal && modelBacked && !this.isCorrelatedWorkerEvent(task, event)) return;
    if (task.state === 'FAILED' && this.isRecoverableWatchdogFailure(task) && (trustedInternal || !modelBacked || this.isCorrelatedWorkerEvent(task, event))) {
      if (event.timestamp && new Date(event.timestamp).getTime() < new Date(task.updatedAt).getTime()) return;
      await transitionTaskEvent(task, 'reconcile.started');
      task.failureReason = undefined;
      task.error = null;
    }
    if (task.state !== 'RUNNING') return;
    const terminalWaiter = this.terminalWaiters.get(task.id);
    if (terminalWaiter && (!event.timestamp || new Date(event.timestamp).getTime() < terminalWaiter.launchBarrier)) return;
    const acceptedExecutionId = task.executionId;
    if (modelBacked && acceptedExecutionId) claimTerminalExecution(executionEventSource(job.id, task.id, acceptedExecutionId));
    this.clearExecution(task.id, acceptedExecutionId);
    task.leaseOwner = null;
    task.leaseExpiresAt = null;
    task.updatedAt = event.timestamp || new Date().toISOString();
    this.terminalWaiters.get(task.id)?.resolve();
    this.terminalWaiters.delete(task.id);
    if (event.type === 'task.completed') {
      task.result = { summary: event.message || `Task ${task.id} completed`, data: event.data };
      task.error = null;
      task.failureReason = undefined;
      await transitionTaskEvent(task, 'task.completed');
      await this.store.saveTask(task);
      await this.deliverContinuation(job, task);
    } else if (event.type === 'task.failed') {
      task.error = event.message || `Task ${task.id} failed`;
      task.failureReason = typeof event.data?.reason === 'string' ? event.data.reason : undefined;
      await transitionTaskEvent(task, 'task.failed');
      await this.store.saveTask(task);
    } else if (event.type === 'task.blocked') {
      task.error = event.message || `Task ${task.id} blocked`;
      await transitionTaskEvent(task, 'task.blocked');
      await this.store.saveTask(task);
    } else if (event.type === 'task.cancelled') {
      task.error = event.message || `Task ${task.id} cancelled`;
      await transitionTaskEvent(task, 'task.cancelled');
      await this.store.saveTask(task);
    }
    this.detach(this.reconcile(job.id), job.id, task.id, 'terminal-event reconciliation');
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
