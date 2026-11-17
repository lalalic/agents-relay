import type { EventBus } from './events.js';
import { eventFor } from './events.js';
import type { ProjectionFailureDeduplicator } from './projection-failure-dedupe.js';
import type { Job } from './types.js';
import type { SQLiteRelayStore } from './relay-store.js';
import { classifyFailure, errorMessage, observability } from './observability.js';

/** Historical compatibility hook: remote delivery failures are observational only. */
export async function handleGitHubProjectionFailure(
  error: unknown,
  job: Job,
  _snapshotPath: string,
  options: { eventBus?: EventBus; deduplicator: ProjectionFailureDeduplicator },
): Promise<void> {
  const reason = errorMessage(error), classification = classifyFailure(error).classification;
  if (!options.deduplicator.shouldReport(job.id, job.updatedAt, reason, classification)) return;
  await options.eventBus?.publish(eventFor(job.id,'projection',null,'projection.delivery_failed','failed',
    `Optional remote delivery failed: ${reason}`,'orchestrator',
    {operation:'remote.deliverLocalMain',error:reason},
    {agent:'relay',component:'remote-delivery'})).catch(()=>{});
  observability().record({ stage:'projection', event:'remote.delivery_failed', level:'warn', outcome:'failed',
    message:`Optional remote delivery failed for ${job.id}: ${reason}`,
    correlation:{repository:job.repository,jobId:job.id}, data:{classification,reason} });
}

export type { SQLiteRelayStore };
