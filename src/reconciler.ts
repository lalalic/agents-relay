import { cancelActiveTasks } from './reconciler-cancellation.js'; import {authorizedInjection} from './e2e-injection.js'; import { implementationComplete } from './runtime-status.js'; import { bindPlannedReviewHead } from './planned-review-head.js';import { randomUUID } from 'node:crypto'; import { Job, Plan, Task, EventRecord, Priority, storySizeTimeoutMs, taskOverallTimeoutMs, chatGptStartAckTimeoutMs } from './types.js'; import { DurableStore } from './store.js'; import { dependencyReady, schedule, transitionJobEvent, transitionTaskEvent } from './scheduler.js'; import { applyTaskCancelAction, applyTaskRetryAction } from './task-actions.js'; import { Execution, LaunchFailure, StartAckTimeout, LaunchContext } from './adapters.js'; import { eventFor } from './events.js'; import { createPlanRound, materializePlannerChild, pendingPlan, parsePlannerResult, plannerInput, validatePlannerHierarchy, validatePlannerLifecycleOwnership, validatePlannerProgress, validatePlannerResolutionMaterialization } from './planner.js'; import { retryPendingPlannerUnblocks } from './planner-runtime.js'; import { dispatchPlannerOrchestration, plannerOrchestrationFacts } from './workflow/planner-orchestration-v2.js'; import { ExecutionContext, ExecutionRole, resolveExecutionContext } from './execution-context.js'; import { validateAgentSelection } from './agent-graph.js'; import { ReconcilerReviewBase } from './reconciler-review.js';
import { recordThreadDelivery, resolveImplementationTaskThreadDestination, prepareReviewerThreadDelivery, resolveReviewerThreadDestination } from './reviewer-thread.js';
import { executeManualPlan } from './manual-plan.js';
import { executionEventSource, type ReconcileOptions, withExecutionBoundary } from './reconciler-runtime.js';
export { executionEventSource } from './reconciler-runtime.js'; export type { ReconcileOptions } from './reconciler-runtime.js';
import { CallbackWorkflowEffectHandler } from './workflow/effects.js';
import { exhaustedTroubleshooterRecoveries, pendingTroubleshooterTasks } from './troubleshooter.js';
import { assertCleanWorktreeAtHead, prepareManagedExecutionWorktree, taskUsesCanonicalProjectRun } from './workspace.js';
import { cleanupMergedJobWorktree } from './job-worktree-cleanup.js';
import { jobHasActiveExecution } from './job-execution-slot.js';
import { managedWorkerInput } from './managed-worker-input.js';
import { attachResolutionOwnership } from './workflow/task-resolution.js';
export { managedWorkerInput } from './managed-worker-input.js';
import { recoverExpiredExecutions, recoverStartupOrphans as recoverStartupExecutionOrphans, type ExecutionRecoveryPorts } from './execution-recovery.js';
import { dispatchJobReconcile } from './workflow/job-reconcile-v2.js';
import { reconcileLocalGitCompletion } from './local-merge-delivery.js';
import { repairLegacyOrchestrators } from './legacy-orchestrator-repair.js';
import { launchPlanExecution } from './planner-runtime.js';
import { classifyFailure, errorMessage, observability, withObservabilityCorrelation } from './observability.js'; import { recoverInteractiveDecisions } from './interactive-resume.js';
const PRIORITY_RANK: Record<Priority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
export function compareTaskPriority(a: Task, b: Task, jobPriority: Priority = 'P2'): number { const ar = PRIORITY_RANK[a.priority ?? jobPriority]; const br = PRIORITY_RANK[b.priority ?? jobPriority]; return ar - br || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id); }
export class Reconciler extends ReconcilerReviewBase {
  constructor(store: DurableStore, options: ReconcileOptions) {
    super(store, options);
    this.workflowEffects.register(new CallbackWorkflowEffectHandler(
      'effect.launchTask',
      async context => {
        const job = await this.store.load(context.jobId);
        const task = context.taskId ? job.tasks.find(item => item.id === context.taskId) : undefined;
        if (!task || task.state !== 'QUEUED' || task.executionId !== null) return;
        if (task.kind !== 'planner' && task.adapter !== 'orchestrator') await this.launch(job, task);
      },
      context => `effect.launchTask:${context.jobId}:${context.taskId ?? 'task'}:${String(context.data?.attempt ?? 0)}`,
    ));
    this.workflowEffects.register(new CallbackWorkflowEffectHandler(
      'effect.cancelActiveTasks',
      async context => this.cancelActiveTasks(context.jobId, String(context.data?.reason ?? 'Job terminated')),
    ));
    this.workflowEffects.register(new CallbackWorkflowEffectHandler(
      'effect.cleanupJobWorktree',
      async context => cleanupMergedJobWorktree(await this.store.load(context.jobId), this.options.projectPathForJob),
      context => `effect.cleanupJobWorktree:${context.jobId}`,
    ));
  }
  private async dispatchExecutableTasks(jobId: string): Promise<Job> {
    const scheduled = schedule(await this.store.load(jobId));
    for (const task of scheduled.tasks.filter(item => item.state === 'SUCCEEDED' && (item.continuation || scheduled.continuation) && !item.continuationDeliveredAt)) {
      this.detach(this.deliverContinuation(scheduled, task), scheduled.id, task.id, 'continuation');
    }
    const capacity = Math.max(0, (this.options.maxConcurrent ?? 4) - this.live.size - this.plannerLive.size);
    const dispatchable = (jobHasActiveExecution(scheduled) ? [] : scheduled.tasks)
      .filter(task => task.state === 'QUEUED'
        && task.executionId === null
        && task.kind !== 'planner'
        && task.adapter !== 'orchestrator'
        && dependencyReady(task, new Map(scheduled.tasks.map(item => [item.id, item]))))
      .sort((a, b) => compareTaskPriority(a, b, scheduled.priority ?? 'P2'))
      .slice(0, Math.min(capacity, 1));
    for (const task of dispatchable) {
      await transitionTaskEvent(task, 'dispatch', { dispatchable: true }, async actionId => {
        const outcomes = await this.workflowEffects.execute(
          [actionId as 'effect.launchTask'],
          { jobId: scheduled.id, taskId: task.id, transitionKey: `dispatch:${task.attempt}`, data: { attempt: task.attempt } },
        );
        await this.applyTaskEffectOutcomes(scheduled, task, outcomes);
      }, async () => { await this.store.saveTask(task); });
    }
    return schedule(await this.store.load(jobId));
  }
  async reconcile(jobId: string): Promise<Job> {
    if (this.reconciling) return this.store.load(jobId);
    this.reconciling = true;
    try {
      const job = await this.store.load(jobId);
      const previousState = job.state;
      const lifecycleFingerprint = (value: Job): string => `${value.state}|${value.tasks.map(task => `${task.id}:${task.state}`).join(',')}`;
      const beforeFingerprint = lifecycleFingerprint(job);
      const headSha = await this.currentHeadSha(job);
      if (headSha && job.headSha !== headSha) {
        if (job.localMerge && job.localMerge.status !== 'succeeded') {
          job.localMerge = { ...job.localMerge, sourceSha: undefined, status: 'pending',
            error: undefined, nextAttemptAt: undefined, attempts: 0 };
        }
        job.headSha = headSha;
        job.updatedAt = new Date().toISOString();
        await this.store.saveJob(job);
      }
      await this.invalidateStaleReview(job, headSha);
      const now = (this.options.now ?? new Date()).getTime();
      if (job.state !== 'ACTIVE') return job;
      await recoverExpiredExecutions(job, now, this.executionRecoveryPorts(job));
      await repairLegacyOrchestrators(jobId, now, { store: this.store, owner: this.options.owner, emit: event => this.emit(event) });
      await recoverInteractiveDecisions(this.store, jobId);
      await this.recoverPlannerChildren(job);
      await retryPendingPlannerUnblocks({
        store: this.store,
        options: this.options,
        live: this.plannerLive,
        plannerContext: (currentJob, currentPlan) => this.plannerContext(currentJob, currentPlan),
        emit: event => this.emit(event),
        detach: (promise, currentJobId, planId, context) => this.detach(promise, currentJobId, planId, context),
        reconcile: currentJobId => this.reconcile(currentJobId),
      }, jobId);
      for (const recovery of pendingTroubleshooterTasks(await this.store.load(jobId))) {
        await this.store.appendTask(recovery);
        await this.emit(eventFor(job.id, recovery.id, null, "troubleshooter.created", "queued", "Troubleshooter task " + recovery.id + " created for failed/blocked work", "orchestrator", { agentName: "troubleshooter" }));
      }
      {
        const recoveryJob = await this.store.load(jobId);
        for (const recovery of recoveryJob.tasks) {
          if (recovery.agentName !== 'troubleshooter' || recovery.state !== 'FAILED' || recovery.attempt >= recovery.maxAttempts) continue;
          const original = recoveryJob.tasks.find(task => task.id === recovery.parentTaskId);
          if (!original || !['FAILED','BLOCKED'].includes(original.state)) continue;
          await applyTaskRetryAction(recovery);
          recovery.routing = undefined;
          recovery.workerSelection = undefined;
          await this.store.saveTask(recovery);
          await this.emit(eventFor(job.id, recovery.id, original.id, 'troubleshooter.retry_queued', 'queued',
            `Retrying failed Troubleshooter ${recovery.id} (attempt ${recovery.attempt + 1}/${recovery.maxAttempts})`,
            'orchestrator', { originalTaskId: original.id, attempt: recovery.attempt + 1, maxAttempts: recovery.maxAttempts }));
        }
        const exhaustedJob = await this.store.load(jobId);
        for (const exhausted of exhaustedTroubleshooterRecoveries(exhaustedJob)) {
          const at = new Date().toISOString();
          exhaustedJob.recoveryFailures = [...(exhaustedJob.recoveryFailures ?? []), {
            taskId: exhausted.original.id,
            recoveryTaskId: exhausted.recovery.id,
            reason: exhausted.reason,
            at,
          }];
          exhaustedJob.updatedAt = at;
          await this.store.saveJob(exhaustedJob);
          await this.emit(eventFor(job.id, exhausted.recovery.id, exhausted.original.id,
            'recovery.exhausted', 'failed',
            `Recovery exhausted for ${exhausted.original.id}: ${exhausted.reason}`,
            'user',
            { originalTaskId: exhausted.original.id, recoveryTaskId: exhausted.recovery.id, reason: exhausted.reason },
            { agent: 'relay', component: 'agents-relay' }));
        }
      }
      for (const task of job.tasks) if (task.state === 'CANCELLED') {
        this.cancelExecutionGeneration(job.id, task.id, task.executionId ?? task.executionHistory?.at(-1)?.id);
        this.plannerLive.get(task.id)?.controller.abort();
      }
      const beforeSchedule = await this.store.load(jobId);
      const taskStatesBeforeSchedule = new Map(beforeSchedule.tasks.map(task => [task.id, task.state]));
      const scheduleBefore = JSON.stringify(beforeSchedule.schedule ?? null);
      let scheduled = schedule(beforeSchedule);
      for (const task of scheduled.tasks) {
        if (taskStatesBeforeSchedule.get(task.id) !== task.state) await this.store.saveTask(task);
      }
      if (scheduled.state !== previousState || JSON.stringify(scheduled.schedule ?? null) !== scheduleBefore) await this.store.saveJob(scheduled);
      {
        await this.ensureFinalReview(scheduled, headSha);
        scheduled = schedule(await this.store.load(jobId));
      }
      if (scheduled.executionMode === 'autonomous') {
        scheduled = schedule(await this.maybeCreatePlanner(scheduled));
      }
      if (scheduled.state !== previousState || scheduled.updatedAt !== job.updatedAt) await this.store.saveJob(scheduled);
      scheduled = await this.dispatchExecutableTasks(jobId);
      let finalState = schedule(await this.store.load(jobId));
      if (finalState.updatedAt !== scheduled.updatedAt) await this.store.saveJob(finalState);
      await this.ensureFinalReview(finalState, headSha);
      await this.dispatchExecutableTasks(jobId);
      finalState = await this.store.load(jobId);
      if (await reconcileLocalGitCompletion(this.store, finalState, headSha,
        this.options.noGitHub === true, this.options.projectPathForJob)) return this.store.load(jobId);
      await dispatchJobReconcile(finalState, { jobActive: finalState.state === 'ACTIVE', implementationComplete: implementationComplete(finalState), headAvailable: Boolean(headSha), deliveryReady: finalState.localMerge?.status === 'succeeded' }, async actionId => {
        const outcomes = await this.workflowEffects.execute([actionId as 'effect.mergePullRequest' | 'effect.cancelActiveTasks' | 'effect.cleanupJobWorktree'], { jobId: finalState.id, transitionKey: `reconcile:${headSha ?? 'no-head'}`, data: { headSha } });
        await this.applyJobEffectOutcomes(finalState, outcomes);
      }, async () => { await this.store.saveJob(finalState); });
      const settled = await this.store.load(jobId);
      const changed = lifecycleFingerprint(settled) !== beforeFingerprint;
      observability().record({
        stage: 'reconcile',
        event: 'reconcile',
        level: changed ? 'info' : 'debug',
        outcome: changed ? 'succeeded' : 'noop',
        message: changed
          ? `Reconcile updated ${settled.repository}#${settled.prNumber} lifecycle`
          : `Reconcile ${settled.repository}#${settled.prNumber} made no lifecycle change`,
        correlation: { repository: settled.repository, prNumber: settled.prNumber, jobId: settled.id },
        transition: { graph: 'job-lifecycle', from: previousState, to: settled.state },
        data: { tasks: settled.tasks.length },
      });
      return settled;
    } catch (error) {
      observability().record({
        stage: 'reconcile',
        event: 'reconcile.failed',
        level: 'error',
        outcome: 'failed',
        message: `Reconcile failed for ${jobId}: ${errorMessage(error)}`,
        correlation: { jobId },
        data: { classification: classifyFailure(error).classification, reason: errorMessage(error) },
      });
      throw error;
    } finally { this.reconciling = false; }
  }
  private async cancelActiveTasks(jobId: string, reason: string): Promise<void> {
    return cancelActiveTasks(this.store, jobId, reason,
      taskId => { const live = this.plannerLive.get(taskId); if (live) { clearTimeout(live.timer); live.controller.abort(); this.plannerLive.delete(taskId); } },
      (job, taskId, executionId) => { this.cancelExecutionGeneration(job, taskId, executionId); });
  }
  private executionRecoveryPorts(job: Job): ExecutionRecoveryPorts {
    return {
      store: this.store,
      owner: this.options.owner,
      cancelGeneration: task => { this.cancelExecutionGeneration(job.id, task.id, task.executionId); },
      cancelPlanner: taskId => { const planner = this.plannerLive.get(taskId); if (planner) { clearTimeout(planner.timer); planner.controller.abort(); this.plannerLive.delete(taskId); } },
      emitFailed: async (task, reason) => { await this.emit(eventFor(job.id, task.id, task.parentTaskId, 'task.failed', 'failed', task.error ?? reason, 'user', { reason })); },
    };
  }
  async recoverLostExecutions(job: Job, now: number): Promise<void> { await recoverExpiredExecutions(job, now, this.executionRecoveryPorts(job)); }
  async recoverStartupOrphans(jobId: string): Promise<Job> {
    const job = await this.store.load(jobId);
    if (job.state === 'ACTIVE') {
      await recoverStartupExecutionOrphans(job, this.executionRecoveryPorts(job));
    }
    return this.store.load(jobId);
  }
  async planJob(jobId: string, guidance?: string): Promise<{ job: Job; round: Plan }> {
    return executeManualPlan(this.store, jobId, guidance, this.options.plannerTimeoutMs ?? storySizeTimeoutMs('M'), (job, plan) => this.launchPlanner(job, plan));
  }
  private async maybeCreatePlanner(job: Job): Promise<Job> {
    const pending = pendingPlan(job);
    const recoverable = pending && !this.plannerLive.has(pending.id)
      && (!pending.executionId || pending.leaseOwner !== this.options.owner || !pending.leaseExpiresAt || Date.parse(pending.leaseExpiresAt) <= (this.options.now ?? new Date()).getTime())
      ? pending : null;
    let changed = false;
    const decision = await dispatchPlannerOrchestration(plannerOrchestrationFacts(job, Boolean(recoverable)), async actionId => {
      if (actionId === 'planner.recoverPending') {
        if (!recoverable) throw new Error('Planner graph requested pending recovery without a recoverable Plan');
        await this.launchPlanner(job, recoverable);
        changed = true;
        return {};
      }
      if (actionId === 'planner.createRound') {
        const plan = createPlanRound(job, { timeoutMs: this.options.plannerTimeoutMs ?? storySizeTimeoutMs('M') });
        await this.store.appendPlan(plan);
        await this.emit(eventFor(job.id, plan.id, null, 'planner.created', 'queued', 'Plan ' + plan.id + ' created', 'orchestrator'));
        await this.launchPlanner(await this.store.load(job.id), plan);
        changed = true;
        return {};
      }
      throw new Error('Unsupported planner orchestration action ' + actionId);
    });
    if (!decision.accepted || !changed) return job;
    return this.store.load(job.id);
  }
  private async recoverPlannerChildren(job: Job): Promise<void> {
    for (const plan of (job.plans ?? []).filter(item => item.status === 'SUCCEEDED' && item.plannerResult)) {
      const executionContext = await this.plannerContext(job, plan);
      validatePlannerResolutionMaterialization(job.tasks, plan.plannerResult!.next_tasks);
      const children = plan.plannerResult!.next_tasks.map(spec => materializePlannerChild(job, plan, spec, executionContext));
      for (const child of children) {
        const existing = job.tasks.find(item => item.id === child.id);
        if (existing) continue;
        const spec = plan.plannerResult!.next_tasks.find(item => item.id === child.id);
        if (spec?.resolution) await this.store.saveTask(attachResolutionOwnership(job, child, spec.resolution, 'planner'));
        await this.store.appendTask(child);
        job.tasks.push(child);
      }
    }
    const historicalPlanners = job.tasks.filter(task =>
      task.kind === 'planner' && task.state === 'SUCCEEDED' && task.plannerResult);
    if (historicalPlanners.length === 0) return;
    const executionContext = await this.plannerContext(job, historicalPlanners[0]);
    for (const planner of historicalPlanners) {
      const result = planner.plannerResult!;
      const plan: Plan = { jobId: job.id, id: planner.id, round: planner.planningRound ?? 1, source: planner.planningSource ?? 'model-planner', previousPlanId: planner.previousPlannerTaskId ?? null, trigger: planner.planTrigger ?? { source: 'continuation' }, status: 'SUCCEEDED', guidance: planner.plannerGuidance, objectiveStatus: result.objective_status, plannerResult: result, assessment: result.assessment, generatedTaskIds: result.next_tasks.map(item => item.id), headSha: planner.planTrigger?.currentHeadSha ?? job.headSha, attempt: planner.attempt, maxAttempts: planner.maxAttempts, leaseOwner: null, leaseExpiresAt: null, executionId: null, timeoutMs: planner.timeoutMs, manualPlanning: planner.manualPlanning, createdAt: planner.createdAt, updatedAt: planner.updatedAt };
      if (!(job.plans ?? []).some(item => item.id === plan.id)) { await this.store.appendPlan(plan); (job.plans ??= []).push(plan); } else continue;
      const children = result.next_tasks.map(spec => materializePlannerChild(job, plan, spec, executionContext));
      for (const child of children) if (!job.tasks.some(item => item.id === child.id)) {
        const spec = result.next_tasks.find(item => item.id === child.id);
        if (spec?.resolution) await this.store.saveTask(attachResolutionOwnership(job, child, spec.resolution, 'planner'));
        await this.store.appendTask(child); job.tasks.push(child);
      }
    }
  }
  private async resolvedContext(job: Job, task: Task, role: ExecutionRole, projectPathOverride?: string): Promise<ExecutionContext> {
    const projectPath = projectPathOverride ?? (this.options.projectPathForJob ? await this.options.projectPathForJob(job) : task.routing?.cwd ?? process.cwd());
    return resolveExecutionContext(projectPath, role, {
      ...(this.options.executionContextRoots ?? {}),
      registeredAgents: await this.store.listAgents(),
      runtimes: this.options.adapters.map(adapter => ({ name: adapter.name, id: adapter.id, capabilities: [...adapter.capabilities] })),
    });
  }
  private async plannerContext(job: Job, planning: Plan | Task): Promise<ExecutionContext> {
    const routingCwd = 'routing' in planning ? planning.routing?.cwd : undefined;
    let projectPath = this.options.projectPathForJob ? await this.options.projectPathForJob(job) : routingCwd ?? process.cwd();
    return resolveExecutionContext(projectPath, 'planner', {
      ...(this.options.executionContextRoots ?? {}),
      registeredAgents: await this.store.listAgents(),
      runtimes: this.options.adapters.map(adapter => ({ name: adapter.name, id: adapter.id, capabilities: [...adapter.capabilities] })),
    });
  }
  protected async launch(job: Job, task: Task): Promise<void> {
    return withObservabilityCorrelation(
      { repository: job.repository, prNumber: job.prNumber, jobId: job.id, taskId: task.id },
      () => this.launchCorrelated(job, task),
    );
  }
  private async launchCorrelated(job: Job, task: Task): Promise<void> {
    if (['codex', 'chatgpt'].includes(task.adapter) && !this.options.eventBus) {
      await transitionTaskEvent(task, 'block');
      task.error = 'Model-backed tasks require an event bus for authoritative lifecycle state';
      await this.store.saveTask(task);
      return;
    }
    const claimedTask = await withExecutionBoundary(job.id, '__job_execution_slot__', async () => {
      const freshJob = await this.store.load(job.id);
      let freshTask = freshJob.tasks.find(item => item.id === task.id);
      if (!freshTask || freshTask.state !== 'QUEUED' || !dependencyReady(freshTask, new Map(freshJob.tasks.map(item => [item.id, item])))) return;
      if (freshTask.executionId !== null) return;
      if (jobHasActiveExecution(freshJob, { taskId: freshTask.id })) return;
      if (freshTask.agentName === 'reviewer' && freshTask.planningDecisionId && freshTask.dependencies.length) await bindPlannedReviewHead(this.store, freshTask, await this.currentHeadSha(freshJob));
      const implementationThread = resolveImplementationTaskThreadDestination(freshJob, freshTask);
      if ((!freshTask.routing || ((implementationThread || (freshTask.agentName === 'reviewer' && resolveReviewerThreadDestination(freshJob, this.options.reviewer?.threadId))) && freshTask.adapter !== 'chatgpt')) && freshTask.adapter !== 'orchestrator') {
        freshTask = (await this.routeTaskForExecution(freshJob, freshTask)).task;
      }
      if (['codex', 'chatgpt'].includes(freshTask.adapter) && !freshTask.routing) {
        throw new Error('Task ' + freshTask.id + ' requires routing metadata before execution claim');
      }
      const leaseMs = Math.max(this.options.leaseMs ?? 300000, freshTask.timeoutMs);
      const startedAt = (this.options.now ?? new Date()).getTime();
      freshTask.attempt += 1;
      freshTask.leaseOwner = this.options.owner;
      freshTask.leaseExpiresAt = new Date(startedAt + leaseMs).toISOString();
      freshTask.executionId = randomUUID();
      freshTask.executionHistory = [...(freshTask.executionHistory ?? []), {
        id: freshTask.executionId,
        attempt: freshTask.attempt,
        startedAt: new Date(startedAt).toISOString(),
      }].slice(-8);
      if (freshTask.agentName === 'reviewer') freshTask.chatgptThreadDelivery = prepareReviewerThreadDelivery(freshJob, freshTask, this.options.reviewer?.threadId);
      if (implementationThread && freshTask.adapter === 'chatgpt') {
        freshTask.chatgptThreadDelivery = {
          kind: 'new-turn', threadId: implementationThread, threadSource: 'implementation',
          requestId: `${freshJob.id}:${freshTask.id}:${freshTask.executionId}`,
          jobId: freshJob.id, prNumber: freshJob.prNumber, executionId: freshTask.executionId,
          projectId: freshTask.routing?.projectId ?? null, deliveredAt: null,
        };
      }
      if (this.store.mutateJob) {
        let claimed: Task | undefined;
        await this.store.mutateJob(job.id, current => {
          const durable = current.tasks.find(item => item.id === freshTask!.id);
          if (!durable || durable.state !== 'QUEUED' || durable.executionId !== null
            || !dependencyReady(durable, new Map(current.tasks.map(item => [item.id, item])))) return current;
          if (freshTask!.routing) durable.routing = structuredClone(freshTask!.routing);
          if (freshTask!.workerSelection) durable.workerSelection = structuredClone(freshTask!.workerSelection);
          durable.attempt += 1;
          durable.leaseOwner = this.options.owner;
          durable.leaseExpiresAt = new Date(startedAt + leaseMs).toISOString();
          durable.executionId = randomUUID();
          durable.executionHistory = [...(durable.executionHistory ?? []), {
            id: durable.executionId, attempt: durable.attempt, startedAt: new Date(startedAt).toISOString(),
          }].slice(-8);
          const implementationThread = resolveImplementationTaskThreadDestination(current, durable);
          if (durable.agentName === 'reviewer') durable.chatgptThreadDelivery = prepareReviewerThreadDelivery(current, { ...durable, routing: freshTask!.routing }, this.options.reviewer?.threadId);
          if (implementationThread && durable.adapter === 'chatgpt') {
            durable.chatgptThreadDelivery = {
              kind: 'new-turn', threadId: implementationThread, threadSource: 'implementation',
              requestId: `${current.id}:${durable.id}:${durable.executionId}`,
              jobId: current.id, prNumber: current.prNumber, executionId: durable.executionId,
              projectId: durable.routing?.projectId ?? null, deliveredAt: null,
            };
          }
          claimed = structuredClone(durable);
          return current;
        });
        return claimed;
      }
      await this.store.saveTask(freshTask);
      return freshTask;
    }) ?? null;
    if (!claimedTask) return;
    task = claimedTask;
    const adapter = this.options.adapters.find(x => x.name === task.adapter);
    if (!adapter) {
      await this.failLaunch(job.id, task.id, task.executionId, 'No adapter ' + task.adapter);
      return;
    }
    let executionContext: ExecutionContext;
    try {
      const role: ExecutionRole = task.agentName === 'reviewer' ? 'reviewer' : task.agentName === 'troubleshooter' ? 'troubleshooter' : task.parentTaskId ? 'nested-worker' : 'worker';
      let projectPath = this.options.projectPathForJob ? await this.options.projectPathForJob(job) : task.routing?.cwd ?? process.cwd();
      const canonicalProjectRun = taskUsesCanonicalProjectRun(task, job.tasks);
      executionContext = await this.resolvedContext(job, task, role, projectPath);
    } catch (error) {
      task.leaseOwner = null;
      task.leaseExpiresAt = null;
      task.executionId = null;
      await transitionTaskEvent(task, 'block');
      task.error = `Execution checkout unavailable: ${error instanceof Error ? error.message : String(error)}`;
      await this.store.saveTask(task);
      return;
    }
    const startedAt = Date.now();
    const durableExecutionId = task.executionId!;
    const controller = new AbortController();
    let execution: Execution;
    const sourceId = executionEventSource(job.id, task.id, durableExecutionId);
    const baseWorkerInput = await managedWorkerInput(job, task, executionContext);
    const canonicalProjectRun = taskUsesCanonicalProjectRun(task, job.tasks);
    const workerInput = canonicalProjectRun
      ? `${baseWorkerInput}\n\n[Canonical Neo project run]\nExecution cwd: ${executionContext.project.path}\nKeep generated artifacts under runs/.`
      : baseWorkerInput;
    const workerTask = { ...task, input: workerInput, routing: task.routing ? { ...task.routing, cwd: executionContext.project.path } : task.routing };
    const startAckSetup = task.adapter === 'chatgpt' ? await this.startAck(job.id, task.id, sourceId, Date.now(), this.options.startAckTimeoutMs ?? chatGptStartAckTimeoutMs(task.timeoutMs)) : null;
    const closePolicy = task.chatgptTabClosePolicy ?? this.options.chatgptTabClosePolicy ?? adapter.tabClosePolicy ?? 'after-start';
    const terminalWait = task.adapter === 'chatgpt' && closePolicy === 'after-terminal' ? this.terminalWait(task.id, durableExecutionId, startedAt - 1) : null;
    const declaration = authorizedInjection(job.repository, task.testInjection);
    if (task.testInjection && !declaration) {
      await this.failLaunch(job.id, task.id, durableExecutionId,
        `E2E test injection refused for repository ${job.repository}; configure E2E_REPO on relayd`, 'delivery');
      return;
    }
    const workerCheckpoint = declaration?.method === 'worker.codex.launch' || declaration?.method === 'browserWorkspace.command';
    const testInjection = workerCheckpoint && ((task.adapter === 'codex' && declaration.method === 'worker.codex.launch') || (task.adapter === 'chatgpt' && declaration.method === 'browserWorkspace.command')) ? declaration : undefined;
    if (workerCheckpoint && !testInjection) {
      await this.failLaunch(job.id, task.id, durableExecutionId,
        `E2E test injection ${declaration.method} is incompatible with adapter ${task.adapter}`, 'delivery');
      return;
    }
    if (testInjection) {
      const durable = (await this.store.load(job.id)).tasks.find(item=>item.id===task.id);
      if (!durable || durable.executionId!==durableExecutionId) return;
      delete durable.testInjection;
      durable.updatedAt = new Date(Math.max(Date.now(), Date.parse(durable.updatedAt) + 1)).toISOString();
      await this.store.saveTask(durable);
      const consumed = (await this.store.load(job.id)).tasks.find(item=>item.id===task.id);
      if (!consumed || consumed.executionId!==durableExecutionId || consumed.testInjection)
        throw new Error(`E2E injection consumption was not durably committed for ${task.id}`);
      delete task.testInjection;
    }
    const launchContext: LaunchContext = {
      ...(testInjection ? {testInjection} : {}),
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
    void (execution.launched ?? Promise.resolve()).then(() => Promise.all([recordThreadDelivery(this.store, job.id, task.id, durableExecutionId, workerTask), this.emit(eventFor(job.id, task.id, task.parentTaskId, 'task.process.launched', 'running', `Task ${task.id} process launched`, 'user', { adapter: adapter.id, model: task.routing?.model, pid: execution.pid ?? null, executionId: durableExecutionId }, { agent: 'relay', component: 'agents-relay' }))])).catch(error => this.failLaunch(job.id, task.id, durableExecutionId, error instanceof Error ? error.message : String(error), 'launch'));
    if (startAckSetup) void startAckSetup.ack.finally(() => { void startAckSetup.stop(); }).catch(() => {});
    this.live.set(task.id, { jobId: job.id, taskId: task.id, executionId: durableExecutionId, execution, controller, launchBarrier: startedAt, workerStarted: false, processSettled: false });
    this.registerExecutionOwner(job.id, task.id, durableExecutionId);
    observability().record({
      stage: 'transition', event: 'task.dispatch', outcome: 'succeeded',
      message: `Task ${task.id} dispatched to ${task.adapter}`,
      correlation: { repository: job.repository, prNumber: job.prNumber, jobId: job.id, taskId: task.id, executionId: durableExecutionId },
      transition: { graph: 'task-lifecycle', from: 'QUEUED', to: 'QUEUED', actions: ['effect.launchTask'] },
      data: { adapter: adapter.id, attempt: task.attempt, model: task.routing?.model ?? null },
    });
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
  private async launchPlanner(job: Job, plan: Plan): Promise<void> {
    return launchPlanExecution({
      store: this.store,
      options: this.options,
      live: this.plannerLive,
      plannerContext: (currentJob, currentPlan) => this.plannerContext(currentJob, currentPlan),
      emit: event => this.emit(event),
      detach: (promise, jobId, planId, context) => this.detach(promise, jobId, planId, context),
      reconcile: jobId => this.reconcile(jobId),
    }, job, plan);
  }
}
