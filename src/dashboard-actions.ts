import type { DurableStore } from './store.js';
import type { Job, JobLifecycleState, TaskState } from './types.js';
import type { Reconciler } from './reconciler.js';
import { transitionTaskEvent } from './scheduler.js';
import { applyJobWorkflowDecision, applyTaskWorkflowDecision } from './workflow/runtime.js';
import { dispatchTaskAction } from './task-actions.js';

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
      if (!['DRAFT', 'QUEUED', 'RUNNING', 'BLOCKED', 'FAILED'].includes(task.state)) throw new Error(`Task ${task.id} is not cancellable (${task.state})`);
      await transitionTaskEvent(task, task.state === 'RUNNING' ? 'task.cancelled' : 'cancel');
      task.error = 'Cancelled by user';
    }
    if (action === 'cancel') {
      task.leaseOwner = null;
      task.leaseExpiresAt = null;
      task.executionId = null;
      await store.saveTask(task);
    }
    return await reconciler.wake(job.id);
  };
}


export function dashboardJobSetState(store: DurableStore): (jobId: string, state: JobLifecycleState) => Promise<Job> {
  return async (jobId: string, state: JobLifecycleState): Promise<Job> => {
    const job = await store.load(jobId);
    if (job.state === state) return job;
    applyJobWorkflowDecision(job, {
      accepted: true,
      target: state,
      guard: null,
      actions: [],
      mutations: [],
      effects: [],
      reason: 'accepted',
    });
    await store.saveJob(job);
    return await store.load(job.id);
  };
}

export function dashboardTaskSetState(store: DurableStore): (jobId: string, taskId: string, state: TaskState) => Promise<Job> {
  return async (jobId: string, taskId: string, state: TaskState): Promise<Job> => {
    const job = await store.load(jobId);
    const task = job.tasks.find(item => item.id === taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.state === state) return job;
    if (task.state === 'BLOCKED' && state !== 'CANCELLED') throw new Error(`Task ${task.id} is BLOCKED; only authoritative unblock may transition it to UNBLOCKED`);
    if (state === 'UNBLOCKED') throw new Error(`Task ${task.id} may enter UNBLOCKED only through authoritative unblock`);
    if (task.state === 'UNBLOCKED') throw new Error(`Task ${task.id} is historical UNBLOCKED work and cannot be changed by dashboard state override`);

    const now = new Date().toISOString();
    const from = task.state;
    applyTaskWorkflowDecision(task, {
      accepted: true,
      target: state,
      guard: null,
      actions: [],
      mutations: [],
      effects: [],
      reason: 'accepted',
    }, now);
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
