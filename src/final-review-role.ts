/** Stable internal review lifecycle role with a new externally visible Agent identity. */
export const FINAL_REVIEW_AGENT = 'job-acceptance-reviewer' as const;
export function isFinalReviewAgent(name: string | null | undefined): boolean {
  return name === FINAL_REVIEW_AGENT || name === 'reviewer';
}
