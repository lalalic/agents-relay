import type { Job, JobLifecycleState } from '../types.js';
import { decideJobLifecycle, dispatchJobLifecycle, type WorkflowDecision } from './lifecycle.js';
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


export async function dispatchJobReconcile(job: Job, facts: JobReconcileFacts, executeEffect?: (actionId:string)=>void|Promise<void>, persist?:()=>void|Promise<void>): Promise<WorkflowDecision<JobLifecycleState>> {
  return dispatchJobLifecycle(job, 'reconcile', {
    prOpen: facts.prState === 'OPEN', reviewDisabled: job.reviewEnabled === false,
    implementationComplete: implementationComplete(job), autoMerge: job.autoMerge !== false,
    headAvailable: Boolean(facts.headSha), mergeCapable: facts.mergeCapable,
  }, executeEffect, persist);
}
