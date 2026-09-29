import type { Job, Task, TaskChangeFact } from './types.js';

export type UnblockSummary = { taskId: string; changed: boolean; plannerRequested: boolean };

function headFact(job: Job, now: string, actor: string): TaskChangeFact | null {
  if (!job.headSha) return null;
  return { kind: 'head-sha', value: job.headSha ?? '', observedAt: now, actor };
}

function appendFact(task: Task, fact: TaskChangeFact): boolean {
  const state = task.blockState;
  if (!state || state.changeFacts.some(item => item.kind === fact.kind && item.value === fact.value)) return false;
  state.changeFacts.push(fact);
  task.updatedAt = fact.observedAt;
  return true;
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

/** Record a durable change observed after the task became blocked. */
export function recordTaskChangeFact(task: Task, fact: TaskChangeFact): boolean {
  if (task.state !== 'BLOCKED' || !task.blockState) return false;
  return appendFact(task, fact);
}

/** Record a changed PR head without requesting an unblock. */
export function recordObservedHeadChange(task: Task, job: Job, now: string, actor = 'relay:head-observed'): boolean {
  const fact = headFact(job, now, actor);
  if (!fact || task.blockState?.baseline.headSha === fact.value) return false;
  return recordTaskChangeFact(task, fact);
}

/** Human/CLI and blocker resolution are the only callers allowed to request an unblock. */
export function requestTaskUnblock(task: Task, job: Job, actor: string, reason: string | undefined, now: string): UnblockSummary {
  if (task.state !== 'BLOCKED') throw new Error(`Task ${task.id} is ${task.state}; only BLOCKED tasks can be unblocked`);
  if (!task.blockState) recordTaskBlocked(task, job, now);
  const state = task.blockState;
  if (!state) throw new Error(`Task ${task.id} has no block state`);
  if (state.unblockRequestedAt) return { taskId: task.id, changed: false, plannerRequested: !!state.plannerTaskId };
  recordObservedHeadChange(task, job, now, actor);
  appendFact(task, { kind: 'manual', value: reason ?? 'unblock requested', observedAt: now, actor });
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
