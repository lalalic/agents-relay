import { randomUUID } from 'node:crypto';
import { DurableStore } from './store.js';
import { Job, Task, EventRecord, Priority, ReviewOutcome, ChatGptTabClosePolicy } from './types.js';
import { schedule, transitionTask } from './scheduler.js';
import { Execution, LaunchFailure, StartAckTimeout, WorkerAdapter, LaunchContext } from './adapters.js';
import { ContinuationAdapter } from './continuation.js';
import { EventBus, eventFor } from './events.js';
import { ObjectivePlanner, parsePlannerResult, plannerInput, PlannerTaskSpec } from './planner.js';

const PRIORITY_RANK: Record<Priority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
export function compareTaskPriority(a: Task, b: Task, jobPriority: Priority = 'P2'): number { const ar = PRIORITY_RANK[a.priority ?? jobPriority]; const br = PRIORITY_RANK[b.priority ?? jobPriority]; return ar - br || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id); }

export type ReconcileOptions = { owner: string; now?: Date; leaseMs?: number; maxConcurrent?: number; plannerTimeoutMs?: number; startAckTimeoutMs?: number; terminalExitGraceMs?: number; adapters: WorkerAdapter[]; planner?: ObjectivePlanner; continuations?: ContinuationAdapter[]; eventBus?: EventBus; emit?: (event: EventRecord) => void | Promise<void>; reviewer?: { adapter?: 'codex' | 'chatgpt'; routing?: Task['routing']; maxAttempts?: number; timeoutMs?: number; startAckTimeoutMs?: number }; chatgptTabClosePolicy?: ChatGptTabClosePolicy };
type LiveExecution = { jobId: string; taskId: string; executionId: string; execution: Execution; controller: AbortController; launchBarrier: number; workerStarted: boolean };
type LivePlanner = { executionId: string; controller: AbortController; timer: NodeJS.Timeout };
type TerminalWaiter = { executionId: string; launchBarrier: number; resolve: () => void };

export function managedWorkerInput(job: Job, task: Task): string {
  if (!['codex', 'chatgpt'].includes(task.adapter) || !job.repository || job.prNumber <= 0) return task.input;
  if (!task.output) throw new Error(`Task ${task.id} requires an explicit output contract`);
  const prUrl = `https://github.com/${job.repository}/pull/${job.prNumber}`;
  const output = task.output.kind === 'file'
    ? `file\nPath: ${task.output.path}`
    : `task/PR\nPR: ${prUrl}\nTask: ${task.id}`;
  return `[Agents Relay managed task]
PR: ${prUrl}
Job: ${job.id}
Task: ${task.id}
Parent task: ${task.parentTaskId ?? 'none'}
Project: ${task.projectName ?? 'unspecified'}

${task.input}

[Output contract]
${output}

[Execution event contract — mandatory]
Use the canonical Neo events-bus with exactly Job ${job.id} and Task ${task.id}.
Follow the events-bus skill/protocol. For sandboxed Codex or hosted ChatGPT,
publish through the federated MCP tool events__publish; do not open NATS directly.
For a direct non-sandbox local worker, use NEO_EVENTS_EMIT when the caller provides it.

As your FIRST execution action, before reading files, editing code, running commands, or doing other work,
you MUST publish exactly one canonical task.started event for this exact Job/Task.

You MAY publish progress events while working.
Before returning or allowing the worker process to exit, you MUST publish exactly one canonical terminal event:
- task.completed only after the declared output is durable;
- task.failed for implementation, tool, command, test, patch, commit, push, runtime, or other execution failure that prevents completion;
- task.blocked only when genuine human/external action is required;
- task.cancelled only when execution was cancelled.

If any execution step fails and you cannot continue, publish task.failed with the concrete reason BEFORE exiting.
Never exit after task.started without publishing exactly one terminal task event.
Do not publish duplicate terminal task events.
The worker owns task.started and task terminal events. Relay-owned task.process.launched, task.process.exited,
and task.process.async_exited are process lifecycle only and NEVER replace the worker task lifecycle.
The ChatGPT/Codex conversation or process exit is never the task result.

[Final event gate]
Before your final return, verify that a terminal event for this exact Job/Task was published.
If no terminal event has been published, publish task.failed before exiting.`;
}

