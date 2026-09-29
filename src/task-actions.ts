import type { DurableStore } from './store.js';
import type { Job, Task } from './types.js';
import { extendRetryBudget, transitionTaskEvent } from './scheduler.js';

export const TASK_RETRY_ACTION = 'task.retry' as const;
export const TASK_UNBLOCK_RETRY_ACTION = 'task.unblock.retry' as const;
export const TASK_CANCEL_ACTION = 'task.cancel' as const;
export const TASK_RELEASE_ACTION = 'task.release' as const;
export const TASK_HOLD_ACTION = 'task.hold' as const;
export const TASK_COMPLETE_ACTION = 'task.complete' as const;
export type TaskActionId = typeof TASK_RETRY_ACTION | typeof TASK_UNBLOCK_RETRY_ACTION | typeof TASK_CANCEL_ACTION | typeof TASK_RELEASE_ACTION | typeof TASK_HOLD_ACTION | typeof TASK_COMPLETE_ACTION;

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

/** Fixed-job authoritative unblock continuation: UNBLOCKED -> QUEUED through the canonical graph. */
export async function applyTaskUnblockRetryAction(task: Task): Promise<Task> {
  if (task.state !== 'UNBLOCKED') throw new Error(`Task ${task.id} must be UNBLOCKED before task.unblock.retry (${task.state})`);
  await transitionTaskEvent(task, 'retry');
  task.maxAttempts = extendRetryBudget(task);
  task.error = null;
  task.leaseOwner = null;
  task.leaseExpiresAt = null;
  task.executionId = null;
  delete task.blockedBy;
  return task;
}

export async function applyTaskCancelAction(task: Task, reason: string): Promise<Task> {
  if (task.state === 'UNBLOCKED') throw new Error(`Task ${task.id} is historical UNBLOCKED work and is immutable`);
  if (!['DRAFT', 'QUEUED', 'RUNNING', 'BLOCKED', 'FAILED'].includes(task.state)) throw new Error(`Task ${task.id} is not cancellable (${task.state})`);
  await transitionTaskEvent(task, task.state === 'RUNNING' ? 'task.cancelled' : 'cancel');
  task.error = reason;
  task.leaseOwner = null;
  task.leaseExpiresAt = null;
  task.executionId = null;
  return task;
}

export async function applyTaskReleaseAction(task: Task): Promise<Task> {
  if (task.state !== 'DRAFT') throw new Error(`Task ${task.id} is not releasable (${task.state})`);
  await transitionTaskEvent(task, 'release');
  return task;
}

export async function applyTaskHoldAction(task: Task): Promise<Task> {
  if (task.state !== 'QUEUED') throw new Error(`Task ${task.id} is not holdable (${task.state})`);
  await transitionTaskEvent(task, 'hold');
  return task;
}

export async function applyOrchestratorCompleteAction(task: Task, summary: string): Promise<Task> {
  if (task.adapter !== 'orchestrator') throw new Error('task complete is only valid for adapter=orchestrator self-tasks');
  if (!['QUEUED', 'RUNNING'].includes(task.state)) throw new Error(`Task ${task.id} is ${task.state}; only QUEUED or RUNNING orchestrator tasks can be completed`);
  if (task.state === 'QUEUED') await transitionTaskEvent(task, 'task.started');
  task.attempt = Math.max(task.attempt, 1);
  task.result = { summary };
  task.error = null;
  task.leaseOwner = null;
  task.leaseExpiresAt = null;
  task.executionId = null;
  await transitionTaskEvent(task, 'task.completed');
  return task;
}

/** Compatibility bridge: domain mutation only; adapters own wake/reconcile/output behavior. */
export async function dispatchTaskAction(
  store: DurableStore,
  request: TaskActionRequest,
): Promise<TaskActionResult> {
  const job = await store.load(request.jobId);
  const task = job.tasks.find(item => item.id === request.taskId);
  if (!task) throw new Error(`Task ${request.taskId} not found`);
  if (request.id === TASK_RETRY_ACTION) await applyTaskRetryAction(task, { extendBudget: true });
  else if (request.id === TASK_UNBLOCK_RETRY_ACTION) await applyTaskUnblockRetryAction(task);
  else if (request.id === TASK_CANCEL_ACTION) await applyTaskCancelAction(task, 'Cancelled by user');
  else throw new Error(`Unsupported task action ${request.id}`);
  await store.saveTask(task);
  return { job, task };
}
