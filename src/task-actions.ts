import type { DurableStore } from './store.js';
import type { Job, Task } from './types.js';
import { extendRetryBudget, transitionTaskEvent, tryTransitionTaskEvent } from './scheduler.js';
import { selectRelatedTaskMutations, type RelatedTaskMutation } from './workflow/task-action-policy.js';
import { dispatchTaskResolutionSync, materializeResolution } from './workflow/task-resolution.js';

export const TASK_RETRY_ACTION = 'task.retry' as const;
export const TASK_RECOVER_ACTION = 'task.recover' as const;
export const TASK_UNBLOCK_RETRY_ACTION = 'task.unblock.retry' as const;
export const TASK_CANCEL_ACTION = 'task.cancel' as const;
export const TASK_RELEASE_ACTION = 'task.release' as const;
export const TASK_HOLD_ACTION = 'task.hold' as const;
export const TASK_QUEUE_ACTION = 'task.queue' as const;
export type TaskActionId = typeof TASK_RETRY_ACTION | typeof TASK_RECOVER_ACTION | typeof TASK_UNBLOCK_RETRY_ACTION | typeof TASK_CANCEL_ACTION | typeof TASK_RELEASE_ACTION | typeof TASK_HOLD_ACTION | typeof TASK_QUEUE_ACTION;

