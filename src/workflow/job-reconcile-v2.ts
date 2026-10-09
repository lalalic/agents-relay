import type { Job, JobLifecycleState } from '../types.js';
import { decideJobLifecycle, dispatchJobLifecycle, type WorkflowDecision } from './lifecycle.js';

export type JobReconcileFacts = {
  jobActive: boolean;
  implementationComplete: boolean;
  headAvailable: boolean;
  deliveryReady: boolean;
};

const localFacts = (_job: Job, facts: JobReconcileFacts): Record<string, boolean> => ({
  jobActive: facts.jobActive,
  implementationComplete: facts.implementationComplete,
  headAvailable: facts.headAvailable,
  deliveryReady: facts.deliveryReady,
});

/** Local reconciliation cannot invent a completion event; local Git delivery owns it. */
export function decideJobReconcile(job: Job, facts: JobReconcileFacts): WorkflowDecision<JobLifecycleState> {
  return decideJobLifecycle(job, 'reconcile', localFacts(job, facts));
}

export async function dispatchJobReconcile(
  job: Job,
  facts: JobReconcileFacts,
  executeEffect?: (actionId: string) => void | Promise<void>,
  persist?: () => void | Promise<void>,
): Promise<WorkflowDecision<JobLifecycleState>> {
  return dispatchJobLifecycle(job, 'reconcile', localFacts(job, facts), executeEffect, persist);
}
