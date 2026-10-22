import { assignPlannerTaskIds } from './planner-task-ids.js';
import { randomUUID } from 'node:crypto';
import { jobHasActiveExecution } from './job-execution-slot.js';
import type { ExecutionContext } from './execution-context.js';
import { eventFor } from './events.js';
import { materializePlannerChild, parsePlannerResult, validatePlannerHierarchy, validatePlannerLifecycleOwnership, validatePlannerProgress, validatePlannerResolutionMaterialization } from './planner.js';
import { attachResolutionOwnership } from './workflow/task-resolution.js';
import { samePlannerChildDefinition } from './planner-child.js';
import { dispatchJobLifecycleSync } from './workflow/lifecycle.js';
import { withExecutionBoundary, type ReconcileOptions } from './reconciler-runtime.js';
import type { DurableStore } from './store.js';
import { storySizeTimeoutMs, type EventRecord, type Job, type Plan } from './types.js';
import { tryTransitionTaskEvent } from './scheduler.js';

/** Activate queued planner work inside the same authoritative SQLite mutation. */
export function activateCommittedPlannerWork(job: Job): boolean {
  if (job.state !== 'DRAFT' || !job.tasks.some(item => item.state === 'QUEUED')) return false;
  const activation = dispatchJobLifecycleSync(job, 'activate');
  if (!activation.accepted) throw new Error(`Job ${job.id} activation rejected after planning`);
  return true;
}

type LivePlanner = { executionId: string; controller: AbortController; timer: NodeJS.Timeout };
export type PlannerRuntimePorts = {
  store: DurableStore;
  options: ReconcileOptions;
  live: Map<string, LivePlanner>;
  plannerContext: (job: Job, plan: Plan) => Promise<ExecutionContext>;
  emit: (event: EventRecord) => Promise<void>;
  detach: (promise: Promise<unknown>, jobId: string, planId: string, context: string) => void;
  reconcile: (jobId: string) => Promise<unknown>;
};

export async function drainPlannerUnblocks(ports: PlannerRuntimePorts, jobId: string, planId: string): Promise<string[]> {
  const job = await ports.store.load(jobId);
  const plan = (job.plans ?? []).find(item => item.id === planId);
  const pending = [...(plan?.pendingUnblocks ?? [])];
  if (!pending.length) return [];
  if (!ports.store.registerBlockerDependent) throw new Error("Blocker registration unavailable");
  // Persist only acknowledgments observed by this invocation. Subtract from
  // the latest transactional snapshot, never replace another drain's intents.
  const acknowledged = new Set<string>();
  const key = (item: (typeof pending)[number]) => JSON.stringify(item);
  for (const unblock of pending) {
    try {
      await ports.store.registerBlockerDependent(jobId, unblock);
      acknowledged.add(key(unblock));
    } catch { /* Pending intent is retained for the next reconcile. */ }
  }
  if (acknowledged.size > 0) {
    if (!ports.store.mutateJob) throw new Error('Atomic SQLite mutation is required to acknowledge planner unblocks');
    await ports.store.mutateJob(jobId, current => {
      const fresh = (current.plans ?? []).find(item => item.id === planId);
      if (fresh?.pendingUnblocks?.length) {
        const outstanding = fresh.pendingUnblocks.filter(item => !acknowledged.has(key(item)));
        if (outstanding.length) fresh.pendingUnblocks = outstanding;
        else delete fresh.pendingUnblocks;
        fresh.updatedAt = new Date().toISOString();
      }
      return current;
    });
  }
  const refreshed = await ports.store.load(jobId);
  const remaining = (refreshed.plans ?? []).find(item => item.id === planId)?.pendingUnblocks ?? [];
  return remaining.map(item => `${item.repository}#${item.prNumber}:${item.jobId}:${item.taskId}`);
}

