import type { Job, JobLifecycleState } from '../types.js';
import { decideJobLifecycle, dispatchJobLifecycle, type WorkflowDecision } from './lifecycle.js';
import { implementationComplete } from '../runtime-status.js';
import { applyHistoricalJobCompatibilityRepair } from './runtime.js';

export type JobReconcileFacts = {
  prState: string;
  headSha: string | null;
  mergeCapable: boolean;
};

function lifecycleInput(facts: JobReconcileFacts): {
  event: 'reconcile' | 'pr.merged' | 'pr.closed';
  context: Record<string, boolean>;
} {
  if (facts.prState === 'MERGED') return { event: 'pr.merged', context: {} };
  if (facts.prState === 'CLOSED') return { event: 'pr.closed', context: { notMerged: true } };
  return {
    event: 'reconcile',
    context: {
      prOpen: true,
      headAvailable: Boolean(facts.headSha),
      mergeCapable: facts.mergeCapable,
    },
  };
}

function graphFacts(job: Job, facts: JobReconcileFacts): Record<string, boolean> {
  const input = lifecycleInput(facts);
  if (input.event !== 'reconcile') return input.context;
  return {
    ...input.context,
    reviewDisabled: job.reviewEnabled === false,
    implementationComplete: implementationComplete(job),
    autoMerge: job.autoMerge !== false,
  };
}

/**
 * Historical compatibility only. Normal Job lifecycle is always decided by
 * workflow/job-lifecycle.mmd from the PR fact-derived event.
 */
function repairHistoricalTerminalState(job: Job, facts: JobReconcileFacts): JobLifecycleState | null {
  if (['DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED'].includes(job.state)) return null;
  if (facts.prState === 'MERGED') applyHistoricalJobCompatibilityRepair(job, 'COMPLETED');
  else if (facts.prState === 'CLOSED') applyHistoricalJobCompatibilityRepair(job, 'CANCELLED');
  else return null;
  return job.state;
}

export function decideJobReconcile(job: Job, facts: JobReconcileFacts): WorkflowDecision<JobLifecycleState> {
  const input = lifecycleInput(facts);
  return decideJobLifecycle(job, input.event, graphFacts(job, facts));
}


export async function dispatchJobReconcile(job: Job, facts: JobReconcileFacts, executeEffect?: (actionId:string)=>void|Promise<void>, persist?:()=>void|Promise<void>): Promise<WorkflowDecision<JobLifecycleState>> {
  const repaired = repairHistoricalTerminalState(job, facts);
  if (repaired) {
    await persist?.();
    await executeEffect?.('effect.cancelActiveTasks');
    return {
      accepted: true,
      target: repaired,
      guard: null,
      actions: ['effect.cancelActiveTasks'],
      mutations: [],
      effects: ['effect.cancelActiveTasks'],
      reason: 'accepted',
    };
  }
  const input = lifecycleInput(facts);
  return dispatchJobLifecycle(job, input.event, graphFacts(job, facts), executeEffect, persist);
}
