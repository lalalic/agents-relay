import type { Job } from './types.js';

/** Stable internal review lifecycle role with a new externally visible Agent identity. */
export const FINAL_REVIEW_AGENT = 'job-acceptance-reviewer' as const;
export function isFinalReviewAgent(name: string | null | undefined): boolean {
  return name === FINAL_REVIEW_AGENT || name === 'reviewer';
}

export function nextFinalReviewTaskId(job: Job, headSha: string): string {
  const base = 'final-review-' + headSha.slice(0, 12);
  const ids = new Set(job.tasks.filter(task => task.reviewHeadSha === headSha && isFinalReviewAgent(task.agentName)).map(task => task.id));
  if (!ids.has(base)) return base;
  for (let round = 2; round < 1000; round += 1) {
    const candidate = base + '-r' + round;
    if (!ids.has(candidate)) return candidate;
  }
  throw new Error('Too many final review rounds for ' + headSha);
}
