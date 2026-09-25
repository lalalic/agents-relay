import { randomUUID } from 'node:crypto';
import { Job, Task, EventRecord, Priority, storySizeTimeoutMs, taskOverallTimeoutMs, chatGptStartAckTimeoutMs } from './types.js';
import { DurableStore } from './store.js';
import { dependencyReady, schedule, transitionJobEvent, transitionTaskEvent } from './scheduler.js';
import { implementationComplete } from './runtime-status.js';
import { Execution, LaunchFailure, StartAckTimeout, LaunchContext } from './adapters.js';
import { eventFor } from './events.js';
import { parsePlannerResult, plannerInput, PlannerTaskSpec } from './planner.js';
import { ExecutionContext, ExecutionRole, agentContractPrompt, executionContextPrompt, resolveExecutionContext } from './execution-context.js';
import { agentGraphPrompt } from './agent-graph.js';
import { ReconcilerReviewBase } from './reconciler-review.js';
import { executionEventSource, type ReconcileOptions } from './reconciler-runtime.js';
export { executionEventSource } from './reconciler-runtime.js';
export type { ReconcileOptions } from './reconciler-runtime.js';
import { CallbackWorkflowEffectHandler } from './workflow/effects.js';
import { pendingTroubleshooterTasks } from './troubleshooter.js';

const PRIORITY_RANK: Record<Priority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

export function compareTaskPriority(a: Task, b: Task, jobPriority: Priority = 'P2'): number { const ar = PRIORITY_RANK[a.priority ?? jobPriority]; const br = PRIORITY_RANK[b.priority ?? jobPriority]; return ar - br || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id); }

