import type { DurableStore } from './store.js';
import type { Job, Task } from './types.js';
import { applyTaskHoldAction, applyTaskQueueAction } from './task-actions.js';

const editableFields = [
  'priority', 'storySize', 'projectName', 'agentName', 'agentGraph',
  'parentTaskId', 'dependencies', 'capabilities', 'workerRequirements',
  'adapter', 'chatgptTabClosePolicy', 'input', 'attachments',
  'routing', 'timeoutMs', 'maxAttempts',
] as const satisfies readonly (keyof Task)[];

/** All managed CLI Task updates commit through the daemon's operational store. */
export async function applyManagedTaskUpdate(
  store: DurableStore, jobId: string, taskId: string, proposed: Task, expectedUpdatedAt: string,
): Promise<Job> {
  const job = await store.load(jobId);
  const current = job.tasks.find(item => item.id === taskId);
  if (!current || proposed.id !== taskId || proposed.jobId !== jobId) throw new Error('Task update identity mismatch');
  if (current.updatedAt !== expectedUpdatedAt) throw new Error('Task changed since update preflight; refresh and retry');
  if (['RUNNING', 'SUCCEEDED', 'CANCELLED'].includes(current.state) || current.executionId || current.leaseOwner)
    throw new Error('Task is not mutable while active or terminal');
  if (current.attempt > 0 && current.adapter !== proposed.adapter) throw new Error('Cannot replace adapter after an execution attempt');
  if (proposed.maxAttempts < current.attempt) throw new Error('Retry budget is below execution attempts');

  const next: Task = structuredClone(current);
  for (const key of editableFields) {
    if (Object.hasOwn(proposed, key)) (next as unknown as Record<string, unknown>)[key] = structuredClone(proposed[key]);
    else delete (next as unknown as Record<string, unknown>)[key];
  }
  if (next.dependencies.includes(taskId)) throw new Error('Task cannot depend on itself');
  if (proposed.state !== current.state) {
    if (proposed.state === 'DRAFT' && current.state === 'QUEUED') await applyTaskHoldAction(next);
    else if (proposed.state === 'QUEUED') await applyTaskQueueAction(job, next);
    else throw new Error('Task state change requires a dedicated lifecycle action');
  }
  if (next.adapter !== current.adapter || JSON.stringify(next.routing) !== JSON.stringify(current.routing))
    next.workerSelection = undefined;
  next.updatedAt = new Date().toISOString();
  await store.saveTask(next);
  return store.load(jobId);
}

export function managedTaskUpdateHandler(
  locate: (jobId: string) => { store: DurableStore; repository: string; prNumber: number } | Promise<{ store: DurableStore; repository: string; prNumber: number }>,
  wake: (repository: string, prNumber: number, jobId: string) => Promise<void>,
): (jobId: string, taskId: string, task: Task, expectedUpdatedAt: string) => Promise<Job> {
  return async (jobId, taskId, task, expectedUpdatedAt) => {
    const target = await locate(jobId);
    const updated = await applyManagedTaskUpdate(target.store, jobId, taskId, task, expectedUpdatedAt);
    await wake(target.repository, target.prNumber, jobId);
    return updated;
  };
}
