import type { DurableStore } from './store.js';
import type { Job, TaskState } from './types.js';
import type { Reconciler } from './reconciler.js';
import { extendRetryBudget, transitionTaskEvent } from './scheduler.js';
import { applyTaskWorkflowDecision } from './workflow/runtime.js';

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
      if (!['FAILED', 'BLOCKED'].includes(task.state)) throw new Error(`Task ${task.id} is not restartable (${task.state})`);
      task.maxAttempts = extendRetryBudget(task);
      await transitionTaskEvent(task, 'retry');
      task.error = null;
    } else {
      if (!['DRAFT', 'QUEUED', 'RUNNING', 'BLOCKED', 'FAILED'].includes(task.state)) throw new Error(`Task ${task.id} is not cancellable (${task.state})`);
      await transitionTaskEvent(task, task.state === 'RUNNING' ? 'task.cancelled' : 'cancel');
      task.error = 'Cancelled by user';
    }
    task.leaseOwner = null;
    task.leaseExpiresAt = null;
    task.executionId = null;
    await store.saveTask(task);
    return await reconciler.wake(job.id);
  };
}

export function dashboardTaskSetState(store: DurableStore): (jobId: string, taskId: string, state: TaskState) => Promise<Job> {
  return async (jobId: string, taskId: string, state: TaskState): Promise<Job> => {
    const job = await store.load(jobId);
    const task = job.tasks.find(item => item.id === taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.state === state) return job;

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
