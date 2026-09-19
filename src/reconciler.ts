import { randomUUID } from 'node:crypto';
import { DurableStore } from './store.js';
import { AgentRegistration, Job, Task, EventRecord } from './types.js';
import { schedule, transitionTask } from './scheduler.js';
import { Execution, WorkerAdapter } from './adapters.js';
import { ContinuationAdapter } from './continuation.js';
import { EventBus, eventFor } from './events.js';
import { agentAdapter, assertAgentEligible } from './dispatch.js';

export type ReconcileOptions = { owner: string; now?: Date; leaseMs?: number; maxConcurrent?: number; adapters: WorkerAdapter[]; continuations?: ContinuationAdapter[]; eventBus?: EventBus; emit?: (event: EventRecord) => void | Promise<void> };
type LiveExecution = { taskId: string; execution: Execution; controller: AbortController; timer: NodeJS.Timeout; startedAt: number; agentId?: string; timedOut: boolean };

export function managedWorkerInput(job: Job, task: Task): string {
  if (!['codex', 'chatgpt'].includes(task.adapter) || !job.repository || job.prNumber <= 0) return task.input;
  const prUrl = `https://github.com/${job.repository}/pull/${job.prNumber}`;
  return `[Agents Relay managed task]\nPR: ${prUrl}\nJob: ${job.id}\nTask: ${task.id}\nParent task: ${task.parentTaskId ?? 'none'}\nProject: ${task.projectName ?? 'unspecified'}\n\n${task.input}`;
}