export async function retryPendingPlannerUnblocks(ports: PlannerRuntimePorts, jobId: string): Promise<void> {
  const job = await ports.store.load(jobId);
  for (const plan of (job.plans ?? []).filter(item => item.status === 'SUCCEEDED' && (item.pendingUnblocks?.length ?? 0) > 0)) {
    await drainPlannerUnblocks(ports, jobId, plan.id);
  }
}

export async function finishPlanner(
  ports: PlannerRuntimePorts,
  jobId: string,
  planId: string,
  executionId: string | null,
  error: Error | null,
  raw?: import('./planner.js').PlannerResult,
  cliApply = false,
): Promise<void> {
  const live = ports.live.get(planId);
  if (live?.executionId === executionId) clearTimeout(live.timer);
  const releaseLive = () => { if (ports.live.get(planId)?.executionId === executionId) ports.live.delete(planId); };
  const job = await ports.store.load(jobId);
  const plan = (job.plans ?? []).find(item => item.id === planId);
  if (!plan || (plan.executionId !== executionId && !(raw?.cliApplied && plan.status === 'SUCCEEDED'))) { releaseLive(); if (cliApply) throw new Error(`Plan ${planId} is not owned by this active execution`); return; }

  const failOrRetry = async (message: string): Promise<void> => {
    let retry = false;
    let applied = false;
    const update = (fresh: Plan): void => {
      if (fresh.status !== 'PLANNING' || fresh.executionId !== executionId) return;
      const attempt = fresh.attempt ?? 0;
      const maxAttempts = fresh.maxAttempts ?? (fresh.manualPlanning ? 1 : 3);
      retry = attempt < maxAttempts && !message.startsWith('Planner JSON correction failed after one retry:');
      fresh.status = retry ? 'PLANNING' : 'FAILED';
      fresh.retryFeedback = message;
      fresh.error = message;
      fresh.assessment = retry ? `Planning retry: ${message}` : `Planning failed: ${message}`;
      fresh.leaseOwner = null;
      fresh.leaseExpiresAt = null;
      fresh.executionId = null;
      fresh.updatedAt = new Date().toISOString();
      applied = true;
    };
    if (ports.store.mutateJob) {
      await ports.store.mutateJob(jobId, current => {
        const fresh = (current.plans ?? []).find(item => item.id === planId);
        if (fresh) update(fresh);
        return current;
      });
    } else {
      const fresh = (await ports.store.load(jobId)).plans?.find(item => item.id === planId);
      if (fresh) {
        update(fresh);
        if (applied) await ports.store.savePlan(fresh);
      }
    }
    if (!applied) return;
    await ports.emit(eventFor(jobId, planId, null, retry ? 'planner.retry' : 'planner.failed', retry ? 'queued' : 'failed', `Planner ${planId}: ${message}`, 'user'));
    if (retry && !plan.manualPlanning) ports.detach(ports.reconcile(jobId), jobId, planId, 'planner retry reconciliation');
  };
  if (raw?.cliApplied) {
    if (plan.status !== 'SUCCEEDED') { releaseLive(); throw new Error(`Planner reported CLI application, but Plan ${planId} is ${plan.status}`); }
    releaseLive();
    return;
  }
  if (error) { if (cliApply) throw error; await failOrRetry(error.message); releaseLive(); return; }
  let planCommitted = false;
  try {
    const parsed = parsePlannerResult(raw);
    if (plan.forceRestate) {
      const cleanup = parsed.history_cleanup ?? [];
      const expected = new Set(plan.restateTaskIds ?? []);
      if (cleanup.length !== expected.size || cleanup.some(item => !expected.delete(item.taskId)) || expected.size) throw new Error('--force-restate requires exactly one Planner disposition for each failed Task in its durable snapshot');
      for (const item of cleanup) {
        const task = job.tasks.find(candidate => candidate.id === item.taskId);
        if (!task) throw new Error(`Clean history Task ${item.taskId} disappeared`);
        if (task.failureReason === 'worker_outcome_unknown' && item.outcome !== 'unresolved') throw new Error(`Unknown execution outcome for ${item.taskId} must remain unresolved without graph-verified proof`);
        if ((item.outcome === 'superseded' || item.outcome === 'invalid') && (task.resolutionClassification?.kind !== item.outcome || task.resolutionClassification.targetTaskId !== item.targetTaskId || task.resolutionClassification.evidence !== item.evidence || task.resolutionClassification.reason !== item.reason)) throw new Error(`Clean history classification for ${item.taskId} was not applied through task classify with matching evidence`);
        if (item.outcome === 'cancelled_review' && (task.agentName !== 'reviewer' || task.state !== 'CANCELLED')) throw new Error(`Failed review ${item.taskId} must be cancelled through task cancel before Plan apply`);
        if (item.outcome === 'unresolved' && (task.state !== 'FAILED' || task.resolutionClassification)) throw new Error(`Unresolved history item ${item.taskId} changed after Planner assessment`);
      }
    }
    const result = assignPlannerTaskIds(parsed, job.repository, job.id, plan.id);
    const executionContext = await ports.plannerContext(job, plan);
    validatePlannerHierarchy(job.tasks, result.next_tasks);
    validatePlannerResolutionMaterialization(job.tasks, result.next_tasks);
    validatePlannerLifecycleOwnership(job, result.next_tasks);
    validatePlannerProgress(job, result);
    if (result.unblocks.length > 0 && !ports.store.registerBlockerDependent) throw new Error('Durable store does not support Planner cross-Job unblock registration');
    const children = result.next_tasks.map(spec => materializePlannerChild(job, plan, spec, executionContext));
    for (const child of children) {
      const existing = job.tasks.find(item => item.id === child.id);
      if (existing && !samePlannerChildDefinition(existing, child)) throw new Error(`Planner child ${child.id} already exists with a different definition`);
    }
    const now = new Date().toISOString();
    if (ports.store.mutateJob) {
      let committedPlan = false;
      const committed = await ports.store.mutateJob(job.id, current => {
        const durablePlan = (current.plans ?? []).find(item => item.id === plan.id);
        if (!durablePlan || durablePlan.status !== 'PLANNING' || durablePlan.executionId !== executionId) return current;
        durablePlan.status = 'SUCCEEDED';
        durablePlan.objectiveStatus = result.objective_status;
        durablePlan.plannerResult = result;
        durablePlan.assessment = result.assessment;
        durablePlan.generatedTaskIds = result.next_tasks.map(item => item.id);
        durablePlan.pendingUnblocks = result.unblocks.length > 0 ? structuredClone(result.unblocks) : undefined;
        durablePlan.error = undefined;
        durablePlan.retryFeedback = undefined;
        durablePlan.leaseOwner = null;
        durablePlan.leaseExpiresAt = null;
        durablePlan.executionId = null;
        durablePlan.updatedAt = now;
        if (current.changeCycle && !current.changeCycle.consumedByPlannerTaskId && durablePlan.trigger.source === 'unblock') {
          current.changeCycle.consumedByPlannerTaskId = durablePlan.id;
        }
        for (const child of children) {
          const spec = result.next_tasks.find(item => item.id === child.id);
          if (spec?.resolution) attachResolutionOwnership(current, child, spec.resolution, 'planner');
          const existing = current.tasks.find(item => item.id === child.id);
          if (!existing) current.tasks.push(structuredClone(child));
          else if (!samePlannerChildDefinition(existing, child)) throw new Error(`Planner child ${child.id} already exists with a different definition`);
        }
        const consumedUnblocks = new Set(durablePlan.trigger.source === 'unblock' ? durablePlan.trigger.taskIds ?? [] : []);
        for (const task of current.tasks) {
          if (!consumedUnblocks.has(task.id) || !task.unblock || task.state === 'CANCELLED' || durablePlan.generatedTaskIds.includes(task.id)) continue;
          if (tryTransitionTaskEvent(task, 'cancel').accepted) {
            task.error = `Superseded by successful unblock plan ${durablePlan.id}`;
            task.leaseOwner = null; task.leaseExpiresAt = null; task.executionId = null;
          }
        }
        // Planner children are committed atomically with Job activation.
        // Otherwise the DRAFT Job is invisible to the ACTIVE-only dispatcher.
        activateCommittedPlannerWork(current);
        current.updatedAt = now;
        committedPlan = true;
        return current;
      });
      Object.assign(job, structuredClone(committed));
      if (!committedPlan) {
        releaseLive();
        return;
      }
    } else {
      plan.status = 'SUCCEEDED';
      plan.objectiveStatus = result.objective_status;
      plan.plannerResult = result;
      plan.assessment = result.assessment;
      plan.generatedTaskIds = result.next_tasks.map(item => item.id);
      plan.pendingUnblocks = result.unblocks.length > 0 ? structuredClone(result.unblocks) : undefined;
      plan.error = undefined;
      plan.retryFeedback = undefined;
      plan.leaseOwner = null;
      plan.leaseExpiresAt = null;
      plan.executionId = null;
      plan.updatedAt = now;
      await ports.store.savePlan(plan);
      if (job.changeCycle && !job.changeCycle.consumedByPlannerTaskId && plan.trigger.source === 'unblock') {
        job.changeCycle.consumedByPlannerTaskId = plan.id;
        job.updatedAt = now;
        await ports.store.saveJob(job);
      }
      const consumedUnblocks = new Set(plan.trigger.source === 'unblock' ? plan.trigger.taskIds ?? [] : []);
      for (const task of job.tasks) {
        if (!consumedUnblocks.has(task.id) || !task.unblock || task.state === 'CANCELLED' || plan.generatedTaskIds.includes(task.id)) continue;
        if (tryTransitionTaskEvent(task, 'cancel').accepted) { task.error = `Superseded by successful unblock plan ${plan.id}`; await ports.store.saveTask(task); }
      }
      for (const child of children) if (!job.tasks.some(item => item.id === child.id)) {
        const spec = result.next_tasks.find(item => item.id === child.id);
        if (spec?.resolution) await ports.store.saveTask(attachResolutionOwnership(job, child, spec.resolution, 'planner'));
        await ports.store.appendTask(child);
      }
    }
    planCommitted = true;
    // Cross-Job registrations cannot join this Job's SQLite transaction. The
    // committed Plan keeps replay intent until each external registration is
    // confirmed, so a crash or partial failure is recoverable by reconcile.
    const pendingUnblocks = await drainPlannerUnblocks(ports, job.id, plan.id);
    await ports.emit(eventFor(job.id, plan.id, null, 'planner.completed', 'succeeded', `Plan ${plan.id} completed: ${result.objective_status}`, 'orchestrator', { objective_status: result.objective_status, pendingUnblocks }));
  } catch (caught) {
    if (planCommitted) { releaseLive(); throw caught; }
    if (cliApply) throw caught;
    await failOrRetry(caught instanceof Error ? caught.message : String(caught));
    releaseLive();
    return;
  }
  releaseLive();
  if (!plan.manualPlanning) ports.detach(ports.reconcile(jobId), jobId, plan.id, 'planner follow-up reconciliation');
}

