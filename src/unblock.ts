import type { Job, Task, TaskChangeFact } from './types.js';

export type UnblockSummary = { taskId: string; changed: boolean; plannerRequested: boolean };

function headFact(job: Job, now: string, actor: string): TaskChangeFact {
  return { kind: 'head-sha', value: job.headSha ?? '', observedAt: now, actor };
}

/** Record the durable baseline at the moment Relay learns that a task is blocked. */
export function recordTaskBlocked(task: Task, job: Job, now: string): void {
  if (task.state !== 'BLOCKED') return;
  if (task.blockState?.blockedAt && task.blockState.baseline.attempt === task.attempt) return;
  task.blockState = {
    blockedAt: now,
    baseline: { attempt: task.attempt, headSha: job.headSha ?? null },
    changeFacts: [],
  };
}

/** Human/CLI and blocker resolution are the only callers allowed to request an unblock. */
export function requestTaskUnblock(task: Task, job: Job, actor: string, reason: string | undefined, now: string): UnblockSummary {
  if (task.state !== 'BLOCKED') throw new Error(`Task ${task.id} is ${task.state}; only BLOCKED tasks can be unblocked`);
  if (!task.blockState) recordTaskBlocked(task, job, now);
  const state = task.blockState;
  if (!state) throw new Error(`Task ${task.id} has no block state`);
  if (state.unblockRequestedAt) return { taskId: task.id, changed: false, plannerRequested: !!state.plannerTaskId };
  state.changeFacts.push(headFact(job, now, actor));
  state.unblockRequestedAt = now;
  state.unblockRequestedBy = actor;
  state.unblockReason = reason;
  task.updatedAt = now;
  return { taskId: task.id, changed: true, plannerRequested: false };
}

export function markUnblockPlanner(task: Task, plannerTaskId: string, now: string): void {
  if (!task.blockState?.unblockRequestedAt || task.blockState.plannerTaskId) return;
  task.blockState.plannerTaskId = plannerTaskId;
  task.updatedAt = now;
}
