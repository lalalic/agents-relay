import type { Job, Task, TaskState } from '../types.js';

export type RelatedTaskMutation = {
  taskId: string;
  mutation: 'cancel';
  reason: string;
};

const SUPERSEDEABLE_RECOVERY_STATES = new Set<TaskState>(['DRAFT', 'QUEUED', 'RUNNING', 'BLOCKED', 'FAILED']);

function isRecoveryFor(task: Task, candidate: Task): boolean {
  if (candidate.agentName !== 'troubleshooter') return false;
  return candidate.parentTaskId === task.id
    || (!candidate.parentTaskId && candidate.id.startsWith(`troubleshoot-${task.id}-a`));
}

/**
 * Canonical related-task policy for explicit task actions.
 *
 * This function selects targets only. Mutation helpers must not rediscover task
 * relationships or decide workflow scope themselves.
 */
export function selectRelatedTaskMutations(
  job: Job,
  task: Task,
  actionId: string,
): RelatedTaskMutation[] {
  if (actionId !== 'task.retry') return [];
  return job.tasks
    .filter(candidate => candidate.id !== task.id)
    .filter(candidate => isRecoveryFor(task, candidate))
    .filter(candidate => SUPERSEDEABLE_RECOVERY_STATES.has(candidate.state))
    .map(candidate => ({
      taskId: candidate.id,
      mutation: 'cancel' as const,
      reason: `Superseded by manual retry of ${task.id}`,
    }));
}