export type TaskActionRequest = {
  id: TaskActionId;
  jobId: string;
  taskId: string;
  recoveryTaskId?: string;
  recoveryDiagnosis?: { failureKind: string; reason: string; evidence?: string; reroute: boolean; excludeCurrentRoute: boolean };
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

function applyTaskRetrySnapshot(task: Task, policy: TaskRetryPolicy = {}): void {
  if (task.kind === 'planner') throw new Error(`Legacy planner Task ${task.id} is read-only; retry the Plan instead`);
  const decision = tryTransitionTaskEvent(task, 'retry');
  if (!decision.accepted) throw lifecycleRejection(task, 'restartable');
  if (policy.extendBudget) task.maxAttempts = extendRetryBudget(task);
  clearExecution(task);
}

/** Fixed-job authoritative unblock continuation, applied inside one Job snapshot mutation. */
export function applyTaskUnblockRetrySnapshot(task: Task): void {
  if (task.state === 'BLOCKED' && !tryTransitionTaskEvent(task, 'task.unblocked', { autonomousJob: false }).accepted) throw lifecycleRejection(task, 'retryable after unblock');
  if (!['QUEUED', 'DRAFT'].includes(task.state)) throw lifecycleRejection(task, 'retryable after unblock');
  task.attempt = 0;
  task.maxAttempts = Math.max(3, task.maxAttempts);
  clearExecution(task);
  delete task.blockedBy;
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
  if (task.state === 'BLOCKED') await transitionTaskAction(task, 'task.unblocked', 'retryable after unblock', { autonomousJob: false });
  if (!['QUEUED', 'DRAFT'].includes(task.state)) throw lifecycleRejection(task, 'retryable after unblock');
  task.attempt = 0;
  task.maxAttempts = Math.max(3, task.maxAttempts);
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


function markCancelledTaskSuperseded(task: Task, reason: string): void {
  if (task.kind === 'planner') throw new Error(`Legacy planner Task ${task.id} is read-only`);
  if (task.state !== 'CANCELLED') throw new Error(`Task ${task.id} must already be CANCELLED before supersede annotation`);
  if (!reason.trim()) throw new Error('task supersede requires a reason');
  const proposal = { path: 'cancel_supersede' as const, targetTaskId: task.id, rootCause: reason.trim(), solution: 'Superseded by later corrected durable work' };
  const decision = dispatchTaskResolutionSync(task, proposal, 'external', { cancelSupersede: () => {
    task.resolution = { ...materializeResolution(task, proposal, 'external'), state: 'resolved' };
    task.error = `Superseded ${reason.trim()}`;
    task.updatedAt = new Date().toISOString();
  } });
  if (!decision.accepted) throw new Error(`Task resolution graph rejected cancellation supersede for ${task.id}`);
}

export async function supersedeCancelledTask(store: DurableStore, jobId: string, taskId: string, reason: string): Promise<TaskActionResult> {
  if (store.mutateJob) {
    let updatedTask: Task | undefined;
    const updated = await store.mutateJob(jobId, current => {
      const task = current.tasks.find(item => item.id === taskId);
      if (!task) throw new Error(`Task ${taskId} not found`);
      markCancelledTaskSuperseded(task, reason);
      updatedTask = structuredClone(task);
      return current;
    });
    if (!updatedTask) throw new Error(`Task ${taskId} was not updated`);
    return { job: updated, task: updatedTask };
  }
  const job = await store.load(jobId);
  const task = job.tasks.find(item => item.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  markCancelledTaskSuperseded(task, reason);
  await store.saveTask(task);
  return { job: await store.load(jobId), task };
}

function recordRecoveryRouting(task: Task, request: TaskActionRequest): void {
  const diagnosis = request.recoveryDiagnosis;
  if (!diagnosis) return;
  if (!['adapter_failure', 'model_failure', 'provider_failure', 'task_failure', 'unknown'].includes(diagnosis.failureKind)) throw new Error('Invalid recovery failureKind');
  if (!diagnosis.reason.trim()) throw new Error('Recovery diagnosis requires reason');
  if (diagnosis.excludeCurrentRoute && !diagnosis.reroute) throw new Error('Cannot exclude route without reroute');
  if (diagnosis.excludeCurrentRoute && task.routing) {
    const route = task.routing;
    if (!task.routingExclusions?.some(item => item.provider === route.provider && item.model === route.model && item.profile === route.profile)) {
      task.routingExclusions = [...(task.routingExclusions ?? []), { provider: route.provider, model: route.model, ...(route.profile ? { profile: route.profile } : {}), reason: diagnosis.reason, at: new Date().toISOString() }];
    }
  }
  task.recoveryContext = { failureKind: diagnosis.failureKind, reason: diagnosis.reason, ...(diagnosis.evidence ? { evidence: diagnosis.evidence } : {}), recoveryTaskId: request.recoveryTaskId!, at: new Date().toISOString(), reroute: diagnosis.reroute };
  if (diagnosis.reroute) { task.routing = undefined; task.workerSelection = undefined; }
}

/** Compatibility bridge: domain mutation only; adapters own wake/reconcile/output behavior. */
export async function dispatchTaskAction(
  store: DurableStore,
  request: TaskActionRequest,
): Promise<TaskActionResult> {
  if (store.mutateJob && ([TASK_RETRY_ACTION, TASK_RECOVER_ACTION, TASK_CANCEL_ACTION] as readonly TaskActionId[]).includes(request.id)) {
    let updatedTask: Task | undefined;
    const updated = await store.mutateJob(request.jobId, current => {
      const task = current.tasks.find(item => item.id === request.taskId);
      if (!task) throw new Error(`Task ${request.taskId} not found`);
      const recovery = request.id === TASK_RECOVER_ACTION && request.recoveryTaskId ? current.tasks.find(item => item.id === request.recoveryTaskId) : undefined;
      if (request.id === TASK_RECOVER_ACTION) {
        if (!recovery || recovery.agentName !== 'troubleshooter' || recovery.parentTaskId !== task.id || !['QUEUED', 'RUNNING'].includes(recovery.state))
          throw new Error(`task recover requires an active Troubleshooter recovery for ${task.id}`);
      }
      const relatedMutations = request.id === TASK_RECOVER_ACTION ? [] : selectRelatedTaskMutations(current, task, request.id);
      if (request.id === TASK_RETRY_ACTION) { applyTaskRetrySnapshot(task, { extendBudget: true }); task.routing = undefined; task.workerSelection = undefined; }
      else if (request.id === TASK_RECOVER_ACTION) {
        if (!recovery) throw new Error(`task recover requires an active Troubleshooter recovery for ${task.id}`);
        if (!recovery.executionId) throw new Error(`Troubleshooter ${recovery.id} has no current execution for a fresh resolution`);
        const proposal = { path: 'exact_original_retry' as const, targetTaskId: task.id, recoveryExecutionId: recovery.executionId, rootCause: task.failureReason ?? task.error ?? 'durable failure', solution: `Recover exact original Task via ${request.recoveryTaskId}` };
        const decision = dispatchTaskResolutionSync(task, proposal, 'troubleshooter', { activateRecovery: () => { applyTaskRetrySnapshot(task, { extendBudget: true }); recordRecoveryRouting(task, request); task.resolution = { ...materializeResolution(task, proposal, 'troubleshooter'), state: 'resolved' }; } });
        if (!decision.accepted) throw new Error(`Task resolution graph rejected exact-original recovery for ${task.id}`);
      }
      else if (request.id === TASK_CANCEL_ACTION) cancelTaskSnapshot(task);
      for (const mutation of relatedMutations) {
        const related = current.tasks.find(item => item.id === mutation.taskId);
        if (!related) throw new Error(`Related task ${mutation.taskId} not found`);
        cancelTaskSnapshot(related, mutation.reason);
      }
      updatedTask = structuredClone(task);
      return current;
    });
    if (!updatedTask) throw new Error(`Task ${request.taskId} was not updated`);
    return { job: updated, task: updatedTask };
  }
  const job = await store.load(request.jobId);
  const task = job.tasks.find(item => item.id === request.taskId);
  if (!task) throw new Error(`Task ${request.taskId} not found`);
  const relatedMutations = request.id === TASK_RECOVER_ACTION ? [] : selectRelatedTaskMutations(job, task, request.id);
  if (request.id === TASK_RETRY_ACTION) { await applyTaskRetryAction(task, { extendBudget: true }); task.routing = undefined; task.workerSelection = undefined; }
  else if (request.id === TASK_RECOVER_ACTION) {
    const recovery = request.recoveryTaskId ? job.tasks.find(item => item.id === request.recoveryTaskId) : undefined;
    if (!recovery || recovery.agentName !== 'troubleshooter' || recovery.parentTaskId !== task.id || !['QUEUED','RUNNING'].includes(recovery.state))
      throw new Error(`task recover requires an active Troubleshooter recovery for ${task.id}`);
    if (!recovery.executionId) throw new Error(`Troubleshooter ${recovery.id} has no current execution for a fresh resolution`);
    const proposal = { path: 'exact_original_retry' as const, targetTaskId: task.id, recoveryExecutionId: recovery.executionId, rootCause: task.failureReason ?? task.error ?? 'durable failure', solution: `Recover exact original Task via ${request.recoveryTaskId}` };
    const decision = dispatchTaskResolutionSync(task, proposal, 'troubleshooter', { activateRecovery: () => { applyTaskRetrySnapshot(task, { extendBudget: true }); recordRecoveryRouting(task, request); task.resolution = { ...materializeResolution(task, proposal, 'troubleshooter'), state: 'resolved' }; } });
    if (!decision.accepted) throw new Error(`Task resolution graph rejected exact-original recovery for ${task.id}`);
  }
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

function cancelTaskSnapshot(task: Task, reason = 'Cancelled by user'): void {
  if (!tryApplyTaskCancelAction(task, reason)) throw lifecycleRejection(task, 'cancellable');
}
