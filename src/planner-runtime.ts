import { randomUUID } from 'node:crypto';
import { jobHasActiveExecution } from './job-execution-slot.js';
import type { ExecutionContext } from './execution-context.js';
import { eventFor } from './events.js';
import { materializePlannerChild, parsePlannerResult, validatePlannerHierarchy, validatePlannerLifecycleOwnership, validatePlannerProgress } from './planner.js';
import { samePlannerChildDefinition } from './planner-child.js';
import { withExecutionBoundary, type ReconcileOptions } from './reconciler-runtime.js';
import type { DurableStore } from './store.js';
import { storySizeTimeoutMs, type EventRecord, type Job, type Plan } from './types.js';

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

async function finishPlanner(
  ports: PlannerRuntimePorts,
  jobId: string,
  planId: string,
  executionId: string | null,
  error: Error | null,
  raw?: import('./planner.js').PlannerResult,
): Promise<void> {
  const live = ports.live.get(planId);
  if (live?.executionId === executionId) clearTimeout(live.timer);
  const releaseLive = () => { if (ports.live.get(planId)?.executionId === executionId) ports.live.delete(planId); };
  const job = await ports.store.load(jobId);
  const plan = (job.plans ?? []).find(item => item.id === planId);
  if (!plan || (executionId !== null && plan.executionId !== executionId)) { releaseLive(); return; }

  const failOrRetry = async (message: string): Promise<void> => {
    const attempt = plan.attempt ?? 0;
    const maxAttempts = plan.maxAttempts ?? (plan.manualPlanning ? 1 : 3);
    const retry = attempt < maxAttempts;
    plan.status = retry ? 'PLANNING' : 'FAILED';
    plan.retryFeedback = message;
    plan.error = message;
    plan.assessment = retry ? `Planning retry: ${message}` : `Planning failed: ${message}`;
    plan.leaseOwner = null;
    plan.leaseExpiresAt = null;
    plan.executionId = null;
    plan.updatedAt = new Date().toISOString();
    await ports.store.savePlan(plan);
    await ports.emit(eventFor(job.id, plan.id, null, retry ? 'planner.retry' : 'planner.failed', retry ? 'queued' : 'failed', `Planner ${plan.id}: ${message}`, 'user'));
    if (retry && !plan.manualPlanning) ports.detach(ports.reconcile(jobId), jobId, plan.id, 'planner retry reconciliation');
  };

  if (error) { await failOrRetry(error.message); releaseLive(); return; }
  try {
    const result = parsePlannerResult(raw);
    const executionContext = await ports.plannerContext(job, plan);
    validatePlannerHierarchy(job.tasks, result.next_tasks);
    validatePlannerLifecycleOwnership(job, result.next_tasks);
    validatePlannerProgress(job, result);
    if (result.unblocks.length > 0 && !ports.store.registerBlockerDependent) throw new Error('Durable store does not support Planner cross-Job unblock registration');
    for (const unblock of result.unblocks) await ports.store.registerBlockerDependent?.(job.id, unblock);
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
        if (!durablePlan || (executionId !== null && durablePlan.executionId !== executionId)) return current;
        durablePlan.status = 'SUCCEEDED';
        durablePlan.objectiveStatus = result.objective_status;
        durablePlan.plannerResult = result;
        durablePlan.assessment = result.assessment;
        durablePlan.generatedTaskIds = result.next_tasks.map(item => item.id);
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
          const existing = current.tasks.find(item => item.id === child.id);
          if (!existing) current.tasks.push(structuredClone(child));
          else if (!samePlannerChildDefinition(existing, child)) throw new Error(`Planner child ${child.id} already exists with a different definition`);
        }
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
      for (const child of children) if (!job.tasks.some(item => item.id === child.id)) await ports.store.appendTask(child);
    }
    await ports.emit(eventFor(job.id, plan.id, null, 'planner.completed', 'succeeded', `Plan ${plan.id} completed: ${result.objective_status}`, 'orchestrator', { objective_status: result.objective_status }));
  } catch (caught) {
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
    const failed = { ...plan, status: 'FAILED' as const, error: 'Planner unavailable', assessment: 'Planning failed: Planner unavailable', leaseOwner: null, leaseExpiresAt: null, executionId: null, updatedAt: new Date().toISOString() };
    await ports.store.savePlan(failed);
    await ports.emit(eventFor(job.id, plan.id, null, 'planner.failed', 'failed', `Planner ${plan.id}: Planner unavailable`, 'user'));
    return;
  }
  const claimed = await withExecutionBoundary(job.id, '__job_execution_slot__', async () => {
    const freshJob = await ports.store.load(job.id);
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
    const context = { job, tasks: job.tasks, objective: job.objective ?? job.description ?? job.title, previousPlannerTaskId: plan.previousPlanId, trigger: plan.trigger, executionContext, retryFeedback: plan.retryFeedback, guidance: plan.guidance };
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
