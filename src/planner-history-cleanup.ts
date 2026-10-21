export type PlannerHistoryCleanup = { taskId: string; outcome: 'superseded' | 'invalid' | 'cancelled_review' | 'unresolved'; evidence: string; reason: string; targetTaskId?: string };

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Planner ${field} must be an object`);
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`Planner ${field} must be a non-empty string`);
  return value;
}

export function parsePlannerHistoryCleanup(value: unknown): PlannerHistoryCleanup[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('Planner history_cleanup must be an array when provided');
  const ids = new Set<string>();
  return value.map((item, index) => {
    const row = record(item, `history_cleanup[${index}]`);
    const taskId = requiredText(row.taskId, `history_cleanup[${index}].taskId`);
    const outcome = row.outcome;
    const evidence = requiredText(row.evidence, `history_cleanup[${index}].evidence`);
    const reason = requiredText(row.reason, `history_cleanup[${index}].reason`);
    if (!['superseded','invalid','cancelled_review','unresolved'].includes(String(outcome))) throw new Error(`Planner history_cleanup[${index}].outcome is invalid`);
    if (ids.has(taskId)) throw new Error(`Planner history_cleanup contains duplicate Task ${taskId}`);
    ids.add(taskId);
    const targetTaskId = row.targetTaskId === undefined ? undefined : requiredText(row.targetTaskId, `history_cleanup[${index}].targetTaskId`);
    if ((outcome === 'superseded' || outcome === 'invalid') && !targetTaskId) throw new Error(`Planner history_cleanup[${index}].targetTaskId is required for ${String(outcome)}`);
    return { taskId, outcome: outcome as PlannerHistoryCleanup['outcome'], evidence, reason, ...(targetTaskId ? { targetTaskId } : {}) };
  });
}
