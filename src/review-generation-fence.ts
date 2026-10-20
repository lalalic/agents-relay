import type { Job, Task } from './types.js';

/** Called inside SQLite mutateJob against the latest durable Job snapshot. */
export function reviewGenerationMatches(current: Job, original: Job, task: Task, headSha: string): boolean {
  const fresh = current.tasks.find(item => item.id === task.id);
  if (!fresh || fresh.reviewHeadSha !== headSha
      || (current.state !== 'ACTIVE' && current.projectionRecovery?.status !== 'repairing')
      || (current.headSha && current.headSha !== headSha)
      || fresh.executionId !== task.executionId) return false;
  // A fresh Planner reviewer for a new head replaces the old STALE review
  // generation. Reject competing reviewers of that same head deterministically.
  if (current.review?.outcome === 'stale' && original.review?.outcome === 'stale'
      && current.review.headSha !== headSha && task.planningDecisionId) {
    const currentHeadReviewers = current.tasks.filter(item => item.agentName === 'reviewer'
      && item.reviewHeadSha === headSha && item.state !== 'CANCELLED');
    return currentHeadReviewers.at(-1)?.id === task.id;
  }
  if (current.review) return current.review.taskId === task.id && current.review.headSha === headSha
    && current.review.outcome === (original.review?.outcome ?? 'pending');
  return Boolean(task.planningDecisionId && !original.review?.taskId);
}