export async function managedWorkerInput(job: Job, task: Task, context?: ExecutionContext): Promise<string> {
  if (!['codex', 'chatgpt'].includes(task.adapter) || !job.repository || job.prNumber <= 0) return task.input;
  const selectedAgent = task.agentName && context ? await agentContractPrompt(context, task.agentName) : '';
  const selectedGraph = task.agentGraph && context ? await agentGraphPrompt(context, task.agentGraph) : '';
  if (!task.output) throw new Error(`Task ${task.id} requires an explicit output contract`);
  if (!task.executionId) throw new Error(`Task ${task.id} requires an executionId before worker input is built`);
  const sourceId = executionEventSource(job.id, task.id, task.executionId);
  const prUrl = `https://github.com/${job.repository}/pull/${job.prNumber}`;
  const taskUrl = task.taskUrl ?? `${prUrl}#issuecomment-${task.id}`;
  const output = task.output.kind === 'file'
    ? `file\nPath: ${task.output.path}`
    : `task/PR\nPR: ${prUrl}\nTask: ${task.id}`;
  return `[Agents Relay managed task]
Job URL: ${prUrl}
Job ID: ${job.id}
Task URL: ${taskUrl}
Task ID: ${task.id}
Project: ${task.projectName ?? context?.project.name ?? 'unspecified'}

Retrieve the durable job and task from GitHub before doing the work. Use whatever GitHub access this environment provides: the URLs, a GitHub integration/tool, or GitHub CLI/API. GitHub is the source of truth for task intent and declared output.

${context ? executionContextPrompt(context) + '\n\n' : ''}${selectedAgent ? selectedAgent + '\n\n' : ''}${selectedGraph ? selectedGraph + '\n\n' : ''}Follow the resolved project instructions and Agents Relay/events-bus worker contracts.

[Output contract]
${output}

[Execution event contract — mandatory]
Use the canonical Neo events-bus with exactly Job ${job.id} and Task ${task.id}.
Your exact event source identity is: ${sourceId}
Every lifecycle event for this execution MUST set source.id to that exact string. Do not derive, rename, or replace it.
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

const taskLaunchClaims = new Set<string>();

export class Reconciler extends ReconcilerReviewBase {
  constructor(store: DurableStore, options: ReconcileOptions) {
    super(store, options);
    this.workflowEffects.register(new CallbackWorkflowEffectHandler(
      'effect.launchTask',
      async context => {
        const job = await this.store.load(context.jobId);
        const task = context.taskId ? job.tasks.find(item => item.id === context.taskId) : undefined;
        if (!task || task.state !== 'QUEUED' || task.executionId !== null) return;
        if (task.kind === 'planner') await this.launchPlanner(job, task);
        else if (task.adapter !== 'orchestrator') await this.launch(job, task);
      },
      context => `effect.launchTask:${context.jobId}:${context.taskId ?? 'task'}:${String(context.data?.attempt ?? 0)}`,
    ));
    this.workflowEffects.register(new CallbackWorkflowEffectHandler(
      'effect.cancelActiveTasks',
      async context => this.cancelActiveTasks(context.jobId, String(context.data?.reason ?? 'Job terminated')),
    ));
    this.workflowEffects.register(new CallbackWorkflowEffectHandler(
      'effect.mergePullRequest',
      async context => {
        const headSha = typeof context.data?.headSha === 'string' ? context.data.headSha : null;
        if (!headSha || !this.store.mergePullRequest) throw new Error('Pull request merge effect requires a head SHA and merge-capable store');
        await this.store.mergePullRequest(headSha);
      },
      context => `effect.mergePullRequest:${context.jobId}:${String(context.data?.headSha ?? 'missing')}`,
    ));
  }

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
        const terminalState = prState === 'MERGED' ? 'COMPLETED' : 'CANCELLED';
        if (job.state !== terminalState) {
          if (!['DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED'].includes(job.state)) {
            // Compatibility repair boundary for historical records that persisted runtime status as lifecycle.
            job.state = terminalState;
            job.updatedAt = new Date().toISOString();
            await this.store.saveJob(job);
            const outcomes = await this.workflowEffects.execute(
              ['effect.cancelActiveTasks'],
              { jobId: job.id, transitionKey: `compatibility:${prState}`, data: { reason } },
            );
            await this.applyJobEffectOutcomes(job, outcomes);
          } else {
            const decision = await transitionJobEvent(
              job,
              prState === 'MERGED' ? 'pr.merged' : 'pr.closed',
              prState === 'CLOSED' ? { notMerged: true } : {},
            );
            await this.store.saveJob(job);
            const outcomes = await this.workflowEffects.execute(
              decision.effects,
              { jobId: job.id, transitionKey: `${decision.target}:${prState}`, data: { reason } },
            );
            await this.applyJobEffectOutcomes(job, outcomes);
          }
        }
        return this.store.load(jobId);
      }
      if (job.state !== 'ACTIVE') return job;
      await this.recoverLostExecutions(job, now);
      await this.recoverPlannerChildren(job);
      for (const recovery of pendingTroubleshooterTasks(await this.store.load(jobId))) {
        await this.store.appendTask(recovery);
        await this.emit(eventFor(job.id, recovery.id, null, "troubleshooter.created", "queued", "Troubleshooter task " + recovery.id + " created for failed/blocked work", "orchestrator", { agentName: "troubleshooter" }));
      }
      await this.routeExecutableTasks(await this.store.load(jobId));
      for (const task of job.tasks) if (task.state === 'CANCELLED') { this.live.get(task.id)?.execution.cancel(); this.plannerLive.get(task.id)?.controller.abort(); }
      const beforeSchedule = await this.store.load(jobId);
      const scheduleBefore = JSON.stringify(beforeSchedule.schedule ?? null);
      let scheduled = schedule(beforeSchedule);
      if (scheduled.state !== previousState || JSON.stringify(scheduled.schedule ?? null) !== scheduleBefore) await this.store.saveJob(scheduled);
      if (prState === 'OPEN') {
        await this.ensureFinalReview(scheduled, prState, headSha);
        scheduled = schedule(await this.store.load(jobId));
      }
      if (prState === 'OPEN' && scheduled.executionMode === 'autonomous') {
        scheduled = schedule(await this.maybeCreatePlanner(scheduled));
      }
      if (scheduled.state !== previousState || scheduled.updatedAt !== job.updatedAt) await this.store.saveJob(scheduled);
      if (prState === 'OPEN') {
        for (const task of scheduled.tasks.filter(item => item.state === 'SUCCEEDED' && (item.continuation || scheduled.continuation) && !item.continuationDeliveredAt)) this.detach(this.deliverContinuation(scheduled, task), scheduled.id, task.id, 'continuation');
        const capacity = Math.max(0, (this.options.maxConcurrent ?? 4) - this.live.size - this.plannerLive.size);
        const dispatchable = scheduled.tasks
          .filter(task => task.state === 'QUEUED'
            && task.executionId === null
            && (task.kind === 'planner' || task.adapter !== 'orchestrator')
            && dependencyReady(task, new Map(scheduled.tasks.map(item => [item.id, item]))))
          .sort((a, b) => compareTaskPriority(a, b, scheduled.priority ?? 'P2'))
          .slice(0, capacity);
        for (const task of dispatchable) {
          const decision = await transitionTaskEvent(task, 'dispatch', { dispatchable: true });
          await this.store.saveTask(task);
          const outcomes = await this.workflowEffects.execute(
            decision.effects,
            {
              jobId: scheduled.id,
              taskId: task.id,
              transitionKey: `dispatch:${task.attempt}`,
              data: { attempt: task.attempt },
            },
          );
          await this.applyTaskEffectOutcomes(scheduled, task, outcomes);
        }
      }
      const finalState = schedule(await this.store.load(jobId));
      if (finalState.updatedAt !== scheduled.updatedAt) await this.store.saveJob(finalState);
      await this.ensureFinalReview(finalState, prState, headSha);
      if (prState === 'OPEN' && finalState.reviewEnabled === false && implementationComplete(finalState) && finalState.autoMerge !== false && this.store.mergePullRequest && headSha) {
        const decision = await transitionJobEvent(finalState, 'implementation.completed', { autoMerge: true });
        await this.store.saveJob(finalState);
        const outcomes = await this.workflowEffects.execute(
          decision.effects,
          { jobId: finalState.id, transitionKey: `implementation.completed:${headSha}`, data: { headSha } },
        );
        await this.applyJobEffectOutcomes(finalState, outcomes);
        if (outcomes.some(item => item.effect === 'effect.mergePullRequest' && item.status !== 'failed')) {
          await this.emit(eventFor(finalState.id, 'job', null, 'job.merged', 'succeeded', 'Completed work requested merge for PR #' + finalState.prNumber, 'user', { headSha, autoMerge: true }, { agent: 'relay', component: 'agents-relay' }));
        }
      }
      return this.store.load(jobId);
    } finally { this.reconciling = false; }
  }
  private async cancelActiveTasks(jobId: string, reason: string): Promise<void> {
    const job = await this.store.load(jobId);
    for (const task of job.tasks.filter(item => !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(item.state))) {
      this.live.get(task.id)?.execution.cancel();
      this.plannerLive.get(task.id)?.controller.abort();
      await transitionTaskEvent(task, task.state === 'RUNNING' ? 'task.cancelled' : 'cancel');
      task.error = reason;
      task.leaseOwner = null;
      task.leaseExpiresAt = null;
      task.executionId = null;
      await this.store.saveTask(task);
    }
  }

  private async recoverLostExecutions(job: Job, now: number): Promise<void> {
    for (const task of job.tasks.filter(item => item.state === 'RUNNING' || (item.state === 'QUEUED' && item.executionId !== null))) {
      const expired = task.leaseExpiresAt !== null && new Date(task.leaseExpiresAt).getTime() <= now;
      const ownerLost = task.leaseOwner !== null && task.leaseOwner !== this.options.owner;
      if (!expired && !ownerLost) continue;
      this.live.get(task.id)?.execution.cancel();
      const planner = this.plannerLive.get(task.id);
      if (planner) { clearTimeout(planner.timer); planner.controller.abort(); this.plannerLive.delete(task.id); }
      const failedEvent = task.state === 'RUNNING' ? 'task.failed' : 'fail';
      await transitionTaskEvent(task, failedEvent);
      task.error = expired ? 'Lease expired' : 'Execution owner restarted';
      task.leaseOwner = null; task.leaseExpiresAt = null; task.executionId = null;
      if (task.attempt < task.maxAttempts) {
        await transitionTaskEvent(task, 'retry');
        await this.store.saveTask(task);
      } else {
        task.error += ' after maximum attempts';
        await this.store.saveTask(task);
        await this.emit(eventFor(job.id, task.id, task.parentTaskId, 'task.failed', 'failed', task.error, 'user', { reason: expired ? 'lease_expired' : 'execution_owner_lost' }));
      }
    }
  }
  private async maybeCreatePlanner(job: Job): Promise<Job> {
    if (job.executionMode !== 'autonomous') return job;
    if (job.initialPlanning?.status === 'pending') return job;
    const allPlanners = job.tasks.filter(task => task.kind === 'planner').sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    if (allPlanners.length === 0 && job.tasks.length === 0) return job;
    const slot = job.schedule?.currentRunSlot ? Date.parse(job.schedule.currentRunSlot) : Number.NaN;
    const scopedTasks = Number.isFinite(slot) ? job.tasks.filter(task => Date.parse(task.createdAt) >= slot) : job.tasks;
    const planners = scopedTasks.filter(task => task.kind === 'planner').sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    if (planners.some(task => ['DRAFT', 'QUEUED', 'RUNNING'].includes(task.state))) return job;
    if (scopedTasks.some(task => task.state === 'FAILED' || task.state === 'BLOCKED')) return job;
    if (planners.some(task => task.state === 'FAILED' || task.state === 'BLOCKED')) return job;
    if (scopedTasks.some(task => task.kind !== 'planner' && !['SUCCEEDED', 'CANCELLED'].includes(task.state))) return job;
    if (planners.length > 0 && planners.at(-1)?.plannerResult?.objective_status === 'in_progress' && !job.tasks.some(task => task.planningDecisionId === planners.at(-1)?.id)) return job;
    const latest = planners.at(-1);
    if (latest?.plannerResult?.objective_status === 'satisfied') return job;
    if (latest && !job.schedule && job.review && job.review.outcome !== 'approved') return job;
    const previousPlanner = allPlanners.at(-1);
    const used = new Set(job.tasks.map(task => task.id));
    let number = allPlanners.length + 1;
    let id = `planner-${number}`;
    while (used.has(id)) { number += 1; id = `planner-${number}`; }
    const now = new Date().toISOString();
    const task: Task = { jobId: job.id, id, kind: 'planner', storySize: 'M', agentName: 'planner', parentTaskId: previousPlanner?.id ?? null, dependencies: [], capabilities: ['planner'], adapter: 'orchestrator', input: plannerInput({ job, tasks: job.tasks, objective: job.objective ?? job.description ?? job.title, previousPlannerTaskId: previousPlanner?.id ?? null }), continuation: null, continuationDeliveredAt: null, state: 'QUEUED', attempt: 0, maxAttempts: 3, leaseOwner: null, leaseExpiresAt: null, executionId: null, threadId: null, result: null, plannerResult: null, error: null, timeoutMs: this.options.plannerTimeoutMs ?? storySizeTimeoutMs('M'), createdAt: now, updatedAt: now, planningDecisionId: id, planningSource: 'model-planner', planningRound: allPlanners.length + 1 };
    await this.store.appendTask(task);
    await this.emit(eventFor(job.id, task.id, task.parentTaskId, 'planner.created', 'queued', `Planner task ${task.id} created`, 'orchestrator'));
    return this.store.load(job.id);
  }
  private async recoverPlannerChildren(job: Job): Promise<void> {
    for (const planner of job.tasks.filter(task => task.kind === 'planner' && task.state === 'SUCCEEDED' && task.plannerResult)) {
      const children = planner.plannerResult?.next_tasks.map(spec => this.plannerChild(job, planner, spec)) ?? [];
      for (const child of children) {
        const existing = job.tasks.find(item => item.id === child.id);
        if (existing) {
          continue;
        }
        await this.store.appendTask(child);
        job.tasks.push(child);
      }
    }
  }
  private async resolvedContext(job: Job, task: Task, role: ExecutionRole): Promise<ExecutionContext> {
    const projectPath = this.options.projectPathForJob ? await this.options.projectPathForJob(job) : task.routing?.cwd ?? process.cwd();
    return resolveExecutionContext(projectPath, role, {
      ...(this.options.executionContextRoots ?? {}),
      registeredAgents: await this.store.listAgents(),
      runtimes: this.options.adapters.map(adapter => ({ name: adapter.name, id: adapter.id, capabilities: [...adapter.capabilities] })),
    });
  }

  protected async launch(job: Job, task: Task): Promise<void> {
    const adapter = this.options.adapters.find(x => x.name === task.adapter);
    if (!adapter) {
      await transitionTaskEvent(task, 'fail');
      task.error = `No adapter ${task.adapter}`;
      await this.store.saveTask(task);
      return;
    }
    if (['codex', 'chatgpt'].includes(task.adapter) && !this.options.eventBus) {
      await transitionTaskEvent(task, 'block');
      task.error = 'Model-backed tasks require an event bus for authoritative lifecycle state';
      await this.store.saveTask(task);
      return;
    }
    let executionContext: ExecutionContext;
    try {
      const role: ExecutionRole = task.agentName === 'reviewer' ? 'reviewer' : task.agentName === 'troubleshooter' ? 'troubleshooter' : task.parentTaskId ? 'nested-worker' : 'worker';
      executionContext = await this.resolvedContext(job, task, role);

    } catch (error) {
      await transitionTaskEvent(task, 'block');
      task.error = error instanceof Error ? error.message : String(error);
      await this.store.saveTask(task);
      return;
    }
    const claimKey = `${job.repository}#${job.prNumber}:${task.id}`;
    if (taskLaunchClaims.has(claimKey)) return;
    taskLaunchClaims.add(claimKey);
    let claimedTask: Task | null = null;
    try {
      const freshJob = await this.store.load(job.id);
      const freshTask = freshJob.tasks.find(item => item.id === task.id);
      if (!freshTask || freshTask.state !== 'QUEUED' || !dependencyReady(freshTask, new Map(freshJob.tasks.map(item => [item.id, item])))) return;
      const leaseMs = Math.max(this.options.leaseMs ?? 300000, freshTask.timeoutMs);
      const startedAt = (this.options.now ?? new Date()).getTime();
      if (freshTask.executionId !== null) return;
      freshTask.attempt += 1;
      freshTask.leaseOwner = this.options.owner;
      freshTask.leaseExpiresAt = new Date(startedAt + leaseMs).toISOString();
      freshTask.executionId = randomUUID();
      await this.store.saveTask(freshTask);
      claimedTask = freshTask;
    } finally {
      taskLaunchClaims.delete(claimKey);
    }
    if (!claimedTask) return;
    task = claimedTask;
    const startedAt = Date.now();
    const durableExecutionId = task.executionId!;
    const controller = new AbortController();
    let execution: Execution;
    const sourceId = executionEventSource(job.id, task.id, durableExecutionId);
    const workerInput = await managedWorkerInput(job, task, executionContext);
    const workerTask = { ...task, input: workerInput, routing: task.routing ? { ...task.routing, cwd: task.routing.cwd ?? executionContext.project.path } : task.routing };
    const startAckSetup = task.adapter === 'chatgpt' ? await this.startAck(job.id, task.id, sourceId, Date.now(), this.options.startAckTimeoutMs ?? chatGptStartAckTimeoutMs(task.timeoutMs)) : null;
    const closePolicy = task.chatgptTabClosePolicy ?? this.options.chatgptTabClosePolicy ?? adapter.tabClosePolicy ?? 'after-start';
    const terminalWait = task.adapter === 'chatgpt' && closePolicy === 'after-terminal'
      ? this.terminalWait(task.id, durableExecutionId, startedAt - 1)
      : null;
    const launchContext: LaunchContext = {
      ...(startAckSetup ? { waitForWorkerStart: startAckSetup.ack } : {}),
      ...(terminalWait ? { waitForTerminal: terminalWait.promise } : {}),
      executionContext,
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

  private async launchPlanner(job: Job, task: Task): Promise<void> {
    const planner = this.options.planner;
    if (!planner) { task.attempt = task.maxAttempts; task.error = 'No objective planner configured'; await transitionTaskEvent(task, 'fail'); await this.store.saveTask(task); await this.emit(eventFor(job.id, task.id, task.parentTaskId, 'planner.failed', 'failed', `Planner ${task.id}: ${task.error}`, 'user')); return; }
    const startedAt = (this.options.now ?? new Date()).getTime();
    await transitionTaskEvent(task, 'task.started'); task.attempt += 1; task.leaseOwner = this.options.owner; task.leaseExpiresAt = new Date(startedAt + Math.max(this.options.leaseMs ?? 300000, task.timeoutMs)).toISOString(); task.executionId = randomUUID();
    await this.store.saveTask(task);
    await this.emit(eventFor(job.id, task.id, task.parentTaskId, 'planner.started', 'running', `Planner task ${task.id} started`, 'orchestrator'));
    const controller = new AbortController(); const executionId = task.executionId;
    const timer = setTimeout(() => controller.abort(), task.timeoutMs);
    this.plannerLive.set(task.id, { executionId: executionId as string, controller, timer });
    let promise: Promise<import('./planner.js').PlannerResult>;
    try {
      const executionContext = await this.resolvedContext(job, task, 'planner');
      promise = planner.plan({ job, tasks: job.tasks, objective: job.objective ?? job.description ?? job.title, previousPlannerTaskId: task.parentTaskId, executionContext }, controller.signal);
    }
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
      task.error = error.message; task.leaseOwner = null; task.leaseExpiresAt = null; task.executionId = null;
      await transitionTaskEvent(task, 'task.failed');
      if (task.attempt < task.maxAttempts) await transitionTaskEvent(task, 'retry');
      await this.store.saveTask(task);
      await this.emit(eventFor(job.id, task.id, task.parentTaskId, task.state === 'FAILED' ? 'planner.failed' : 'planner.retry', task.state === 'FAILED' ? 'failed' : 'queued', `Planner ${task.id}: ${error.message}`, 'user')); this.detach(this.reconcile(jobId), jobId, task.id, 'planner retry reconciliation'); return;
    }
    try {
      const result = parsePlannerResult(raw);
      const children = result.next_tasks.map(spec => this.plannerChild(job, task, spec));
      for (const child of children) {
        const existing = job.tasks.find(item => item.id === child.id);
        if (!existing) continue;
      }
      // Persist the completed decision before exposing executable children.
      task.plannerResult = result; task.result = { summary: result.assessment, data: { objective_status: result.objective_status, next_tasks: result.next_tasks } }; task.error = null; task.leaseOwner = null; task.leaseExpiresAt = null; task.executionId = null; await transitionTaskEvent(task, 'task.completed'); await this.store.saveTask(task);
      for (const child of children) if (!job.tasks.some(item => item.id === child.id)) await this.store.appendTask(child);
      await this.emit(eventFor(job.id, task.id, task.parentTaskId, 'planner.completed', 'succeeded', `Planner ${task.id} completed: ${result.objective_status}`, 'orchestrator', { objective_status: result.objective_status }));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (task.state === 'SUCCEEDED') {
        task.error = `Child materialization failed: ${message}`;
        await this.store.saveTask(task);
        await this.emit(eventFor(job.id, task.id, task.parentTaskId, 'planner.children_failed', 'failed', `Planner ${task.id} child materialization failed: ${message}`, 'user'));
      } else {
        task.error = message; task.leaseOwner = null; task.leaseExpiresAt = null; task.executionId = null; await transitionTaskEvent(task, 'task.failed'); if (task.attempt < task.maxAttempts) await transitionTaskEvent(task, 'retry'); await this.store.saveTask(task); await this.emit(eventFor(job.id, task.id, task.parentTaskId, task.state === 'FAILED' ? 'planner.failed' : 'planner.retry', task.state === 'FAILED' ? 'failed' : 'queued', `Planner ${task.id}: ${message}`, 'user'));
      }
    }
    this.detach(this.reconcile(jobId), jobId, task.id, 'planner follow-up reconciliation');
  }
  private plannerChild(job: Job, planner: Task, spec: PlannerTaskSpec): Task {
    const now = new Date().toISOString();
    return { jobId: job.id, id: spec.id, kind: 'work', priority: spec.priority ?? job.priority, storySize: spec.storySize ?? 'M', projectName: spec.projectName, agentName: spec.agentName, agentGraph: spec.agentGraph, parentTaskId: planner.id, dependencies: spec.dependencies ?? [], capabilities: spec.capabilities ?? [], workerRequirements: spec.workerRequirements, adapter: 'codex', input: spec.input, output: spec.output, continuation: spec.continuation ?? null, continuationDeliveredAt: null, state: (spec.dependencies?.length ?? 0) > 0 ? 'DRAFT' : 'QUEUED', attempt: 0, maxAttempts: spec.maxAttempts ?? 3, leaseOwner: null, leaseExpiresAt: null, executionId: null, threadId: null, result: null, plannerResult: null, error: null, timeoutMs: spec.timeoutMs ?? taskOverallTimeoutMs(spec.storySize ?? 'M'), createdAt: now, updatedAt: now, planningDecisionId: planner.id, planningSource: planner.planningSource ?? 'model-planner', planningRound: planner.planningRound ?? 1 };
  }
}

function samePlannerChildDefinition(left: Task, right: Task): boolean {
  return JSON.stringify({ id: left.id, input: left.input, output: left.output, priority: left.priority, storySize: left.storySize ?? 'M', projectName: left.projectName, agentName: left.agentName, agentGraph: left.agentGraph, dependencies: left.dependencies, capabilities: left.capabilities, adapter: left.adapter, routing: left.routing, continuation: left.continuation ?? null, maxAttempts: left.maxAttempts, timeoutMs: left.timeoutMs }) === JSON.stringify({ id: right.id, input: right.input, output: right.output, priority: right.priority, storySize: right.storySize ?? 'M', projectName: right.projectName, agentName: right.agentName, agentGraph: right.agentGraph, dependencies: right.dependencies, capabilities: right.capabilities, adapter: right.adapter, routing: right.routing, continuation: right.continuation ?? null, maxAttempts: right.maxAttempts, timeoutMs: right.timeoutMs });
}
