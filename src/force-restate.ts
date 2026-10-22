import type { DurableStore } from './store.js';
import type { Job, Plan } from './types.js';
import { executeManualPlan } from './manual-plan.js';
import { decideForceRestateValidation } from './workflow/force-restate-validation-v2.js';
import { forceRestateBlocked, forceRestateConverged, forceRestateRunnable } from './force-restate-validation.js';

export async function executeForceRestate(input: {
  store: DurableStore;
  jobId: string;
  guidance?: string;
  timeoutMs: number;
  launchPlanner: (job: Job, plan: Plan) => Promise<void>;
  reconcile: (jobId: string) => Promise<Job>;
}): Promise<{ job: Job; round: Plan }> {
  const planned = await executeManualPlan(input.store, input.jobId, input.guidance, input.timeoutMs, input.launchPlanner, true);
  const reconciled = await input.reconcile(input.jobId);
  const validation = decideForceRestateValidation({
    authoritativeCompleted: reconciled.state === 'COMPLETED',
    runnableWork: forceRestateRunnable(reconciled),
    verifiedTroubleshooterBlock: forceRestateBlocked(reconciled, planned.round.id),
  });
  if (validation.accepted && validation.target === 'rejected'
    && validation.actions.some(action => action.id === 'forceRestate.rejectPlan')) {
    if (!input.store.mutateJob) throw new Error('Force Restate validation requires atomic durable SQLite mutations');
    await input.store.mutateJob(input.jobId, current => {
      const plan = (current.plans ?? []).find(item => item.id === planned.round.id);
      if (plan?.status === 'SUCCEEDED' && plan.forceRestate) {
        plan.status = 'FAILED';
        plan.error = 'Force Restate validation failed after durable Plan apply and real reconciliation';
        plan.assessment = plan.error;
        plan.updatedAt = new Date().toISOString();
      }
      return current;
    });
    await input.reconcile(input.jobId);
    throw new Error(`Force Restate validation failed after durable Plan apply and reconciliation for Job ${input.jobId}; Planner recovery was requested`);
  }
  if (!validation.accepted || !forceRestateConverged(reconciled, planned.round.id)) throw new Error(`Force Restate validation graph rejected Job ${input.jobId}`);
  return { job: reconciled, round: planned.round };
}
