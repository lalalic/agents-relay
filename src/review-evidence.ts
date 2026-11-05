import type { EventRecord, Task } from './types.js';

function reviewRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function reviewHeadSha(event: EventRecord): string | undefined {
  const data = reviewRecord(event.data);
  const outcome = reviewRecord(data.outcome);
  const review = reviewRecord(data.review);
  return [outcome.head_sha, outcome.headSha, review.head_sha, review.headSha, data.head_sha, data.headSha]
    .find((value): value is string => typeof value === 'string' && value.length > 0);
}

function reviewIssues(event: EventRecord): string[] {
  const data = reviewRecord(event.data);
  const outcome = reviewRecord(data.outcome);
  const review = reviewRecord(data.review);
  const rawIssues = data.findings !== undefined ? data.findings
    : outcome.blocking_findings !== undefined ? outcome.blocking_findings
    : outcome.blockingFindings !== undefined ? outcome.blockingFindings
    : outcome.findings !== undefined ? outcome.findings
    : review.findings !== undefined ? review.findings
    : review.issues !== undefined ? review.issues
    : data.blocking_findings !== undefined ? data.blocking_findings
    : data.issues;
  if (rawIssues === undefined) return [];
  if (!Array.isArray(rawIssues)) return ['[unparseable blocking finding]'];
  return rawIssues.map(item => {
    if (typeof item === 'string') return item.trim() || '[unparseable blocking finding]';
    if (!item || typeof item !== 'object' || Array.isArray(item)) return '[unparseable blocking finding]';
    const value = item as Record<string, unknown>;
    const text = [value.summary, value.message, value.finding, value.title, value.id]
      .find(candidate => typeof candidate === 'string' && candidate.trim().length > 0);
    return typeof text === 'string' ? text.trim() : '[unparseable blocking finding]';
  });
}

export function normalizeReviewEvidence(event: EventRecord, task: Task): { headSha: string; issues: string[] } | null {
  const explicitHeadSha = reviewHeadSha(event);
  const headSha = explicitHeadSha ?? (event.type === 'review.approved' ? task.reviewHeadSha : undefined);
  if (!headSha) return null;
  return { headSha, issues: reviewIssues(event) };
}