export class Reconciler {
  private readonly live = new Map<string, LiveExecution>();
  private readonly plannerLive = new Map<string, LivePlanner>();
  private readonly terminalTimers = new Map<string, NodeJS.Timeout>();
  private readonly terminalExitGraceTimers = new Map<string, NodeJS.Timeout>();
  private readonly continuationLive = new Set<string>();
  private readonly launchFailureClaims = new Set<string>();
  private readonly terminalWaiters = new Map<string, TerminalWaiter>();
  private reconciling = false;
  constructor(private readonly store: DurableStore, private readonly options: ReconcileOptions) {}
  async handleEvent(event: EventRecord): Promise<void> {
    if (event.type === 'task.started') {
      this.markWorkerStarted(event);
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
  async reconcile(jobId: string): Promise<Job> {
    if (this.reconciling) return this.store.load(jobId);
    this.reconciling = true;
    try {
      const job = await this.store.load(jobId);
      const previousState = job.state;
      const prState = await this.store.pullRequestState?.() ?? 'OPEN';
      const headSha = prState === 'OPEN' ? await this.currentHeadSha(job) : null;
      if (headSha) job.headSha = headSha;
      await this.invalidateStaleReview(job, headSha);
      const now = (this.options.now ?? new Date()).getTime();
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
      await this.ensureFinalReview(finalState, prState, headSha);
      return this.store.load(jobId);
    } finally { this.reconciling = false; }
  }
  private async currentHeadSha(job: Job): Promise<string | null> { return await this.store.headSha?.() ?? job.headSha ?? job.review?.headSha ?? null; }
  private async invalidateStaleReview(job: Job, headSha: string | null): Promise<void> {
    if (!headSha || !job.review || job.review.headSha === headSha || job.review.outcome === 'stale') return;
    job.review = { ...job.review, outcome: 'stale', updatedAt: new Date().toISOString() };
    const staleTask = job.review.taskId ? job.tasks.find(task => task.id === job.review?.taskId) : undefined;
    if (staleTask && ['QUEUED', 'READY', 'RUNNING', 'WAITING'].includes(staleTask.state)) {
      this.live.get(staleTask.id)?.execution.cancel();
      transitionTask(staleTask, 'CANCELLED');
      staleTask.error = 'Review evidence became stale after the PR head changed';
      staleTask.leaseOwner = null;
      staleTask.leaseExpiresAt = null;
      await this.store.saveTask(staleTask);
    }
    await this.store.saveJob(job);
  }
  private async ensureFinalReview(job: Job, prState: string, headSha: string | null): Promise<void> {
    if (prState !== 'OPEN' || job.state !== 'COMPLETED' || !headSha) return;
    if (!this.preReviewGatesPass(job)) return;
    const review = job.review;
    if (review?.headSha === headSha && ['started', 'approved', 'changes_required', 'blocked'].includes(review.outcome)) return;
    const reviewTasks = job.tasks.filter(task => task.agentName === 'reviewer' && task.reviewHeadSha === headSha);
    if (reviewTasks.some(task => ['QUEUED', 'READY', 'RUNNING', 'WAITING'].includes(task.state))) return;
    if (reviewTasks.some(task => task.state === 'SUCCEEDED' && review?.headSha === headSha && review.outcome === 'approved')) return;
    const id = `final-review-${headSha.slice(0, 12)}`;
    const now = new Date().toISOString();
    const task: Task = { jobId: job.id, id, kind: 'work', priority: job.priority, projectName: job.title, agentName: 'reviewer', parentTaskId: null, dependencies: job.tasks.filter(item => item.agentName !== 'reviewer' && !this.isSupersededTask(item)).map(item => item.id), capabilities: ['review'], adapter: this.options.reviewer?.adapter ?? 'codex', input: `Review PR #${job.prNumber} at head SHA ${headSha}. Objective: ${job.objective ?? job.description ?? job.title}. First publish task.started as the worker start acknowledgement with data.worker_owned=true, then verify the deterministic pre-review gates have passed and inspect the completed work. Emit review.started, then exactly one of review.approved, review.changes_required, or review.blocked with data.review.headSha set to ${headSha}. Do not modify code and do not merge.`, output: { kind: 'task_pr' }, routing: this.options.reviewer?.routing, continuation: null, continuationDeliveredAt: null, reviewHeadSha: headSha, state: 'QUEUED', attempt: 0, maxAttempts: this.options.reviewer?.maxAttempts ?? 2, leaseOwner: null, leaseExpiresAt: null, executionId: null, threadId: null, result: null, plannerResult: null, error: null, timeoutMs: this.options.reviewer?.timeoutMs ?? 300000, createdAt: now, updatedAt: now };
    await this.store.appendTask(task);
    job.review = { outcome: 'pending', headSha, taskId: id, evidence: null, updatedAt: now };
    job.state = 'RUNNING'; job.updatedAt = now;
    await this.store.saveJob(job);
    await this.emit(eventFor(job.id, id, null, 'review.created', 'queued', `Final review task ${id} created for ${headSha}`, 'orchestrator', { headSha, agentName: 'reviewer' }));
    const ready = schedule(await this.store.load(job.id));
    await this.store.saveJob(ready);
    const reviewTask = ready.tasks.find(item => item.id === id && item.state === 'READY');
    if (reviewTask && (this.options.maxConcurrent ?? 4) > this.live.size + this.plannerLive.size) await this.launch(ready, reviewTask);
  }
  private isSupersededTask(task: Task): boolean {
    return task.state === 'CANCELLED' && typeof task.error === 'string' && task.error.startsWith('Superseded ');
  }
  private preReviewGatesPass(job: Job): boolean {
    return job.tasks.filter(task => task.agentName !== 'reviewer' && !this.isSupersededTask(task)).every(task => task.state === 'SUCCEEDED');
  }
  private async applyReviewEvent(event: EventRecord): Promise<void> {
    const job = await this.store.load(event.job_id);
    const task = job.tasks.find(item => item.id === event.task_id && item.agentName === 'reviewer');
    const reviewData = event.data?.review && typeof event.data.review === 'object' ? event.data.review as Record<string, unknown> : undefined;
    const headSha = typeof reviewData?.headSha === 'string' ? reviewData.headSha : typeof event.data?.headSha === 'string' ? event.data.headSha : task?.reviewHeadSha;
    if (!task || !headSha || task.reviewHeadSha !== headSha) return;
    const outcome: ReviewOutcome = event.type === 'review.started' ? 'started' : event.type === 'review.approved' ? 'approved' : event.type === 'review.changes_required' ? 'changes_required' : 'blocked';
    const currentHeadSha = await this.store.headSha?.();
    if ((currentHeadSha && currentHeadSha !== headSha) || (job.headSha && job.headSha !== headSha)) return;
    const evidence = { summary: event.message || `Review ${outcome}`, data: { ...(event.data ?? {}), review: reviewData ?? { headSha }, headSha, outcome } };
    job.review = { outcome, headSha, taskId: task.id, evidence, updatedAt: event.timestamp || new Date().toISOString() };
    job.updatedAt = job.review.updatedAt;
    await this.store.saveJob(job);
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
        task.error = expired ? 'Lease expired after maximum attempts' : 'Execution owner restarted after maximum attempts';
        task.leaseOwner = null;
        task.leaseExpiresAt = null;
        transitionTask(task, 'FAILED');
        await this.store.saveTask(task);
        await this.emit(eventFor(job.id, task.id, task.parentTaskId, 'task.failed', 'failed', task.error, 'user', { reason: expired ? 'lease_expired' : 'execution_owner_lost' }));
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
  private async launch(job: Job, task: Task): Promise<void> {
    const adapter = this.options.adapters.find(x => x.name === task.adapter);
    if (!adapter) {
      transitionTask(task, 'FAILED');
      task.error = `No adapter ${task.adapter}`;
      await this.store.saveTask(task);
      return;
    }
    if (['codex', 'chatgpt'].includes(task.adapter) && !this.options.eventBus) {
      transitionTask(task, 'BLOCKED');
      task.error = 'Model-backed tasks require an event bus for authoritative lifecycle state';
      await this.store.saveTask(task);
      return;
    }
    let workerInput: string;
    try {
      workerInput = managedWorkerInput(job, task);
    } catch (error) {
      transitionTask(task, 'BLOCKED');
      task.error = error instanceof Error ? error.message : String(error);
      await this.store.saveTask(task);
      return;
    }
    const leaseMs = Math.max(this.options.leaseMs ?? 300000, task.timeoutMs);
    const startedAt = (this.options.now ?? new Date()).getTime();
    transitionTask(task, 'RUNNING');
    task.attempt += 1;
    task.leaseOwner = this.options.owner;
    task.leaseExpiresAt = new Date(startedAt + leaseMs).toISOString();
    task.executionId = randomUUID();
    const durableExecutionId = task.executionId;
    await this.store.saveTask(task);
    const controller = new AbortController();
    let execution: Execution;
    const workerTask = { ...task, input: workerInput };
    const startAckSetup = task.adapter === 'chatgpt' ? await this.startAck(job.id, task.id, Date.now(), task.agentName === 'reviewer' ? this.options.reviewer?.startAckTimeoutMs : undefined) : null;
    const closePolicy = task.chatgptTabClosePolicy ?? this.options.chatgptTabClosePolicy ?? adapter.tabClosePolicy ?? 'after-start';
    const terminalWait = task.adapter === 'chatgpt' && closePolicy === 'after-terminal'
      ? this.terminalWait(task.id, durableExecutionId, startedAt - 1)
      : null;
    const launchContext: LaunchContext = {
      ...(startAckSetup ? { waitForWorkerStart: startAckSetup.ack } : {}),
      ...(terminalWait ? { waitForTerminal: terminalWait.promise } : {}),
    };
    try {
      execution = adapter.launch(workerTask, controller.signal, launchContext);
    } catch (error) {
      await startAckSetup?.stop();
      terminalWait?.cancel();
      await this.failLaunch(job.id, task.id, task.executionId, error instanceof Error ? error.message : String(error));
      return;
    }

    void (execution.launched ?? Promise.resolve()).then(() => this.emit(eventFor(job.id, task.id, task.parentTaskId, 'task.process.launched', 'running', `Task ${task.id} process launched`, 'user', { adapter: adapter.id, model: task.routing?.model }, { agent: 'relay', component: 'agents-relay' }))).catch(error => this.failLaunch(job.id, task.id, durableExecutionId, error instanceof Error ? error.message : String(error), 'launch'));
    if (startAckSetup) void startAckSetup.ack.finally(() => { void startAckSetup.stop(); }).catch(() => {});

    this.live.set(task.id, { jobId: job.id, taskId: task.id, executionId: durableExecutionId, execution, controller, launchBarrier: Date.now(), workerStarted: false });
    const terminalTimer = setTimeout(() => {
      this.detach(this.timeoutTask(job.id, task.id, durableExecutionId), job.id, task.id, 'worker terminal-event timeout');
    }, Math.max(1, task.timeoutMs));
    this.terminalTimers.set(task.id, terminalTimer);

    this.detach(
      execution.promise.then(
        result => this.runtimeSettled(job.id, task.id, durableExecutionId, result, null),
        error => error instanceof StartAckTimeout
          ? this.failLaunch(job.id, task.id, durableExecutionId, error.message, 'start-ack')
          : error instanceof LaunchFailure
          ? this.failLaunch(job.id, task.id, durableExecutionId, error.message, 'delivery')
          : this.runtimeSettled(job.id, task.id, durableExecutionId, null, error instanceof Error ? error.message : String(error)),
      ),
      job.id,
      task.id,
      'worker runtime completion',
    );
  }

  private async startAck(jobId: string, taskId: string, launchBarrier: number, timeoutMs = this.options.startAckTimeoutMs ?? 60000): Promise<{ ack: Promise<void>; stop: () => Promise<void> }> {
    if (!this.options.eventBus) throw new Error('Worker start acknowledgement requires an event bus');
    let resolveAck!: () => void;
    let rejectAck!: (error: Error) => void;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const ack = new Promise<void>((resolve, reject) => { resolveAck = resolve; rejectAck = reject; });
    const unsubscribe = await this.options.eventBus.subscribe(jobId, async event => {
      if (settled || event.type !== 'task.started' || event.job_id !== jobId || event.task_id !== taskId) return;
      const sourceAgent = typeof event.source?.agent === 'string' ? event.source.agent : '';
      const sourceComponent = typeof event.source?.component === 'string' ? event.source.component : '';
      const workerOwned = event.data?.worker_owned === true || ['codex', 'chatgpt'].includes(sourceAgent);
      if (!workerOwned || sourceAgent === 'relay' || sourceComponent === 'agents-relay') return;
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
    return { jobId: job.id, id: spec.id, kind: 'work', priority: spec.priority ?? job.priority, projectName: spec.projectName, agentName: spec.agentName, parentTaskId: planner.id, dependencies: spec.dependencies ?? [], capabilities: spec.capabilities ?? [], adapter: spec.adapter as Task['adapter'], input: spec.input, output: spec.output, routing: spec.routing, continuation: spec.continuation ?? null, continuationDeliveredAt: null, state: 'QUEUED', attempt: 0, maxAttempts: spec.maxAttempts ?? 3, leaseOwner: null, leaseExpiresAt: null, executionId: null, threadId: null, result: null, plannerResult: null, error: null, timeoutMs: spec.timeoutMs ?? 300000, createdAt: now, updatedAt: now };
  }
  private clearExecution(taskId: string, executionId?: string | null): void {
    const live = this.live.get(taskId);
    if (!executionId || live?.executionId === executionId) this.live.delete(taskId);
    const timer = this.terminalTimers.get(taskId);
    if (timer) clearTimeout(timer);
    this.terminalTimers.delete(taskId);
    const graceTimer = this.terminalExitGraceTimers.get(taskId);
    if (graceTimer) clearTimeout(graceTimer);
    this.terminalExitGraceTimers.delete(taskId);
  }

  private markWorkerStarted(event: EventRecord): void {
    const live = this.live.get(event.task_id);
    if (!live || event.job_id !== live.jobId) return;
    const sourceAgent = typeof event.source?.agent === 'string' ? event.source.agent : '';
    const sourceComponent = typeof event.source?.component === 'string' ? event.source.component : '';
    if (sourceAgent === 'relay' || sourceComponent === 'agents-relay') return;
    if (event.timestamp && new Date(event.timestamp).getTime() < live.launchBarrier) return;
    live.workerStarted = true;
  }

  private async failLaunch(jobId: string, taskId: string, executionId: string | null, message: string, phase: 'launch' | 'delivery' | 'start-ack' = 'launch'): Promise<void> {
    const claim = executionId ?? `${jobId}:${taskId}`;
    if (this.launchFailureClaims.has(claim)) return;
    this.launchFailureClaims.add(claim);
    const cleanup = setTimeout(() => this.launchFailureClaims.delete(claim), 60000);
    cleanup.unref();
    const job = await this.store.load(jobId);
    const task = job.tasks.find(item => item.id === taskId);
    if (!task || task.executionId !== executionId || task.state !== 'RUNNING') return;
    const event = eventFor(jobId, taskId, task.parentTaskId, 'task.failed', 'failed', `Worker ${phase} failed: ${message}`, 'user', { phase, reason: phase === 'start-ack' ? 'worker_start_timeout' : undefined }, { agent: 'relay', component: 'agents-relay', watchdog: true });
    await this.applyTerminalEvent(event);
    await this.emit(event);
  }

  private async runtimeSettled(jobId: string, taskId: string, executionId: string, result: Task['result'], error: string | null): Promise<void> {
    const live = this.live.get(taskId);
    const workerStarted = live?.executionId === executionId && live.workerStarted;
    if (live?.executionId === executionId) this.live.delete(taskId);
    const job = await this.store.load(jobId);
    const task = job.tasks.find(item => item.id === taskId);
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
    if (task.state === 'RUNNING' && task.adapter === 'codex') this.scheduleUnexpectedExit(jobId, taskId, executionId, workerStarted === true);
  }

  private scheduleUnexpectedExit(jobId: string, taskId: string, executionId: string, workerStarted: boolean): void {
    const graceMs = Math.max(1, this.options.terminalExitGraceMs ?? 1000);
    const timer = setTimeout(() => {
      this.terminalExitGraceTimers.delete(taskId);
      this.detach(this.failUnexpectedExit(jobId, taskId, executionId, workerStarted), jobId, taskId, 'unexpected worker process exit');
    }, graceMs);
    this.terminalExitGraceTimers.set(taskId, timer);
  }

  private async failUnexpectedExit(jobId: string, taskId: string, executionId: string, workerStarted: boolean): Promise<void> {
    const job = await this.store.load(jobId);
    const task = job.tasks.find(item => item.id === taskId);
    if (!task || task.executionId !== executionId || task.state !== 'RUNNING') return;
    const reason = workerStarted ? 'worker_exit_without_terminal_event' : 'worker_exit_before_start';
    const message = workerStarted
      ? `Worker ${taskId} exited after task.started without publishing a terminal task event`
      : `Worker ${taskId} exited before publishing task.started`;
    const event = eventFor(jobId, taskId, task.parentTaskId, 'task.failed', 'failed', message, 'user', { reason, terminalGraceMs: this.options.terminalExitGraceMs ?? 1000 }, { agent: 'relay', component: 'agents-relay', watchdog: true });
    await this.applyTerminalEvent(event);
    await this.emit(event);
  }

  private async timeoutTask(jobId: string, taskId: string, executionId: string): Promise<void> {
    const live = this.live.get(taskId);
    if (live?.executionId === executionId) {
      live.controller.abort();
      live.execution.cancel();
    }
    const job = await this.store.load(jobId);
    const task = job.tasks.find(item => item.id === taskId);
    if (!task || task.executionId !== executionId || task.state !== 'RUNNING') {
      this.clearExecution(taskId, executionId);
      return;
    }
    const event = eventFor(jobId, taskId, task.parentTaskId, 'task.failed', 'failed', `Task ${taskId} timed out waiting for the mandatory terminal worker event`, 'user', { reason: 'terminal_event_timeout', timeoutMs: task.timeoutMs });
    await this.applyTerminalEvent(event);
    await this.emit(event);
  }

  private async applyTerminalEvent(event: EventRecord): Promise<void> {
    const job = await this.store.load(event.job_id);
    const task = job.tasks.find(item => item.id === event.task_id);
    if (!task || !['codex', 'chatgpt'].includes(task.adapter) || task.state !== 'RUNNING') return;
    const terminalWaiter = this.terminalWaiters.get(task.id);
    if (terminalWaiter && (!event.timestamp || new Date(event.timestamp).getTime() < terminalWaiter.launchBarrier)) return;
    this.clearExecution(task.id, task.executionId);
    task.leaseOwner = null;
    task.leaseExpiresAt = null;
    task.updatedAt = event.timestamp || new Date().toISOString();
    this.terminalWaiters.get(task.id)?.resolve();
    this.terminalWaiters.delete(task.id);
    if (event.type === 'task.completed') {
      task.result = { summary: event.message || `Task ${task.id} completed`, data: event.data };
      task.error = null;
      transitionTask(task, 'SUCCEEDED');
      await this.store.saveTask(task);
      await this.deliverContinuation(job, task);
    } else if (event.type === 'task.failed') {
      task.error = event.message || `Task ${task.id} failed`;
      transitionTask(task, 'FAILED');
      await this.store.saveTask(task);
    } else if (event.type === 'task.blocked') {
      task.error = event.message || `Task ${task.id} blocked`;
      transitionTask(task, 'BLOCKED');
      await this.store.saveTask(task);
    } else if (event.type === 'task.cancelled') {
      task.error = event.message || `Task ${task.id} cancelled`;
      transitionTask(task, 'CANCELLED');
      await this.store.saveTask(task);
    }
    this.detach(this.reconcile(job.id), job.id, task.id, 'terminal-event reconciliation');
  }
  private terminalWait(taskId: string, executionId: string, launchBarrier: number): { promise: Promise<void>; cancel: () => void } {
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
  return JSON.stringify({ id: left.id, input: left.input, output: left.output, priority: left.priority, projectName: left.projectName, agentName: left.agentName, dependencies: left.dependencies, capabilities: left.capabilities, adapter: left.adapter, routing: left.routing, continuation: left.continuation ?? null, maxAttempts: left.maxAttempts, timeoutMs: left.timeoutMs }) === JSON.stringify({ id: right.id, input: right.input, output: right.output, priority: right.priority, projectName: right.projectName, agentName: right.agentName, dependencies: right.dependencies, capabilities: right.capabilities, adapter: right.adapter, routing: right.routing, continuation: right.continuation ?? null, maxAttempts: right.maxAttempts, timeoutMs: right.timeoutMs });
}
