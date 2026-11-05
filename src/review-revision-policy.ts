import { createHash } from 'node:crypto';
import type { Job, ReviewRevisionRound } from './types.js';

export type ReviewRevisionLimits = { maxRounds: number; maxNoProgressRounds: number };

function positiveIntegerSetting(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new Error(`${name} must be an integer from 1 to 100`);
  }
  return value;
}

/** Operator-controlled loop bounds; defaults preserve the existing five-round gate. */
export function reviewRevisionLimits(env: NodeJS.ProcessEnv = process.env): ReviewRevisionLimits {
  return {
    maxRounds: positiveIntegerSetting(env, 'AGENTS_RELAY_REVIEW_MAX_ROUNDS', 5),
    maxNoProgressRounds: positiveIntegerSetting(env, 'AGENTS_RELAY_REVIEW_NO_PROGRESS_LIMIT', 1),
  };
}

/** Stable identity for the review findings, independent of ordering and whitespace. */
export function reviewFindingFingerprint(findings: readonly string[]): string | undefined {
  const normalized = [...new Set(findings.map(finding => finding.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')).filter(Boolean))].sort();
  if (!normalized.length) return undefined;
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

/** Derive the fingerprint for pre-field rounds from their durable request evidence. */
export function reviewRoundFindingFingerprint(job: Job, round: ReviewRevisionRound): string | undefined {
  if (round.findingFingerprint) return round.findingFingerprint;
  const findings = (job.reviewRevisionRequests ?? [])
    .filter(request => round.requestIds.includes(request.requestId))
    .flatMap(request => request.findings.map(finding => finding.summary));
  return reviewFindingFingerprint(findings);
}

export function repeatedFindingRounds(job: Job, currentRound: ReviewRevisionRound): number {
  const currentFingerprint = reviewRoundFindingFingerprint(job, currentRound);
  if (!currentFingerprint || currentRound.status !== 'changes_required') return 0;
  let count = 0;
  const previousRounds = (job.reviewRevisionRounds ?? [])
    .filter(round => round.reviewTaskId !== currentRound.reviewTaskId && round.status === 'changes_required')
    .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.reviewTaskId.localeCompare(b.reviewTaskId));
  for (let index = previousRounds.length - 1; index >= 0; index -= 1) {
    if (reviewRoundFindingFingerprint(job, previousRounds[index]) !== currentFingerprint) break;
    count += 1;
  }
  return count;
}
