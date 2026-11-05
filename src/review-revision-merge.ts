import type { Job } from './types.js';

/** Revision and Review-round provenance belongs exclusively to local SQLite.
 * Collaboration projections must NEVER invent or advance these records.
 * The remote snapshot may be newer for other data, but it is not the source
 * of operational review requests, statuses, or execution generations.
 */
export function preserveReviewRevisionHistory(local: Job, merged: Job): void {
  if (local.reviewRevisionRequests) merged.reviewRevisionRequests = structuredClone(local.reviewRevisionRequests);
  else delete merged.reviewRevisionRequests;
  if (local.reviewRevisionRounds) merged.reviewRevisionRounds = structuredClone(local.reviewRevisionRounds);
  else delete merged.reviewRevisionRounds;
}
