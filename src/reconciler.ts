import { randomUUID } from 'node:crypto';
import { DurableStore } from './store.js';
import { Job, Task, EventRecord } from './types.js';
import { schedule, transitionTask } from './scheduler.js';
import { Execution, WorkerAdapter } from './adapters.js';
import { ContinuationAdapter } from './continuation.js';
import { EventBus, eventFor } from './events.js';

export type ReconcileOptions = { owner: string; now?: Date; leaseMs?: number; maxConcurrent?: number; adapters: WorkerAdapter[]; continuations?: ContinuationAdapter[]; eventBus?: EventBus; emit?: (event: EventRecord) => void | Promise<void> };
type LiveExecution = { taskId: string; execution: Execution; controller: AbortController; timer: NodeJS.Timeout };

export class Reconciler {
  private readonly live = new Map<string, LiveExecution>();
  private reconciling = false;
  constructor(private readonly store: DurableStore, private readonly options: ReconcileOptions) {}
  async watch(jobId: string): Promise<() => Promise<void>> { if (!this.options.eventBus) return async () => {}; return this.options.eventBus.subscribe(jobId, async () => { await this.reconcile(jobId); }); }
  async idle(): Promise<void> { while (this.live.size > 0) await new Promise<void>(resolve => setTimeout(resolve, 25)); }
  async wake(jobId: string): Promise<Job> { return this.reconcile(jobId); }
  async reconcile(jobId: string): Promise<Job> {
    if (this.reconciling) return this.store.load(jobId);
    this.reconciling = true;
    try {
      const job = await this.store.load(jobId);
      const now = (this.options.now ?? new Date()).getTime();
      for (const task of job.tasks) {
        if (task.state === 'CANCELLED') this.live.get(task.id)?.execution.cancel();
        if (task.state === 'RUNNING' && task.leaseExpiresAt && new Date(task.leaseExpiresAt).getTime() <= now) {
          this.live.get(task.id)?.execution.cancel();
          if (task.attempt < task.maxAttempts) { transitionTask(task, 'READY'); task.leaseOwner = null; task.leaseExpiresAt = null; await this.store.saveTask(task); }
          else { transitionTask(task, 'FAILED'); task.error = 'Lease expired after maximum attempts'; task.leaseOwner = null; task.leaseExpiresAt = null; await this.store.saveTask(task); }
        }
      }
      const scheduled = schedule(await this.store.load(jobId));
      await this.store.saveJob(scheduled);
      const capacity = Math.max(0, (this.options.maxConcurrent ?? 4) - this.live.size);
      for (const task of scheduled.tasks.filter(t => t.state === 'READY').slice(0, capacity)) await this.launch(scheduled, task);
      return schedule(await this.store.load(jobId));
    } finally { this.reconciling = false; }
  }
  private async launch(job: Job, task: Task): Promise<void> {
    const adapter = this.options.adapters.find(x => x.name === task.adapter);
    if (!adapter) { transitionTask(task, 'FAILED'); task.error = `No adapter ${task.adapter}`; await this.store.saveTask(task); return; }
    const missing = task.capabilities.filter(capability => !adapter.capabilities.includes(capability));
    if (missing.length > 0) { transitionTask(task, 'FAILED'); task.error = `Adapter ${adapter.id} lacks capabilities: ${missing.join(', ')}`; await this.store.saveTask(task); return; }
    transitionTask(task, 'RUNNING'); task.attempt += 1; task.leaseOwner = this.options.owner; task.leaseExpiresAt = new Date((this.options.now ?? new Date()).getTime() + (this.options.leaseMs ?? 300000)).toISOString(); task.executionId = randomUUID(); await this.store.saveTask(task);
    await this.emit(eventFor(job.id, task.id, task.parentTaskId, 'task.started', 'running', `Task ${task.id} started`, 'user', { adapter: adapter.id, model: task.routing?.model }));
    const controller = new AbortController(); let execution: Execution;
    try { execution = adapter.launch(task, controller.signal); } catch (error) { await this.finish(job.id, task.id, task.executionId, null, error instanceof Error ? error.message : String(error)); return; }
    task.executionId = execution.id; await this.store.saveTask(task);
    execution.onThreadStarted = (threadId: string) => { void this.persistThread(job.id, task.id, execution.id, threadId); };
    const timer = setTimeout(() => { controller.abort(); execution.cancel(); }, task.timeoutMs);
    this.live.set(task.id, { taskId: task.id, execution, controller, timer });
    void execution.promise.then(result => this.finish(job.id, task.id, execution.id, result, null), error => this.finish(job.id, task.id, execution.id, null, error instanceof Error ? error.message : String(error)));
  }
  private async persistThread(jobId: string, taskId: string, executionId: string, threadId: string): Promise<void> { const job = await this.store.load(jobId); const task = job.tasks.find(item => item.id === taskId); if (task?.executionId === executionId && task.state === 'RUNNING') { task.threadId = threadId; await this.store.saveTask(task); await this.emit(eventFor(jobId, taskId, task.parentTaskId, 'thread.started', 'running', `Codex thread ${threadId} started`, 'orchestrator', { threadId })); } }
  private async finish(jobId: string, taskId: string, executionId: string | null, result: Task['result'], error: string | null): Promise<void> {
    const live = this.live.get(taskId); if (live) { clearTimeout(live.timer); this.live.delete(taskId); }
    const job = await this.store.load(jobId); const task = job.tasks.find(item => item.id === taskId); if (!task || task.executionId !== executionId) return;
    if (task.state === 'CANCELLED') { await this.store.saveTask(task); return; }
    if (error === null) { task.result = result; task.error = null; task.leaseOwner = null; task.leaseExpiresAt = null; transitionTask(task, 'SUCCEEDED'); await this.store.saveTask(task); await this.emit(eventFor(job.id, task.id, task.parentTaskId, 'task.completed', 'succeeded', `Task ${task.id} completed`)); await this.deliverContinuation(job, task); }
    else { task.error = error; task.leaseOwner = null; task.leaseExpiresAt = null; transitionTask(task, task.attempt < task.maxAttempts ? 'READY' : 'FAILED'); await this.store.saveTask(task); await this.emit(eventFor(job.id, task.id, task.parentTaskId, task.state === 'FAILED' ? 'task.failed' : 'task.retry', task.state === 'FAILED' ? 'failed' : 'queued', `Task ${task.id}: ${error}`, task.state === 'FAILED' ? 'user' : 'orchestrator')); }
    void this.reconcile(jobId);
  }
  private async deliverContinuation(job: Job, task: Task): Promise<void> {
    const continuation = task.continuation ?? job.continuation;
    if (!continuation || task.continuationDeliveredAt) return;
    task.continuationDeliveredAt = new Date().toISOString();
    await this.store.saveTask(task);
    const adapter = this.options.continuations?.find(candidate => candidate.kind === continuation.kind);
    if (!adapter) { task.error = `No continuation adapter for ${continuation.kind}`; await this.store.saveTask(task); return; }
    void adapter.continue(task.result?.summary ?? '', continuation).catch(async error => {
      await this.emit(eventFor(job.id, task.id, task.parentTaskId, 'continuation.failed', 'failed', `Continuation failed: ${error instanceof Error ? error.message : String(error)}`, 'user'));
    });
  }
  private async emit(event: EventRecord): Promise<void> { if (this.options.emit) await this.options.emit(event); if (this.options.eventBus) await this.options.eventBus.publish(event); }
}
