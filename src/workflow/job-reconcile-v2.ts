import type { Job, JobLifecycleState } from '../types.js';
import { decideJobLifecycle, type WorkflowDecision } from './lifecycle.js';
import { implementationComplete } from '../runtime-status.js';

export type JobReconcileFacts = {
  prState: string;
  headSha: string | null;
  mergeCapable: boolean;
};

export function decideJobReconcile(job: Job, facts: JobReconcileFacts): WorkflowDecision<JobLifecycleState> {
  return decideJobLifecycle(job, 'reconcile', {
    prOpen: facts.prState === 'OPEN',
    reviewDisabled: job.reviewEnabled === false,
    implementationComplete: implementationComplete(job),
    autoMerge: job.autoMerge !== false,
    headAvailable: Boolean(facts.headSha),
    mergeCapable: facts.mergeCapable,
  });
}
