/** Extracted the inbound SQLite Job/Plan/Task merge into a dedicated pure helper.
 * This preserves the original merge contract while keeping relay-store.ts within the
 * production source-size gate; no GitHub or PR lifecycle behavior is introduced. */
import { preserveTaskComments } from './task-comments.js';
import { preserveReviewRevisionHistory } from './review-revision-merge.js';
import type { Job, Plan, Task } from './types.js';

function newerRecord<T extends { updatedAt: string }>(local: T | undefined, remote: T): T {
  if (!local) return structuredClone(remote);
  return remote.updatedAt > local.updatedAt ? structuredClone(remote) : structuredClone(local);
}
function mergeRecords<T extends { id: string; updatedAt: string }>(local: readonly T[], remote: readonly T[]): T[] {
  const remoteById = new Map(remote.map(item => [item.id, item]));
  const merged = local.map(item => newerRecord(item, remoteById.get(item.id) ?? item));
  const localIds = new Set(local.map(item => item.id));
  for (const item of remote) if (!localIds.has(item.id)) merged.push(structuredClone(item));
  return merged;
}
export function mergeInboundJobSnapshot(local: Job, remote: Job): Job {
  const base = remote.updatedAt > local.updatedAt ? structuredClone(remote) : structuredClone(local);
  base.tasks = preserveTaskComments(local.tasks, mergeRecords<Task>(local.tasks, remote.tasks)); preserveReviewRevisionHistory(local, base);
  const localPlans = local.plans ?? [];
  const remotePlans = remote.plans ?? [];
  if (localPlans.length > 0 || remotePlans.length > 0) {
    base.plans = mergeRecords<Plan>(localPlans, remotePlans).sort((a, b) => a.round - b.round);
  } else {
    delete base.plans;
  }
  return base;
}
