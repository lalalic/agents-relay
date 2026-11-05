import type { Job } from './types.js';
import type { DurableStore } from './store.js';
import { tryTransitionTaskEvent } from './task-transitions.js';
import { decideRevisionLifecycle } from './workflow/revision-v2.js';

/** Revision Graph-authorized cleanup of requests whose head OR reviewer
 * execution generation became stale. Request + child disposition are atomic.
 * An old-generation receipt must never cancel a currently active generation.
 */
export async function staleReviewRevisions(
  store: Pick<DurableStore, 'mutateJob'>, job: Job, reviewTaskId: string, headSha: string,
  cancelExecution: (taskId: string, executionId: string) => void,
  activeExecutionId?: string,
): Promise<void> {
  if (!store.mutateJob) return;
  const cancelled: Array<{ taskId: string; executionId: string }> = [];
  await store.mutateJob(job.id, current => {
    if (current.review?.taskId !== reviewTaskId || current.review.headSha !== headSha) return current;
    if (activeExecutionId && current.tasks.find(task => task.id === reviewTaskId)?.executionId !== activeExecutionId) return current;
    let changed = false;
    for (const request of current.reviewRevisionRequests ?? []) {
      if (request.reviewTaskId !== reviewTaskId || request.reviewHeadSha !== headSha) continue;
      if (activeExecutionId && request.reviewExecutionId === activeExecutionId) continue;
      const states = { requested: 'REQUESTED', queued: 'QUEUED', running: 'RUNNING', failed: 'FAILED' } as const;
      const state = states[request.status as keyof typeof states];
      if (!state) continue;
      const event = activeExecutionId ? 'review.execution_changed' : 'review.head_changed';
      const decision = decideRevisionLifecycle(state, event);
      if (!decision.accepted || decision.target !== 'STALE' || !decision.actions.some(action => action.id === 'revision.markStale')) continue;
      const child = request.revisionTaskId ? current.tasks.find(task => task.id === request.revisionTaskId) : undefined;
      if (child && ['DRAFT', 'QUEUED', 'RUNNING'].includes(child.state)) {
        const executionId = child.executionId ?? child.executionHistory?.at(-1)?.id ?? null;
        if (!tryTransitionTaskEvent(child, 'cancel').accepted) continue;
        child.error = activeExecutionId
          ? 'Targeted revision evidence became stale after reviewer execution changed'
          : 'Targeted revision evidence became stale after review head changed';
        child.leaseOwner = null;
        child.leaseExpiresAt = null;
        child.executionId = null;
        child.updatedAt = new Date().toISOString();
        if (executionId) cancelled.push({ taskId: child.id, executionId });
      } else if (child && child.state !== 'FAILED' && child.state !== 'SUCCEEDED' && child.state !== 'CANCELLED') {
        continue;
      }
      request.status = 'stale';
      changed = true;
    }
    if (changed) current.updatedAt = new Date().toISOString();
    return current;
  });
  for (const execution of cancelled) cancelExecution(execution.taskId, execution.executionId);
}
