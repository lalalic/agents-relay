import type { EventRecord } from './types.js';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Translate an authenticated reviewer terminal verdict without losing canonical review evidence. */
export function normalizeReviewerTerminalEvent(event: EventRecord): EventRecord | null {
  if (event.type !== 'task.completed') return null;
  const data = record(event.data);
  const raw = data.verdict;
  const type = raw === 'approved' || raw === 'pass' ? 'review.approved'
    : raw === 'changes-required' || raw === 'changes_required' ? 'review.changes_required'
    : raw === 'blocked' ? 'review.blocked' : null;
  if (!type) return null;
  const outcome = record(data.outcome);
  const review = record(data.review);
  // Match canonical review head resolution: outcome > review > top-level data.
  const head = [outcome.head_sha, outcome.headSha, review.head_sha, review.headSha,
    data.head_sha, data.headSha]
    .find(value => typeof value === 'string' && value.length > 0);
  const existingFindings = outcome.blocking_findings ?? outcome.blockingFindings;
  const findings = existingFindings ?? (Array.isArray(data.findings) ? data.findings : undefined);
  return { ...event, type, data: { ...data, outcome: {
    ...outcome, ...(head ? { head_sha: head } : {}),
    ...(findings !== undefined && existingFindings === undefined ? { blocking_findings: findings } : {}),
  } } };
}
