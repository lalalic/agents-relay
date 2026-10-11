import type { PlannerResult } from './planner.js';
import { allocateEntityId } from './job-task-id-sequence.js';
import { relayStoreDirectory } from './relay-store.js';

/** Planner labels are local to its plan. Durable Task IDs are allocated by Relay. */
export function assignPlannerTaskIds(result: PlannerResult, repository: string, jobId: string, planId: string, directory = relayStoreDirectory()): PlannerResult {
  const aliases = new Map(result.next_tasks.map(spec => [spec.id, allocateEntityId(directory, repository, 'task', `plan:${jobId}:${planId}:${spec.id}`)]));
  return {
    ...result,
    next_tasks: result.next_tasks.map(spec => ({
      ...spec,
      id: aliases.get(spec.id)!,
      parentTaskId: spec.parentTaskId ? (aliases.get(spec.parentTaskId) ?? spec.parentTaskId) : spec.parentTaskId,
      dependencies: spec.dependencies?.map(dep => aliases.get(dep) ?? dep),
    })),
  };
}