export async function launchPlanExecution(ports: PlannerRuntimePorts, job: Job, plan: Plan): Promise<void> {
  const planner = ports.options.planner;
  if (!planner) {
    let failed = false;
    if (ports.store.mutateJob) {
      await ports.store.mutateJob(job.id, current => {
        const fresh = current.plans?.find(item => item.id === plan.id);
        if (fresh?.status === 'PLANNING' && fresh.executionId === plan.executionId) {
          fresh.status = 'FAILED'; fresh.error = 'Planner unavailable';
          fresh.assessment = 'Planning failed: Planner unavailable';
          fresh.leaseOwner = null; fresh.leaseExpiresAt = null; fresh.executionId = null;
          fresh.updatedAt = new Date().toISOString(); failed = true;
        }
        return current;
      });
    } else {
      const fresh = (await ports.store.load(job.id)).plans?.find(item => item.id === plan.id);
      if (fresh?.status === 'PLANNING' && fresh.executionId === plan.executionId) {
        await ports.store.savePlan({ ...fresh, status: 'FAILED', error: 'Planner unavailable', assessment: 'Planning failed: Planner unavailable', leaseOwner: null, leaseExpiresAt: null, executionId: null, updatedAt: new Date().toISOString() });
        failed = true;
      }
    }
    if (failed) await ports.emit(eventFor(job.id, plan.id, null, 'planner.failed', 'failed', `Planner ${plan.id}: Planner unavailable`, 'user'));
    return;
  }
  const claimed = await withExecutionBoundary(job.id, '__job_execution_slot__', async () => {
    const freshJob = await ports.store.load(job.id);
    if (freshJob.pause) return null;
    const fresh = (freshJob.plans ?? []).find(item => item.id === plan.id);
    if (!fresh || fresh.status !== 'PLANNING') return null;
    // A Planner is an execution too: no overlapping worker or second Planner.
    if (jobHasActiveExecution(freshJob, { planId: fresh.id })) return null;
    const live = ports.live.get(fresh.id);
    if (fresh.executionId && fresh.leaseOwner === ports.options.owner && live?.executionId === fresh.executionId) return null;
    fresh.headSha = await ports.store.headSha?.() ?? fresh.headSha;
    if (fresh.headSha) fresh.trigger = { ...fresh.trigger, currentHeadSha: fresh.headSha };
    const startedAt = (ports.options.now ?? new Date()).getTime();
    fresh.attempt = (fresh.attempt ?? 0) + 1;
    fresh.maxAttempts ??= fresh.manualPlanning ? 1 : 3;
    fresh.timeoutMs ??= ports.options.plannerTimeoutMs ?? storySizeTimeoutMs('M');
    fresh.leaseOwner = ports.options.owner;
    fresh.leaseExpiresAt = new Date(startedAt + Math.max(ports.options.leaseMs ?? 300000, fresh.timeoutMs)).toISOString();
    fresh.executionId = randomUUID();
    fresh.updatedAt = new Date(startedAt).toISOString();
    await ports.store.savePlan(fresh);
    return fresh;
  });
  if (!claimed) return;
  plan = claimed;
  await ports.emit(eventFor(job.id, plan.id, null, 'planner.started', 'running', `Plan ${plan.id} started`, 'orchestrator'));
  const controller = new AbortController();
  const executionId = plan.executionId!;
  const timeoutMs = plan.timeoutMs ?? ports.options.plannerTimeoutMs ?? storySizeTimeoutMs('M');
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  ports.live.set(plan.id, { executionId, controller, timer });
  let promise: Promise<import('./planner.js').PlannerResult>;
  try {
    const executionContext = await ports.plannerContext(job, plan);
    const context = { planExecution: { planId: plan.id, executionId }, forceRestate: plan.forceRestate, restateTaskIds: plan.restateTaskIds, job, tasks: job.tasks, objective: job.objective ?? job.description ?? job.title, previousPlannerTaskId: plan.previousPlanId, trigger: plan.trigger, executionContext, retryFeedback: plan.retryFeedback, guidance: plan.guidance };
    promise = planner.plan(context, controller.signal);
  } catch (error) {
    await finishPlanner(ports, job.id, plan.id, executionId, error instanceof Error ? error : new Error(String(error)));
    return;
  }
  ports.detach(
    promise.then(
      result => finishPlanner(ports, job.id, plan.id, executionId, null, result),
      error => finishPlanner(ports, job.id, plan.id, executionId, error instanceof Error ? error : new Error(String(error))),
    ),
    job.id,
    plan.id,
    'planner completion',
  );
}
