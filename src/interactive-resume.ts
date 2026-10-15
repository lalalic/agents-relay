/** Graph-selected, atomic resume of a Task suspended for external UI review. */
import type { DurableStore } from './store.js';
import type { Task } from './types.js';
import type { InteractiveDecision } from './interactive-invocation.js';
import { shouldRecoverInteractiveDecision } from './interactive-invocation.js';
import { tryTransitionTaskEvent } from './scheduler.js';
import { applyTaskUnblockRetrySnapshot } from './task-actions.js';

export async function resumeInteractiveTask(
  store: DurableStore, jobId: string, taskId: string, invocationId: string,
  revision: string, decision: InteractiveDecision,
): Promise<boolean> {
  if (!store.mutateJob) throw new Error('Interactive resume requires atomic SQLite Job mutation');
  let resumed = false;
  await store.mutateJob(jobId, job => {
    const task: Task | undefined = job.tasks.find(item => item.id === taskId);
    const invocation = task?.interactiveInvocation;
    if (!task || task.state !== 'BLOCKED' || !invocation ||
        invocation.invocationId !== invocationId || invocation.revision !== revision ||
        invocation.status !== decision || !invocation.decidedAt) return job;
    // Both state transitions and retry eligibility are owned by task-lifecycle.mmd.
    if (!tryTransitionTaskEvent(task, 'task.unblocked', { autonomousJob: false }).accepted) {
      throw new Error('Interactive Task unblock rejected by canonical lifecycle Graph');
    }
    applyTaskUnblockRetrySnapshot(task);
    task.error = null;
    task.failureReason = undefined;
    task.updatedAt = new Date().toISOString();
    resumed = true;
    return job;
  });
  return resumed;
}

/** Reconciliation is recovery-safe even when the accepted event was lost after SQLite commit. */
export async function recoverInteractiveDecisions(store: DurableStore, jobId: string): Promise<boolean> {
  const job = await store.load(jobId);
  let recovered = false;
  for (const task of job.tasks) {
    if (task.state !== 'BLOCKED' || !task.interactiveInvocation?.decidedAt) continue;
    const invocation = task.interactiveInvocation;
    if (invocation.status === 'awaiting_decision' || !await shouldRecoverInteractiveDecision(invocation.status)) continue;
    recovered = await resumeInteractiveTask(store, job.id, task.id, invocation.invocationId, invocation.revision, invocation.status) || recovered;
  }
  return recovered;
}
