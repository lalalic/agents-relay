import type { Job, Task } from '../types.js';
import { decideRelatedTaskAction } from './task-related-action-v2.js';

export type RelatedTaskMutation = {
  taskId: string;
  mutation: 'cancel';
  reason: string;
};

/**
 * Graph-driven related-task scope for explicit task actions.
 *
 * TypeScript provides relationship/lifecycle facts; the executable workflow
 * decides whether each candidate receives a related mutation.
 */
export function selectRelatedTaskMutations(
  job: Job,
  task: Task,
  actionId: string,
): RelatedTaskMutation[] {
  return job.tasks.flatMap(candidate => {
    const decision = decideRelatedTaskAction(task, candidate, actionId);
    if (!decision.accepted || decision.target !== 'selected') return [];
    return [{
      taskId: candidate.id,
      mutation: 'cancel' as const,
      reason: `Superseded by manual retry of ${task.id}`,
    }];
  });
}
