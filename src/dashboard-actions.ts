import type { DurableStore } from './store.js';
import { type Job, type JobLifecycleState, type TaskState } from './types.js';
import type { Reconciler } from './reconciler.js';
import { applyJobGraphTarget, applyTaskGraphTarget } from './workflow/runtime.js';
import { jobLifecycleV2, taskLifecycleV2 } from './workflow/definitions-v2.js';
import { dispatchWorkflowTargetOverride } from './workflow/dispatcher.js';
import { dispatchTaskAction } from './task-actions.js';
import { applyJobCancelAction } from './job-actions.js';

export function dashboardTaskAction(
  store: DurableStore,
  reconciler: Reconciler,
  action: 'retry' | 'cancel',
): (jobId: string, taskId: string) => Promise<Job> {
  return async (jobId: string, taskId: string): Promise<Job> => {
    const job = await store.load(jobId);
    const task = job.tasks.find(item => item.id === taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (action === 'retry') {
      await dispatchTaskAction(store, { id: 'task.retry', jobId, taskId });
    } else {
      await dispatchTaskAction(store, { id: 'task.cancel', jobId, taskId });
    }
    return await reconciler.wake(job.id);
  };
}


export function dashboardJobSetState(store: DurableStore): (jobId: string, state: JobLifecycleState) => Promise<Job> {
  return async (jobId: string, state: JobLifecycleState): Promise<Job> => {
    const job = await store.load(jobId);
    if (state === 'CANCELLED') {
      if (job.state !== 'CANCELLED') await applyJobCancelAction(store, job);
      if (!job.localMerge?.sourceRef) await store.closePullRequest?.();
      return await store.load(job.id);
    }
    if (job.state === state) return job;
    await dispatchWorkflowTargetOverride(jobLifecycleV2, {
      currentState: job.state, targetState: state, kind: 'job',
      persistTransition: async (_from, target) => { applyJobGraphTarget(job, target as JobLifecycleState); await store.saveJob(job); },
    });
    return await store.load(job.id);
  };
}

export function dashboardTaskSetState(store: DurableStore): (jobId: string, taskId: string, state: TaskState) => Promise<Job> {
  return async (jobId: string, taskId: string, state: TaskState): Promise<Job> => {
    const job = await store.load(jobId);
    const task = job.tasks.find(item => item.id === taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.state === state) return job;
    if (task.state === 'BLOCKED' && state !== 'CANCELLED') throw new Error(`Task ${task.id} is BLOCKED; only authoritative unblock may resume it`);

    const now = new Date().toISOString();
    const from = task.state;
    await dispatchWorkflowTargetOverride(taskLifecycleV2, {
      currentState: from, targetState: state, kind: 'task',
      persistTransition: (_source, target) => { applyTaskGraphTarget(task, target as TaskState, now); },
    });
    task.manualStateOverrides = [
      ...(task.manualStateOverrides ?? []),
      { from, to: state, at: now, actor: 'dashboard-user' as const },
    ].slice(-20);
    task.leaseOwner = null;
    task.leaseExpiresAt = null;
    task.executionId = null;
    await store.saveTask(task);
    return await store.load(job.id);
  };
}
