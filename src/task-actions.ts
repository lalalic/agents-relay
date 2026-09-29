import type { DurableStore } from './store.js';
import type { Job, Task } from './types.js';
import { extendRetryBudget, transitionTaskEvent } from './scheduler.js';

export const TASK_RETRY_ACTION = 'task.retry' as const;
export type TaskActionId = typeof TASK_RETRY_ACTION;

export type TaskActionRequest = {
  id: TaskActionId;
  jobId: string;
  taskId: string;
};

export type TaskActionResult = { job: Job; task: Task };
export type TaskRetryPolicy = { extendBudget?: boolean };

/** Shared task.retry mutation. The canonical lifecycle graph remains the transition authority. */
export async function applyTaskRetryAction(task: Task, policy: TaskRetryPolicy = {}): Promise<Task> {
  if (task.state === 'BLOCKED') throw new Error(`Task ${task.id} is BLOCKED; use task unblock --reason instead of retry`);
  if (task.state === 'UNBLOCKED') throw new Error(`Task ${task.id} is historical UNBLOCKED work; only fixed-job authoritative unblock may requeue it`);
  if (task.state !== 'FAILED') throw new Error(`Task ${task.id} is not restartable (${task.state})`);

  const previousError = task.error;
  await transitionTaskEvent(task, 'retry');
  if (policy.extendBudget) task.maxAttempts = extendRetryBudget(task);
  if (task.kind === 'planner' && previousError) task.plannerRetryFeedback = previousError;
  task.error = null;
  task.leaseOwner = null;
  task.leaseExpiresAt = null;
  task.executionId = null;
  return task;
}

/** Compatibility bridge: domain mutation only; adapters own wake/reconcile/output behavior. */
export async function dispatchTaskAction(
  store: DurableStore,
  request: TaskActionRequest,
): Promise<TaskActionResult> {
  if (request.id !== TASK_RETRY_ACTION) throw new Error(`Unsupported task action ${request.id}`);
  const job = await store.load(request.jobId);
  const task = job.tasks.find(item => item.id === request.taskId);
  if (!task) throw new Error(`Task ${request.taskId} not found`);
  await applyTaskRetryAction(task, { extendBudget: true });
  await store.saveTask(task);
  return { job, task };
}
