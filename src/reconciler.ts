import {deliverPendingEscalations} from './escalation-notifier.js';
import {createFailedPlanRecovery} from './planner-recovery.js';
import { recoverPlannerChildren } from './planner-child-recovery.js';
import { drainProductionWorkflowOutbox } from './reconciler-workflow-outbox.js';
import { cancelPausedGenerations } from './reconciler-pause.js'; import { taskCommentContext } from './task-comments.js'; import { cancelActiveTasks } from './reconciler-cancellation.js'; import { implementationComplete } from './runtime-status.js'; import { bindPlannedReviewHead } from './planned-review-head.js';import { randomUUID } from 'node:crypto'; import { Job, Plan, Task, EventRecord, Priority, storySizeTimeoutMs, taskOverallTimeoutMs, chatGptStartAckTimeoutMs } from './types.js'; import { DurableStore } from './store.js'; import { dependencyReady, refreshTaskDependencies, transitionJobEvent, transitionTaskEvent } from './task-transitions.js'; import { applyTaskCancelAction, applyTaskRetryAction } from './task-actions.js'; import { Execution, LaunchFailure, StartAckTimeout, LaunchContext } from './adapters.js'; import { eventFor } from './events.js'; import { PreSubmissionRejection } from './worker-rejection.js'; import { createPlanRound, materializePlannerChild, pendingPlan, parsePlannerResult, plannerInput, validatePlannerHierarchy, validatePlannerLifecycleOwnership, validatePlannerProgress, validatePlannerResolutionMaterialization } from './planner.js'; import { retryPendingPlannerUnblocks } from './planner-runtime.js'; import { dispatchPlannerOrchestration, plannerOrchestrationFacts } from './workflow/planner-orchestration-v2.js'; import { ExecutionContext, ExecutionRole, resolveExecutionContext } from './execution-context.js'; import { validateAgentSelection } from './agent-graph.js'; import { ReconcilerReviewBase } from './reconciler-review.js';
import { executeForceRestate } from './force-restate.js';
import { recordThreadDelivery, resolveImplementationTaskThreadDestination, prepareReviewerThreadDelivery, resolveReviewerThreadDestination } from './reviewer-thread.js'; import { executeManualPlan } from './manual-plan.js'; import { executionEventSource, type ReconcileOptions, withExecutionBoundary } from './reconciler-runtime.js'; export { executionEventSource } from './reconciler-runtime.js'; export type { ReconcileOptions } from './reconciler-runtime.js';
import { CallbackWorkflowEffectHandler } from './workflow/effects.js';
import { exhaustedTroubleshooterRecoveries, pendingTroubleshooterTasks, pendingTroubleshooterReopens, pendingTroubleshooterRetries, refreshTroubleshooterInput } from './troubleshooter.js';
import { fallbackFailedTroubleshooters, escalateExhaustedTroubleshooters } from './troubleshooter-fallback.js';import { assertCleanWorktreeAtHead, prepareManagedExecutionWorktree, taskUsesCanonicalProjectRun } from './workspace.js';
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
        if (!task || job.pause || task.state !== 'QUEUED' || task.executionId !== null) return;
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
    const scheduled = refreshTaskDependencies(await this.store.load(jobId));
    if (scheduled.pause) return scheduled;
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
    return refreshTaskDependencies(await this.store.load(jobId));
  }
  async reconcile(jobId: string): Promise<Job> {
    if (this.reconciling) return this.store.load(jobId);
    this.reconciling = true;
    try {
      let job = await this.store.load(jobId);
      await drainProductionWorkflowOutbox(this.store, this.options);
      await deliverPendingEscalations(this.store,jobId,this.options.escalationNotifier);
      job = await this.store.load(jobId);
      for (const live of [...this.live.values()]) if (live.jobId === jobId && job.tasks.some(task => task.id === live.taskId && task.state === 'BLOCKED')) this.cancelExecutionGeneration(jobId, live.taskId, live.executionId);
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
      if (job.pause) { cancelPausedGenerations(job, (taskId, executionId) => this.cancelExecutionGeneration(job.id, taskId, executionId), planId => { const live = this.plannerLive.get(planId); if (live) { clearTimeout(live.timer); live.controller.abort(); this.plannerLive.delete(planId); } }); return job; }
      if (job.state !== 'ACTIVE' && job.projectionRecovery?.status !== 'repairing') return job;
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
      for (const { original, recovery } of pendingTroubleshooterReopens(await this.store.load(jobId))) {
        await transitionTaskEvent(recovery, 'recovery.reopen', { troubleshooterRecovery: recovery.agentName === 'troubleshooter' });
        refreshTroubleshooterInput(job, original, recovery); await this.store.saveTask(recovery);
        await this.emit(eventFor(job.id, recovery.id, original.id, 'troubleshooter.reopened', 'queued', `Reusing Troubleshooter ${recovery.id} for Task ${original.id} attempt ${original.attempt}`, 'orchestrator', { originalTaskId: original.id, attempt: original.attempt }));
      }
      for (const recovery of pendingTroubleshooterTasks(await this.store.load(jobId))) {
        await this.store.appendTask(recovery);
        await this.emit(eventFor(job.id, recovery.id, recovery.parentTaskId, "troubleshooter.created", "queued", "Troubleshooter task " + recovery.id + " created for failed/blocked work", "orchestrator", { agentName: "troubleshooter", originalTaskId: recovery.parentTaskId }));
      }
      {
        const recoveryJob = await this.store.load(jobId);
        for (const { original, recovery } of pendingTroubleshooterRetries(recoveryJob)) {
          await applyTaskRetryAction(recovery);
          recovery.routing = undefined;
          recovery.workerSelection = undefined;
          await this.store.saveTask(recovery);
          await this.emit(eventFor(job.id, recovery.id, original.id, 'troubleshooter.retry_queued', 'queued',
            `Retrying failed Troubleshooter ${recovery.id} (attempt ${recovery.attempt + 1}/${recovery.maxAttempts})`,
            'orchestrator', { originalTaskId: original.id, attempt: recovery.attempt + 1, maxAttempts: recovery.maxAttempts }));
        }
        for (const id of await fallbackFailedTroubleshooters(this.store, jobId)) await this.emit(eventFor(job.id, id, null, 'troubleshooter.retry_queued', 'queued', `Alternate model fallback scheduled for ${id}`, 'orchestrator')); for (const id of await escalateExhaustedTroubleshooters(this.store, jobId)) await this.emit(eventFor(job.id, id, null, 'task.blocked', 'blocked', `Fallback exhausted: human action required for ${id}`, 'orchestrator'));
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
      let scheduled = refreshTaskDependencies(beforeSchedule);
      for (const task of scheduled.tasks) if (task.executionId && ['QUEUED', 'RUNNING'].includes(task.state)) this.armInactivityWatchdog(task, task.executionId);
      for (const task of scheduled.tasks) {
        if (taskStatesBeforeSchedule.get(task.id) !== task.state) await this.store.saveTask(task);
      }
      if (scheduled.state !== previousState) await this.store.saveJob(scheduled);
      {
        await this.ensureFinalReview(scheduled, headSha);
        scheduled = refreshTaskDependencies(await this.store.load(jobId));
      }
      scheduled = refreshTaskDependencies(await this.maybeCreatePlanner(scheduled));
      if (scheduled.state !== previousState || scheduled.updatedAt !== job.updatedAt) await this.store.saveJob(scheduled);
      scheduled = await this.dispatchExecutableTasks(jobId);
      let finalState = refreshTaskDependencies(await this.store.load(jobId));
      if (finalState.updatedAt !== scheduled.updatedAt) await this.store.saveJob(finalState);
      await this.ensureFinalReview(finalState, headSha);
      await this.dispatchExecutableTasks(jobId);
      finalState = await this.store.load(jobId);
      const localMergeCompleted = await reconcileLocalGitCompletion(this.store, finalState, headSha,
        this.options.noGitHub === true, this.options.projectPathForJob, event => this.emit(event),
        this.options.localMergeEffect ?? this.options.localMergeDelivery,
        () => (this.options.now ?? new Date()).getTime());
      await drainProductionWorkflowOutbox(this.store, this.options);
      if (localMergeCompleted) return this.store.load(jobId);
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
  async planJob(jobId: string, guidance?: string, forceRestate = false): Promise<{ job: Job; round: Plan }> {
    if (forceRestate) return executeForceRestate({ store: this.store, jobId, guidance,
      timeoutMs: this.options.plannerTimeoutMs ?? storySizeTimeoutMs('M'),
      launchPlanner: (job, plan) => this.launchPlanner(job, plan, true) });
    return executeManualPlan(this.store, jobId, guidance, this.options.plannerTimeoutMs ?? storySizeTimeoutMs('M'), (job, plan) => this.launchPlanner(job, plan, true));
  }
  private async maybeCreatePlanner(job: Job): Promise<Job> {
    // Terminal Jobs can repair projections and re-review, but must not reopen planning.
    if (job.state !== 'ACTIVE') return job;
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
      if (actionId === 'planner.createRecovery') {
        const failed=(job.plans??[]).at(-1);
        if(!failed || failed.status!=='FAILED')throw Error('Graph selected missing FAILED Plan recovery');
        const recovery=createFailedPlanRecovery(job,failed);
        await this.store.appendTask(recovery);
        await this.emit(eventFor(job.id,recovery.id,null,'troubleshooter.created','queued',
          `Troubleshooter recovery for failed Plan ${failed.id}`,'orchestrator',
          {agentName:'troubleshooter',planId:failed.id}));
        changed=true;
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
  private async recoverPlannerChildren(job:Job):Promise<void>{ return recoverPlannerChildren(this.store,job,(j,p)=>this.plannerContext(j,p)); }
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
    if (['codex', 'chatgpt', 'z'].includes(task.adapter) && !this.options.eventBus) {
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
        const routed = await this.routeTaskForExecutionFailClosed(freshJob, freshTask); if (!routed) return; freshTask = routed.task;
      }
      if (['codex', 'chatgpt', 'z'].includes(freshTask.adapter) && !freshTask.routing) {
        throw new Error('Task ' + freshTask.id + ' requires routing metadata before execution claim');
      }
      const leaseMs = Math.max(this.options.leaseMs ?? 300000, freshTask.timeoutMs);
      const startedAt = (this.options.now ?? new Date()).getTime();
      freshTask.attempt += 1;
      freshTask.leaseOwner = this.options.owner;
      freshTask.leaseExpiresAt = new Date(startedAt + leaseMs).toISOString();
      freshTask.executionId = randomUUID();
      delete freshTask.lastProgressAt; delete freshTask.lastProgressEventAt; delete freshTask.processExitedAt;
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
          jobId: freshJob.id, repository: freshJob.repository, taskId: freshTask.id, prNumber: freshJob.prNumber, executionId: freshTask.executionId,
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
          delete durable.lastProgressAt; delete durable.lastProgressEventAt; delete durable.processExitedAt;
          durable.executionHistory = [...(durable.executionHistory ?? []), {
            id: durable.executionId, attempt: durable.attempt, startedAt: new Date(startedAt).toISOString(),
          }].slice(-8);
          const implementationThread = resolveImplementationTaskThreadDestination(current, durable);
          if (durable.agentName === 'reviewer') durable.chatgptThreadDelivery = prepareReviewerThreadDelivery(current, { ...durable, routing: freshTask!.routing }, this.options.reviewer?.threadId);
          if (implementationThread && durable.adapter === 'chatgpt') {
            durable.chatgptThreadDelivery = {
              kind: 'new-turn', threadId: implementationThread, threadSource: 'implementation',
              requestId: `${current.id}:${durable.id}:${durable.executionId}`,
              jobId: current.id, repository: current.repository, taskId: durable.id, prNumber: current.prNumber, executionId: durable.executionId,
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
    if (this.store.reserveWorkflowLaunch && task.executionId && task.leaseOwner) {
      const reserved=await this.store.reserveWorkflowLaunch({jobId:job.id,taskId:task.id,executionId:task.executionId,attempt:task.attempt,leaseOwner:task.leaseOwner});
      if (!reserved) throw new Error('already reserved launch attempt: reconcile existing generation');
    }
    const adapter = this.options.adapters.find(x => x.name === task.adapter);
    if (!adapter) {
      await this.failLaunch(job.id, task.id, task.executionId, 'No adapter ' + task.adapter);
      return;
    }
    let executionContext: ExecutionContext;
    try {
      const role: ExecutionRole = task.agentName === 'reviewer' ? 'reviewer' : task.agentName === 'troubleshooter' ? 'troubleshooter' : task.parentTaskId ? 'nested-worker' : 'worker';
      const projectPath = this.options.projectPathForJob ? await this.options.projectPathForJob(job, task) : task.routing?.cwd ?? process.cwd();
      executionContext = await this.resolvedContext(job, task, role, projectPath);
    } catch (error) {
      await this.failLaunch(job.id, task.id, task.executionId, `Execution context unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const startedAt = Date.now();
    const durableExecutionId = task.executionId!;
    const controller = new AbortController();
    let execution: Execution;
    const sourceId = executionEventSource(job.id, task.id, durableExecutionId);
    let baseWorkerInput: string;
    try { baseWorkerInput = await managedWorkerInput(job, task, executionContext); }
    catch (error) {
      await this.failLaunch(job.id, task.id, task.executionId, `Execution contract unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const canonicalProjectRun = taskUsesCanonicalProjectRun(task, job.tasks);
    const workerInput = canonicalProjectRun
      ? `${baseWorkerInput}\n\n[Canonical Neo project run]\nExecution cwd: ${executionContext.project.path}\nKeep generated artifacts under runs/.`
      : baseWorkerInput;
    const workerTask = { ...task, input: workerInput + taskCommentContext(task), routing: task.routing ? { ...task.routing, cwd: executionContext.project.path } : task.routing };
    const startAckSetup = (task.adapter === 'chatgpt' || task.adapter === 'z') ? await this.startAck(job.id, task.id, sourceId, Date.now(), this.options.startAckTimeoutMs ?? chatGptStartAckTimeoutMs(task.timeoutMs)) : null;
    const closePolicy = task.chatgptTabClosePolicy ?? this.options.chatgptTabClosePolicy ?? adapter.tabClosePolicy ?? 'after-start';
    const terminalWait = (task.adapter === 'chatgpt' || task.adapter === 'z') && closePolicy === 'after-terminal' ? this.terminalWait(task.id, durableExecutionId, startedAt - 1) : null;
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
      await this.failLaunch(job.id, task.id, task.executionId, error);
      return;
    }
    void (execution.launched ?? Promise.resolve()).then(() => Promise.all([recordThreadDelivery(this.store, job.id, task.id, durableExecutionId, workerTask), this.emit(eventFor(job.id, task.id, task.parentTaskId, 'task.process.launched', 'running', `Task ${task.id} process launched`, 'user', { adapter: adapter.id, model: task.routing?.model, pid: execution.pid ?? null, executionId: durableExecutionId }, { agent: 'relay', component: 'agents-relay' }))])).catch(error => this.failLaunch(job.id, task.id, durableExecutionId, error, 'launch'));
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
    this.armInactivityWatchdog(task, durableExecutionId);
    this.detach(
      execution.promise.then(
        result => this.runtimeSettled(job.id, task.id, durableExecutionId, result, null),
        error => error instanceof StartAckTimeout
          ? this.failLaunch(job.id, task.id, durableExecutionId, error, 'start-ack')
          : error instanceof LaunchFailure || error instanceof PreSubmissionRejection
          ? this.failLaunch(job.id, task.id, durableExecutionId, error, 'delivery')
          : this.runtimeSettled(job.id, task.id, durableExecutionId, null, error instanceof Error ? error.message : String(error)),
      ),
      job.id,
      task.id,
      'worker runtime completion',
    );
  }
  async applyPlannerTree(jobId: string, planId: string, executionId: string, proposal: unknown): Promise<Plan> { const { finishPlanner, PlannerApplyValidationError } = await import('./planner-runtime.js'); const { parsePlannerResult } = await import('./planner.js'); const ports = { store:this.store, options:this.options, live:this.plannerLive, plannerContext:(job:Job,plan:Plan)=>this.plannerContext(job,plan), emit:(event:EventRecord)=>this.emit(event), detach:(promise:Promise<unknown>,id:string,task:string,label:string)=>this.detach(promise,id,task, label), reconcile:(id:string)=>this.reconcile(id) };
    let candidate; try { candidate = parsePlannerResult(proposal); } catch (error) { throw new PlannerApplyValidationError('candidate', [error instanceof Error ? error.message : String(error), 'Correct the candidate and retry plan apply with the same active Planner execution.']); } await finishPlanner(ports, jobId, planId, executionId, null, candidate, true); const updated = (await this.store.load(jobId)).plans?.find(plan => plan.id === planId); if (!updated || updated.status !== 'SUCCEEDED') throw new Error(`Plan ${planId} was not committed`); return updated;  }
  private async launchPlanner(job: Job, plan: Plan, waitForCompletion = false): Promise<void> { return launchPlanExecution({
      store: this.store,
      options: this.options,
      live: this.plannerLive,
      plannerContext: (currentJob, currentPlan) => this.plannerContext(currentJob, currentPlan), emit: event => this.emit(event),
      detach: (promise, jobId, planId, context) => this.detach(promise, jobId, planId, context), reconcile: jobId => this.reconcile(jobId),
    }, job, plan, waitForCompletion);
  }
}
