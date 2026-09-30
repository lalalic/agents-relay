import type { DurableStore } from './store.js';
import type { Job } from './types.js';
import { transitionJobEvent } from './scheduler.js';
import { applyTaskCancelAction } from './task-actions.js';

export const JOB_ACTIVATE_ACTION = 'job.activate' as const;
export const JOB_CANCEL_ACTION = 'job.cancel' as const;

export async function applyJobActivateAction(job: Job): Promise<Job> {
  if (job.state !== 'DRAFT') throw new Error(`Job ${job.id} is not startable (${job.state})`);
  await transitionJobEvent(job, 'activate');
  return job;
}

export async function applyJobCancelAction(store: DurableStore, job: Job, reason = 'Job cancelled'): Promise<Job> {
  if (job.state === 'COMPLETED' || job.state === 'CANCELLED') throw new Error(`Job ${job.id} is not cancellable (${job.state})`);
  for (const plan of (job.plans ?? []).filter(item => item.status === 'PLANNING')) {
    plan.status = 'FAILED'; plan.error = reason; plan.assessment = `Planning failed: ${reason}`; plan.leaseOwner = null; plan.leaseExpiresAt = null; plan.executionId = null; plan.updatedAt = new Date().toISOString();
    await store.savePlan(plan);
  }
  for (const task of job.tasks.filter(item => item.kind !== 'planner' && !['SUCCEEDED', 'UNBLOCKED', 'CANCELLED'].includes(item.state))) {
    await applyTaskCancelAction(task, reason);
    await store.saveTask(task);
  }
  await transitionJobEvent(job, 'cancel');
  await store.saveJob(job);
  return job;
}