function observableCost(result: Task['result']): number | undefined {
  const data = result?.data;
  if (!data) return undefined;
  for (const key of ['cost', 'costUsd']) {
    const value = data[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  const usage = data.usage;
  if (typeof usage === 'object' && usage !== null && !Array.isArray(usage)) {
    for (const key of ['cost', 'costUsd']) {
      const value = (usage as Record<string, unknown>)[key];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
  }
  return undefined;
}

export class Reconciler {
  private readonly live = new Map<string, LiveExecution>();
  private readonly continuationLive = new Set<string>();
  private reconciling = false;
  constructor(private readonly store: DurableStore, private readonly options: ReconcileOptions) {}
  async watch(jobId: string): Promise<() => Promise<void>> { if (!this.options.eventBus) return async () => {}; try { return await this.options.eventBus.subscribe(jobId, async () => { await this.reconcile(jobId); }); } catch (error) { await this.reportTransportFailure(error); return async () => {}; } }
  async idle(): Promise<void> { while (this.live.size > 0 || this.continuationLive.size > 0 || this.reconciling) await new Promise<void>(resolve => setTimeout(resolve, 25)); }
  async wake(jobId: string): Promise<Job> { return this.reconcile(jobId); }
  async reconcile(jobId: string): Promise<Job> {
    if (this.reconciling) return this.store.load(jobId);
    this.reconciling = true;
    try {
      const job = await this.store.load(jobId);
      const previousState = job.state;
      const prState = await this.store.pullRequestState?.() ?? 'OPEN';
      const now = (this.options.now ?? new Date()).getTime();
      if (prState !== 'OPEN') {
        const reason = prState === 'MERGED' ? 'Pull request merged' : 'Pull request closed';
        for (const task of job.tasks.filter(item => !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(item.state))) {
          this.live.get(task.id)?.execution.cancel();
          transitionTask(task, 'CANCELLED'); task.error = reason; task.leaseOwner = null; task.leaseExpiresAt = null; await this.store.saveTask(task);
        }
      }
      for (const task of job.tasks) {
        if (task.state === 'CANCELLED') this.live.get(task.id)?.execution.cancel();
        if (task.state === 'RUNNING' && task.leaseExpiresAt && new Date(task.leaseExpiresAt).getTime() <= now) {
          this.live.get(task.id)?.execution.cancel();
          if (task.attempt < task.maxAttempts) { transitionTask(task, 'READY'); task.leaseOwner = null; task.leaseExpiresAt = null; await this.store.saveTask(task); }
          else { transitionTask(task, 'FAILED'); task.error = 'Lease expired after maximum attempts'; task.leaseOwner = null; task.leaseExpiresAt = null; await this.store.saveTask(task); }
        }
      }
      const scheduled = schedule(await this.store.load(jobId));
      if (prState === 'MERGED') { scheduled.state = 'COMPLETED'; scheduled.updatedAt = new Date().toISOString(); }
      if (prState === 'CLOSED') { scheduled.state = 'CANCELLED'; scheduled.updatedAt = new Date().toISOString(); }
      if (scheduled.state !== previousState) await this.store.saveJob(scheduled);
      if (prState === 'OPEN') {
        for (const task of scheduled.tasks.filter(item => item.state === 'SUCCEEDED' && (item.continuation || scheduled.continuation) && !item.continuationDeliveredAt)) void this.deliverContinuation(scheduled, task);
        const capacity = Math.max(0, (this.options.maxConcurrent ?? 4) - this.live.size);
        for (const task of scheduled.tasks.filter(t => t.state === 'READY').slice(0, capacity)) await this.launch(scheduled, task);
      }
      const finalState = schedule(await this.store.load(jobId));
      if (prState === 'MERGED') { finalState.state = 'COMPLETED'; finalState.updatedAt = new Date().toISOString(); }
      if (prState === 'CLOSED') { finalState.state = 'CANCELLED'; finalState.updatedAt = new Date().toISOString(); }
      if (finalState.state !== scheduled.state || finalState.updatedAt !== scheduled.updatedAt) await this.store.saveJob(finalState);
      if (finalState.state === 'COMPLETED' || prState !== 'OPEN') await this.cleanupThreads(finalState);
      return this.store.load(jobId);
    } finally { this.reconciling = false; }
  }
  private async launch(job: Job, task: Task): Promise<void> {
    let adapter: WorkerAdapter | undefined;
    let agent: AgentRegistration | undefined;
    if (task.agentId) {
      agent = (await this.store.listAgents()).find(candidate => candidate.id === task.agentId);
      if (!agent) { transitionTask(task, 'FAILED'); task.error = `Registered agent ${task.agentId} not found`; await this.store.saveTask(task); return; }
      try { assertAgentEligible(agent, task); adapter = agentAdapter(agent, this.options.adapters); }
      catch (error) { transitionTask(task, 'FAILED'); task.error = error instanceof Error ? error.message : String(error); await this.store.saveTask(task); return; }
    } else {
      adapter = this.options.adapters.find(x => x.name === task.adapter);
      const missing = task.capabilities.filter(capability => !adapter?.capabilities.includes(capability));
      if (adapter && missing.length > 0) { transitionTask(task, 'FAILED'); task.error = `Adapter ${adapter.id} lacks capabilities: ${missing.join(', ')}`; await this.store.saveTask(task); return; }
    }
    if (!adapter) { transitionTask(task, 'FAILED'); task.error = `No adapter ${task.adapter}`; await this.store.saveTask(task); return; }
    const leaseMs = Math.max(this.options.leaseMs ?? 300000, task.timeoutMs); const leaseStartedAt = (this.options.now ?? new Date()).getTime(); const startedAt = Date.now();
    transitionTask(task, 'RUNNING'); task.attempt += 1; task.leaseOwner = this.options.owner; task.leaseExpiresAt = new Date(leaseStartedAt + leaseMs).toISOString(); task.executionId = randomUUID(); await this.store.saveTask(task);
    await this.emit(eventFor(job.id, task.id, task.parentTaskId, 'task.started', 'running', `Task ${task.id} started`, 'user', { agentId: task.agentId, adapter: adapter.id, model: task.routing?.model }));
    const controller = new AbortController(); let execution: Execution;
    const effectiveTask = { ...task, adapter: adapter.name };
    const workerTask = { ...effectiveTask, input: managedWorkerInput(job, effectiveTask) };
    try { execution = adapter.launch(workerTask, controller.signal); } catch (error) { await this.finish(job.id, task.id, task.executionId, null, error instanceof Error ? error.message : String(error), { agent, startedAt, timedOut: false }); return; }
    task.executionId = execution.id; await this.store.saveTask(task);
    let threadPersistence = Promise.resolve();
    const persistThread = (threadId: string): void => {
      threadPersistence = threadPersistence.then(() => this.persistThread(job.id, task.id, execution.id, threadId));
    };
    execution.onThreadStarted = persistThread;
    if (execution.threadId) persistThread(execution.threadId);
    const timer = setTimeout(() => { const live = this.live.get(task.id); if (live?.execution.id === execution.id) live.timedOut = true; controller.abort(); execution.cancel(); }, task.timeoutMs);
    this.live.set(task.id, { taskId: task.id, execution, controller, timer, startedAt, agentId: agent?.id, timedOut: false });
    void execution.promise.then(
      async result => { await threadPersistence; await this.finish(job.id, task.id, execution.id, result, null); },
      async error => { await threadPersistence; await this.finish(job.id, task.id, execution.id, null, error instanceof Error ? error.message : String(error)); },
    );
  }
  private async persistThread(jobId: string, taskId: string, executionId: string, threadId: string): Promise<void> { const job = await this.store.load(jobId); const task = job.tasks.find(item => item.id === taskId); if (task?.executionId === executionId && task.state === 'RUNNING') { task.threadId = threadId; task.threadDeletedAt = null; task.threadCleanupError = null; await this.store.saveTask(task); await this.emit(eventFor(jobId, taskId, task.parentTaskId, 'thread.started', 'running', `Worker thread ${threadId} started`, 'orchestrator', { threadId })); } }
  private async finish(jobId: string, taskId: string, executionId: string | null, result: Task['result'], error: string | null, launch?: { agent?: AgentRegistration; startedAt: number; timedOut: boolean }): Promise<void> {
    const live = this.live.get(taskId);
    const execution = live?.execution.id === executionId ? live : undefined;
    if (execution) { clearTimeout(execution.timer); this.live.delete(taskId); }
    const job = await this.store.load(jobId); const task = job.tasks.find(item => item.id === taskId); if (!task || task.executionId !== executionId) return;
    if (task.state === 'CANCELLED') { await this.store.saveTask(task); return; }
    const timedOut = execution?.timedOut ?? launch?.timedOut ?? false;
    const startedAt = execution?.startedAt ?? launch?.startedAt;
    const agentId = execution?.agentId ?? launch?.agent?.id;
    if (error === null) { task.result = result; task.error = null; task.leaseOwner = null; task.leaseExpiresAt = null; transitionTask(task, 'SUCCEEDED'); await this.store.saveTask(task); }
    else { task.error = error; task.leaseOwner = null; task.leaseExpiresAt = null; transitionTask(task, task.attempt < task.maxAttempts ? 'READY' : 'FAILED'); await this.store.saveTask(task); }
    if (agentId && executionId) await this.recordAgentOutcome(task, agentId, executionId, timedOut ? 'timeout' : error === null ? 'success' : 'failure', startedAt, result, error);
    if (error === null) { await this.emit(eventFor(job.id, task.id, task.parentTaskId, 'task.completed', 'succeeded', `Task ${task.id} completed`)); await this.deliverContinuation(job, task); }
    else await this.emit(eventFor(job.id, task.id, task.parentTaskId, task.state === 'FAILED' ? 'task.failed' : 'task.retry', task.state === 'FAILED' ? 'failed' : 'queued', `Task ${task.id}: ${error}`, task.state === 'FAILED' ? 'user' : 'orchestrator'));
    void this.reconcile(jobId);
  }
  private async recordAgentOutcome(task: Task, agentId: string, executionId: string, outcome: 'success' | 'failure' | 'timeout', startedAt: number | undefined, result: Task['result'], error: string | null): Promise<void> {
    const agent = (await this.store.listAgents()).find(candidate => candidate.id === agentId);
    if (!agent || agent.evidence.evaluations.some(item => item.executionId === executionId)) return;
    const observedAt = new Date().toISOString();
    const cost = observableCost(result);
    agent.evidence.evaluations.push({
      source: 'task',
      jobId: task.jobId,
      taskId: task.id,
      executionId,
      attempt: task.attempt,
      taskKind: task.agentName ?? task.adapter,
      capabilities: [...task.capabilities],
      outcome,
      observedAt,
      version: task.routing?.model ?? agent.runtime.model ?? agent.runtime.adapter,
      summary: error ?? result?.summary,
      latencyMs: startedAt === undefined ? undefined : Math.max(0, Date.now() - startedAt),
      cost,
    });
    if (outcome === 'success') agent.evidence.outcomes.succeeded += 1;
    else if (outcome === 'timeout') agent.evidence.outcomes.timedOut += 1;
    else agent.evidence.outcomes.failed += 1;
    agent.evidence.lastObservedAt = observedAt;
    agent.updatedAt = observedAt;
    await this.store.saveAgent(agent);
  }
  private async cleanupThreads(job: Job): Promise<void> {
    const adapter = this.options.adapters.find(candidate => candidate.name === 'chatgpt' && candidate.deleteThread);
    if (!adapter?.deleteThread) return;
    for (const task of job.tasks.filter(item => item.adapter === 'chatgpt' && item.threadId && !item.threadDeletedAt)) {
      try {
        await adapter.deleteThread(task.threadId as string);
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
  private async reportTransportFailure(error: unknown): Promise<void> { if (this.options.emit) { try { await this.options.emit(eventFor('system', 'event-bus', null, 'event.transport.failed', 'failed', `Event transport unavailable: ${error instanceof Error ? error.message : String(error)}`, 'orchestrator')); } catch { /* reporting is best effort */ } } }
}
