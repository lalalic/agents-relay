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
import { tryTransitionTaskEvent } from './task-transitions.js';
import { applyPlannerHistoryCleanup, forceRestateConverged, objectiveSatisfiedForReview } from './force-restate-validation.js';
import { decideForceRestateValidation } from './workflow/force-restate-validation-v2.js';
import type { PlannerHistoryCleanup } from './planner-history-cleanup.js';
import { workerCandidates } from './worker-routing.js';
import { createHash } from 'node:crypto';

export class PlannerApplyValidationError extends Error {
  readonly code = 'PLAN_APPLY_VALIDATION_FAILED';
  constructor(readonly phase: 'candidate' | 'history_consistency' | 'forward_convergence' | 'fencing', readonly issues: string[], readonly retryable = phase !== 'fencing') {
    super(JSON.stringify({ code: 'PLAN_APPLY_VALIDATION_FAILED', phase, retryable, issues }));
    this.name = 'PlannerApplyValidationError';
  }
}

function candidateFingerprint(result: import('./planner.js').PlannerResult): string {
  return createHash('sha256').update(JSON.stringify(result)).digest('hex');
}

function durableJobVersion(job: Job): string {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, normalize(child)]));
    return value;
  };
  const snapshot = Object.fromEntries(Object.entries(job).filter(([key]) => key !== 'updatedAt'));
  // updatedAt is a display timestamp and can advance on heartbeat/reconcile
  // writes with no state change. The normalized content hash is the version.
  return createHash('sha256').update(JSON.stringify(normalize(snapshot))).digest('hex');
}

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
  const releaseLive = () => {
    const current = ports.live.get(planId);
    if (current?.executionId !== executionId) return;
    clearTimeout(current.timer);
    ports.live.delete(planId);
  };
  const job = await ports.store.load(jobId);
  const plan = (job.plans ?? []).find(item => item.id === planId);
  if (plan?.status === 'SUCCEEDED' && plan.appliedExecutionId === executionId && raw && !raw.cliApplied) {
    const repeated = parsePlannerResult(raw);
    if (candidateFingerprint(repeated) !== plan.appliedCandidateFingerprint) {
      releaseLive();
      throw new Error(`Plan ${planId} already committed a different candidate for execution ${executionId}`);
    }
    releaseLive();
    return;
  }
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
    const historyCleanup: PlannerHistoryCleanup[] = parsed.history_cleanup ?? [];
    const result = assignPlannerTaskIds(parsed, job.repository, job.id, plan.id);
    const executionContext = await ports.plannerContext(job, plan);
    validatePlannerHierarchy(job.tasks, result.next_tasks);
    if (!plan.forceRestate) validatePlannerResolutionMaterialization(job.tasks, result.next_tasks);
    validatePlannerLifecycleOwnership(job, result.next_tasks);
    validatePlannerProgress(job, result);
    if (result.unblocks.length > 0 && !ports.store.registerBlockerDependent) throw new Error('Durable store does not support Planner cross-Job unblock registration');
    const children = result.next_tasks.map(spec => materializePlannerChild(job, plan, spec, executionContext));
    for (const child of children) {
      const existing = job.tasks.find(item => item.id === child.id);
      if (existing && !samePlannerChildDefinition(existing, child)) throw new Error(`Planner child ${child.id} already exists with a different definition`);
    }
    const now = new Date().toISOString();
    if (!ports.store.mutateJob) throw new Error('Plan apply requires one atomic durable SQLite mutation');
    const routeCandidates = workerCandidates(ports.options.adapters, await ports.store.listAgents());
    const expectedJobVersion = durableJobVersion(job);
    const committed = await ports.store.mutateJob(job.id, current => {
      const durablePlan = (current.plans ?? []).find(item => item.id === plan.id);
      const changedKeys = Object.keys({ ...job, ...current }).filter(key => key !== 'updatedAt' && JSON.stringify(job[key as keyof Job]) !== JSON.stringify(current[key as keyof Job]));
      if (!durablePlan || durablePlan.status !== 'PLANNING' || durablePlan.executionId !== executionId
        || durablePlan.updatedAt !== plan.updatedAt || durableJobVersion(current) !== expectedJobVersion) {
        throw new PlannerApplyValidationError('fencing', [`The Job or Planner execution changed while this candidate was being validated (plan=${Boolean(durablePlan)}, status=${durablePlan?.status ?? 'missing'}, execution=${durablePlan?.executionId === executionId}, planVersion=${durablePlan?.updatedAt === plan.updatedAt}, jobVersion=${durableJobVersion(current) === expectedJobVersion}, changed=${changedKeys.join(',')}). Refresh the Planner context and retry with the active execution.`,], durablePlan?.status === 'PLANNING' && durablePlan.executionId === executionId);
      }
      const candidate = structuredClone(current);
      const candidatePlan = (candidate.plans ?? []).find(item => item.id === plan.id)!;
      const history = candidatePlan.forceRestate
        ? applyPlannerHistoryCleanup(candidate, candidatePlan.restateTaskIds ?? [], historyCleanup, now)
        : (historyCleanup.length ? { valid: false as const, issues: ['history_cleanup is only allowed for a Force Restate Plan. Remove it and submit the Plan again.'] } : { valid: true as const });
      if (history.valid && candidatePlan.forceRestate) {
        try { validatePlannerResolutionMaterialization(candidate.tasks, result.next_tasks); }
        catch (error) {
          throw new PlannerApplyValidationError('history_consistency', [error instanceof Error ? error.message : String(error)]);
        }
      }

      candidatePlan.status = 'SUCCEEDED';
      candidatePlan.objectiveStatus = result.objective_status;
      candidatePlan.plannerResult = result;
      candidatePlan.appliedCandidateFingerprint = candidateFingerprint(parsed);
      candidatePlan.assessment = result.assessment;
      candidatePlan.generatedTaskIds = result.next_tasks.map(item => item.id);
      candidatePlan.pendingUnblocks = result.unblocks.length > 0 ? structuredClone(result.unblocks) : undefined;
      candidatePlan.error = undefined;
      candidatePlan.retryFeedback = undefined;
      candidatePlan.leaseOwner = null;
      candidatePlan.leaseExpiresAt = null;
      candidatePlan.executionId = null;
      candidatePlan.appliedExecutionId = executionId ?? undefined;
      candidatePlan.updatedAt = now;
      if (candidate.changeCycle && !candidate.changeCycle.consumedByPlannerTaskId && candidatePlan.trigger.source === 'unblock') {
        candidate.changeCycle.consumedByPlannerTaskId = candidatePlan.id;
      }
      for (const child of children) {
        const spec = result.next_tasks.find(item => item.id === child.id);
        if (spec?.resolution) attachResolutionOwnership(candidate, child, spec.resolution, 'planner');
        const existing = candidate.tasks.find(item => item.id === child.id);
        if (!existing) candidate.tasks.push(structuredClone(child));
        else if (!samePlannerChildDefinition(existing, child)) throw new Error(`Planner child ${child.id} already exists with a different definition`);
      }
      const consumedUnblocks = new Set(candidatePlan.trigger.source === 'unblock' ? candidatePlan.trigger.taskIds ?? [] : []);
      for (const task of candidate.tasks) {
        if (!consumedUnblocks.has(task.id) || !task.unblock || task.state === 'CANCELLED' || candidatePlan.generatedTaskIds.includes(task.id)) continue;
        if (tryTransitionTaskEvent(task, 'cancel').accepted) {
          task.error = `Superseded by successful unblock plan ${candidatePlan.id}`;
          task.leaseOwner = null; task.leaseExpiresAt = null; task.executionId = null;
        }
      }
      activateCommittedPlannerWork(candidate);
      candidate.updatedAt = now;

      const forwardValid = forceRestateConverged(candidate, candidatePlan.id, routeCandidates);
      const decision = decideForceRestateValidation({
        forceRestateRequested: candidatePlan.forceRestate === true,
        historyConsistencyValid: history.valid,
        normalHistoryMutationAbsent: !candidatePlan.forceRestate && historyCleanup.length === 0,
        forwardConvergenceValid: forwardValid,
        objectiveSatisfied: !plan.forceRestate && objectiveSatisfiedForReview(candidate),
      });
      if (!decision.accepted) {
        throw new PlannerApplyValidationError('forward_convergence', [`Plan Apply graph rejected the candidate: ${decision.reason}.`]);
      }
      if (decision.target === 'rejected') {
        const historyRejected = decision.actions.some(action => action.id === 'plan.apply.rejectHistory');
        const issues = historyRejected && history.valid === false ? history.issues : [
          'The proposed Plan does not converge to executable, dependency-accounted work, an evidence-backed blocked Troubleshooter owned by this Plan, or a completed Job.',
          'Add a queued/running Task with an eligible worker route, make each dependency path lead to eligible work, provide the Troubleshooter evidence and unblock conditions, or preserve verified completion.',
          `Candidate work: ${candidate.tasks.filter(task => task.kind !== 'planner').map(task => `${task.id}:${task.state}/${task.adapter}${task.dependencies.length ? ` deps=${task.dependencies.join(',')}` : ''}`).join('; ') || '(none)'}. Eligible worker adapters: ${[...new Set(routeCandidates.map(item => item.adapter))].join(', ') || '(none)'}.`,
        ];
        throw new PlannerApplyValidationError(historyRejected ? 'history_consistency' : 'forward_convergence', issues);
      }
      if (!decision.actions.some(action => action.id === 'plan.apply.commit')) {
        throw new PlannerApplyValidationError('forward_convergence', ['The Plan Apply graph did not select the atomic commit action.']);
      }
      return candidate;
    });
    Object.assign(job, structuredClone(committed));
    planCommitted = true;
    // Cross-Job registrations cannot join this Job's SQLite transaction. The
    // committed Plan keeps replay intent until each external registration is
    // confirmed, so a crash or partial failure is recoverable by reconcile.
    const pendingUnblocks = await drainPlannerUnblocks(ports, job.id, plan.id);
    await ports.emit(eventFor(job.id, plan.id, null, 'planner.completed', 'succeeded', `Plan ${plan.id} completed: ${result.objective_status}`, 'orchestrator', { objective_status: result.objective_status, pendingUnblocks }));
  } catch (caught) {
    if (planCommitted) { releaseLive(); throw caught; }
    if (caught instanceof PlannerApplyValidationError) {
      if (!(cliApply && caught.retryable)) releaseLive();
      throw caught;
    }
    const message = caught instanceof Error ? caught.message : String(caught);
    const validationError = new PlannerApplyValidationError('candidate', [message, 'Correct the candidate and retry plan apply with the same active Planner execution.']);
    if (!(cliApply && validationError.retryable)) releaseLive();
    throw validationError;
  }
  releaseLive();
  if (!plan.manualPlanning) ports.detach(ports.reconcile(jobId), jobId, plan.id, 'planner follow-up reconciliation');
}

export async function launchPlanExecution(ports: PlannerRuntimePorts, job: Job, plan: Plan, waitForCompletion = false): Promise<void> {
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
  const timer = setTimeout(() => {
    controller.abort();
    if (ports.live.get(plan.id)?.executionId === executionId) ports.live.delete(plan.id);
  }, timeoutMs);
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
  if (waitForCompletion) {
    let result: import('./planner.js').PlannerResult;
    try { result = await promise; }
    catch (error) {
      await finishPlanner(ports, job.id, plan.id, executionId, error instanceof Error ? error : new Error(String(error)));
      return;
    }
    await finishPlanner(ports, job.id, plan.id, executionId, null, result);
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
