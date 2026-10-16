import type { DurableStore } from './store.js';
import type { Job } from './types.js';
import { tryTransitionTaskEvent } from './scheduler.js';

export async function pauseJob(store: DurableStore, jobId: string): Promise<Job> {
  const mutate = (current: Job): Job => {
    if (['COMPLETED', 'CANCELLED'].includes(current.state)) throw new Error(`Cannot pause terminal Job ${current.id} (${current.state})`);
    if (current.pause) return current;
    const now = new Date().toISOString();
    current.pause = { generation: 1, requestedAt: now };
    for (const task of current.tasks) {
      if (task.kind === 'planner' || ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.state)) continue;
      if (task.executionId) task.pausedExecution = { id: task.executionId, state: task.state === 'RUNNING' ? 'RUNNING' : 'QUEUED', attempt: task.attempt, at: now };
      if (task.state === 'RUNNING' && !tryTransitionTaskEvent(task, 'pause').accepted) throw new Error(`Cannot pause running Task ${task.id}`);
      task.executionId = null; task.leaseOwner = null; task.leaseExpiresAt = null; task.updatedAt = now;
    }
    for (const plan of current.plans ?? []) {
      if (plan.status !== 'PLANNING') continue;
      if (plan.executionId) plan.pausedExecutionId = plan.executionId;
      plan.executionId = null; plan.leaseOwner = null; plan.leaseExpiresAt = null; plan.updatedAt = now;
    }
    current.updatedAt = now;
    return current;
  };
  if (store.mutateJob) return store.mutateJob(jobId, mutate);
  const job = await store.load(jobId); const updated = mutate(job); await store.saveJob(updated);
  for (const task of updated.tasks) await store.saveTask(task);
  for (const plan of updated.plans ?? []) await store.savePlan(plan);
  return updated;
}

export async function resumeJob(store: DurableStore, jobId: string): Promise<Job> {
  const mutate = (current: Job): Job => {
    if (!current.pause) return current;
    const now = new Date().toISOString();
    delete current.pause;
    for (const task of current.tasks) { if (task.pausedExecution) { if (task.attempt >= task.maxAttempts) task.maxAttempts = task.attempt + 1; delete task.pausedExecution; task.updatedAt = now; } }
    for (const plan of current.plans ?? []) delete plan.pausedExecutionId;
    current.updatedAt = now;
    return current;
  };
  if (store.mutateJob) return store.mutateJob(jobId, mutate);
  const job = await store.load(jobId); const updated = mutate(job); await store.saveJob(updated);
  for (const task of updated.tasks) await store.saveTask(task);
  for (const plan of updated.plans ?? []) await store.savePlan(plan);
  return updated;
}
