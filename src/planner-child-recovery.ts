import type {Job,Plan,Task} from './types.js';
import type {DurableStore} from './store.js';
import type {ExecutionContext} from './execution-context.js';
import {materializePlannerChild} from './planner.js';
import {attachResolutionOwnership} from './workflow/task-resolution.js';
/** Recover persisted child definitions without inventing new task identities. */
export async function recoverPlannerChildren(store:DurableStore,job:Job,plannerContext:(job:Job,planning:Plan|Task)=>Promise<ExecutionContext>):Promise<void>{
    for (const plan of (job.plans ?? []).filter(item => item.status === 'SUCCEEDED' && item.plannerResult)) {
      for (const spec of plan.plannerResult!.next_tasks) {
        // A succeeded Plan is immutable historical evidence. Existing children may
        // have accumulated execution and Resolution state since the Plan committed;
        // do not rematerialize them against today's Task states.
        if (job.tasks.some(item => item.id === spec.id)) continue;
        const executionContext = await plannerContext(job, plan);
        const child = materializePlannerChild(job, plan, spec, executionContext);
        if (spec?.resolution) await store.saveTask(attachResolutionOwnership(job, child, spec.resolution, 'planner'));
        await store.appendTask(child);
        job.tasks.push(child);
      }
    }
    const historicalPlanners = job.tasks.filter(task =>
      task.kind === 'planner' && task.state === 'SUCCEEDED' && task.plannerResult);
    if (historicalPlanners.length === 0) return;
    for (const planner of historicalPlanners) {
      const result = planner.plannerResult!;
      const plan: Plan = { jobId: job.id, id: planner.id, round: planner.planningRound ?? 1, source: planner.planningSource ?? 'model-planner', previousPlanId: planner.previousPlannerTaskId ?? null, trigger: planner.planTrigger ?? { source: 'continuation' }, status: 'SUCCEEDED', guidance: planner.plannerGuidance, objectiveStatus: result.objective_status, plannerResult: result, assessment: result.assessment, generatedTaskIds: result.next_tasks.map(item => item.id), headSha: planner.planTrigger?.currentHeadSha ?? job.headSha, attempt: planner.attempt, maxAttempts: planner.maxAttempts, leaseOwner: null, leaseExpiresAt: null, executionId: null, timeoutMs: planner.timeoutMs, manualPlanning: planner.manualPlanning, createdAt: planner.createdAt, updatedAt: planner.updatedAt };
      if (!(job.plans ?? []).some(item => item.id === plan.id)) { await store.appendPlan(plan); (job.plans ??= []).push(plan); } else continue;
      for (const spec of result.next_tasks) if (!job.tasks.some(item => item.id === spec.id)) {
        const executionContext = await plannerContext(job, planner);
        const child = materializePlannerChild(job, plan, spec, executionContext);
        if (spec?.resolution) await store.saveTask(attachResolutionOwnership(job, child, spec.resolution, 'planner'));
        await store.appendTask(child); job.tasks.push(child);
      }
    }
  }
