import type { Job, Task } from './types.js';

/** Called inside SQLite mutateJob against the latest durable Job snapshot. */
export function reviewGenerationMatches(current: Job, original: Job, task: Task, headSha: string): boolean {
  const fresh = current.tasks.find(item => item.id === task.id);
  if (!fresh || fresh.reviewHeadSha !== headSha || current.state !== 'ACTIVE'
      || (current.headSha && current.headSha !== headSha)
      || fresh.executionId !== task.executionId) return false;
  if (current.review) return current.review.taskId === task.id && current.review.headSha === headSha
    && current.review.outcome === (original.review?.outcome ?? 'pending');
  return Boolean(task.planningDecisionId && !original.review?.taskId);
}
