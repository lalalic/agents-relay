import type { DurableStore } from './store.js';
import type { Job, Plan } from './types.js';
import { executeManualPlan } from './manual-plan.js';

/** Force Restate is selected by the planning graph; its history and forward
 * convergence guards run inside the atomic Plan Apply action. */
export async function executeForceRestate(input: {
  store: DurableStore;
  jobId: string;
  guidance?: string;
  timeoutMs: number;
  launchPlanner: (job: Job, plan: Plan) => Promise<void>;
}): Promise<{ job: Job; round: Plan }> {
  return executeManualPlan(input.store, input.jobId, input.guidance, input.timeoutMs, input.launchPlanner, true);
}
