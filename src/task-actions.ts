import type { DurableStore } from './store.js';
import type { Job, Task } from './types.js';
import { extendRetryBudget, transitionTaskEvent, tryTransitionTaskEvent } from './scheduler.js';
import { selectRelatedTaskMutations, type RelatedTaskMutation } from './workflow/task-action-policy.js';

export const TASK_RETRY_ACTION = 'task.retry' as const;
export const TASK_UNBLOCK_RETRY_ACTION = 'task.unblock.retry' as const;
export const TASK_CANCEL_ACTION = 'task.cancel' as const;
export const TASK_RELEASE_ACTION = 'task.release' as const;
export const TASK_HOLD_ACTION = 'task.hold' as const;
export const TASK_COMPLETE_ACTION = 'task.complete' as const;
export const TASK_QUEUE_ACTION = 'task.queue' as const;
export type TaskActionId = typeof TASK_RETRY_ACTION | typeof TASK_UNBLOCK_RETRY_ACTION | typeof TASK_CANCEL_ACTION | typeof TASK_RELEASE_ACTION | typeof TASK_HOLD_ACTION | typeof TASK_COMPLETE_ACTION | typeof TASK_QUEUE_ACTION;

export type TaskActionRequest = {
  id: TaskActionId;
  jobId: string;
  taskId: string;
};

export type TaskActionResult = { job: Job; task: Task };
export type TaskRetryPolicy = { extendBudget?: boolean };

function lifecycleRejection(task: Task, action: string): Error {
  return new Error(`Task ${task.id} is not ${action} (${task.state})`);
}

async function transitionTaskAction(task: Task, event: string, action: string, facts = {}): Promise<void> {
  try {
    await transitionTaskEvent(task, event, facts);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('No enabled workflow transition')) {
      throw lifecycleRejection(task, action);
    }
    throw error;
  }
}

function clearExecution(task: Task): void {
  task.error = null;
  task.leaseOwner = null;
  task.leaseExpiresAt = null;
  task.executionId = null;
}

/** Shared task.retry mutation. The canonical lifecycle graph is the sole legality authority. */
export async function applyTaskRetryAction(task: Task, policy: TaskRetryPolicy = {}): Promise<Task> {
  if (task.kind === 'planner') throw new Error(`Legacy planner Task ${task.id} is read-only; retry the Plan instead`);
  await transitionTaskAction(task, 'retry', 'restartable');
  if (policy.extendBudget) task.maxAttempts = extendRetryBudget(task);
  clearExecution(task);
  return task;
}

/** Fixed-job authoritative unblock continuation: legality is owned by the lifecycle graph. */
export async function applyTaskUnblockRetryAction(task: Task): Promise<Task> {
  await transitionTaskAction(task, 'retry', 'retryable after unblock');
  task.maxAttempts = extendRetryBudget(task);
  clearExecution(task);
  delete task.blockedBy;
  return task;
}

export function tryApplyTaskCancelAction(task: Task, reason: string): boolean {
  if (task.kind === 'planner') return false;
  const decision = tryTransitionTaskEvent(task, 'cancel');
  if (!decision.accepted) return false;
  task.error = reason;
  task.leaseOwner = null;
  task.leaseExpiresAt = null;
  task.executionId = null;
  return true;
}

export async function applyTaskCancelAction(task: Task, reason: string): Promise<Task> {
  if (task.kind === 'planner') throw new Error(`Legacy planner Task ${task.id} is read-only`);
  if (!tryApplyTaskCancelAction(task, reason)) throw lifecycleRejection(task, 'cancellable');
  return task;
}

export async function applyTaskReleaseAction(task: Task): Promise<Task> {
  await transitionTaskAction(task, 'release', 'releasable');
  return task;
}

export async function applyTaskHoldAction(task: Task): Promise<Task> {
  await transitionTaskAction(task, 'hold', 'holdable');
  return task;
}

export async function applyTaskQueueAction(job: Job, task: Task): Promise<Task> {
  const taskMap = new Map(job.tasks.map(item => [item.id, item]));
  const dependenciesSatisfied = task.dependencies.every(id => taskMap.get(id)?.state === 'SUCCEEDED');
  await transitionTaskAction(task, 'queue', 'queueable', { dependenciesSatisfied });
  clearExecution(task);
  return task;
}

export async function applyOrchestratorCompleteAction(task: Task, summary: string): Promise<Task> {
  if (task.adapter !== 'orchestrator') throw new Error('task complete is only valid for adapter=orchestrator self-tasks');
  const originalState = task.state;
  tryTransitionTaskEvent(task, 'task.started');
  task.attempt = Math.max(task.attempt, 1);
  task.result = { summary };
  clearExecution(task);
  try {
    await transitionTaskEvent(task, 'task.completed');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('No enabled workflow transition')) {
      throw new Error(`Task ${task.id} is ${originalState}; only QUEUED or RUNNING orchestrator tasks can be completed`);
    }
    throw error;
  }
  return task;
}

async function applySelectedRelatedTaskMutations(
  job: Job,
  mutations: readonly RelatedTaskMutation[],
): Promise<Task[]> {
  const changed: Task[] = [];
  for (const mutation of mutations) {
    const related = job.tasks.find(item => item.id === mutation.taskId);
    if (!related) throw new Error(`Related task ${mutation.taskId} not found`);
    if (mutation.mutation === 'cancel') await applyTaskCancelAction(related, mutation.reason);
    changed.push(related);
  }
  return changed;
}

/** Compatibility bridge: domain mutation only; adapters own wake/reconcile/output behavior. */
export async function dispatchTaskAction(
  store: DurableStore,
  request: TaskActionRequest,
): Promise<TaskActionResult> {
  const job = await store.load(request.jobId);
  const task = job.tasks.find(item => item.id === request.taskId);
  if (!task) throw new Error(`Task ${request.taskId} not found`);
  const relatedMutations = selectRelatedTaskMutations(job, task, request.id);
  if (request.id === TASK_RETRY_ACTION) await applyTaskRetryAction(task, { extendBudget: true });
  else if (request.id === TASK_UNBLOCK_RETRY_ACTION) await applyTaskUnblockRetryAction(task);
  else if (request.id === TASK_CANCEL_ACTION) await applyTaskCancelAction(task, 'Cancelled by user');
  else if (request.id === TASK_RELEASE_ACTION) await applyTaskReleaseAction(task);
  else if (request.id === TASK_HOLD_ACTION) await applyTaskHoldAction(task);
  else if (request.id === TASK_QUEUE_ACTION) await applyTaskQueueAction(job, task);
  else throw new Error(`Unsupported task action ${request.id}`);
  const changedRelated = await applySelectedRelatedTaskMutations(job, relatedMutations);
  await store.saveTask(task);
  for (const related of changedRelated) await store.saveTask(related);
  return { job, task };
}
