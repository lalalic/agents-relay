import type { DurableStore } from './store.js';
import type { Job } from './types.js';
import { transitionJobEvent } from './scheduler.js';
import { tryApplyTaskCancelAction } from './task-actions.js';

export const JOB_ACTIVATE_ACTION = 'job.activate' as const;
export const JOB_CANCEL_ACTION = 'job.cancel' as const;

async function transitionJobAction(job: Job, event: string, action: string): Promise<void> {
  try {
    await transitionJobEvent(job, event);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('No enabled workflow transition')) {
      throw new Error(`Job ${job.id} is not ${action} (${job.state})`);
    }
    throw error;
  }
}

export async function applyJobActivateAction(job: Job): Promise<Job> {
  await transitionJobAction(job, 'activate', 'startable');
  return job;
}

async function cancelActiveWork(store: DurableStore, job: Job, reason: string): Promise<void> {
  for (const plan of (job.plans ?? []).filter(item => item.status === 'PLANNING')) {
    plan.status = 'FAILED';
    plan.error = reason;
    plan.assessment = `Planning failed: ${reason}`;
    plan.leaseOwner = null;
    plan.leaseExpiresAt = null;
    plan.executionId = null;
    plan.updatedAt = new Date().toISOString();
    await store.savePlan(plan);
  }
  for (const task of job.tasks) {
    if (!tryApplyTaskCancelAction(task, reason)) continue;
    await store.saveTask(task);
  }
}

export async function applyJobCancelAction(store: DurableStore, job: Job, reason = 'Job cancelled'): Promise<Job> {
  const from = job.state;
  try {
    await transitionJobEvent(
      job,
      'cancel',
      {},
      async actionId => {
        if (actionId !== 'effect.cancelActiveTasks') throw new Error(`Unsupported job.cancel effect ${actionId}`);
        await cancelActiveWork(store, job, reason);
      },
      async () => { await store.saveJob(job); },
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('No enabled workflow transition')) {
      throw new Error(`Job ${job.id} is not cancellable (${from})`);
    }
    throw error;
  }
  return job;
}
