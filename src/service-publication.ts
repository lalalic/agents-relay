import type { Job } from './types.js';
import type { GitHubWebhookWake } from './github-webhook.js';
import type { EventBus } from './events.js';
import { eventFor } from './events.js';
import { SQLiteRelayStore, relayStoreDirectory, relayStorePath, relayUnifiedStorePath, unifiedRelayStoreEnabled } from './relay-store.js';

/** Single-Job service uses the same durable publish facts as the repository daemon. */
export async function handleServicePublication(
  job: Job,
  wake: GitHubWebhookWake,
  bus?: EventBus,
  directory = relayStoreDirectory(),
): Promise<void> {
  if (!wake.publication && !wake.publishFailure) return;
  const sqlite = new SQLiteRelayStore(unifiedRelayStoreEnabled() ? relayUnifiedStorePath(directory) : relayStorePath(directory, job.repository, job.prNumber), unifiedRelayStoreEnabled() ? job.id : undefined);
  try {
    await sqlite.recordPublication(job.id, wake.deliveryId,
      wake.publication, wake.publishFailure ?? null, wake.publicationObservedAt);
  } finally {
    sqlite.close();
  }
  if (bus) {
    if (wake.publication) {
      const event = eventFor(job.id, 'release', null, 'package.published', 'succeeded',
        'Published ' + wake.publication.package + '@' + wake.publication.version, 'orchestrator',
        { ...wake.publication, deliveryId: wake.deliveryId, repository: job.repository, prNumber: job.prNumber });
      event.event_id = 'github:' + job.id + ':' + wake.deliveryId + ':package.published';
      await bus.publish(event);
    }
    if (wake.publishFailure) {
      const event = eventFor(job.id, 'release', null, 'package.publish_failed', 'failed',
        'Publish failed: ' + wake.publishFailure.stage, 'orchestrator',
        { ...wake.publishFailure, deliveryId: wake.deliveryId, repository: job.repository, prNumber: job.prNumber });
      event.event_id = 'github:' + job.id + ':' + wake.deliveryId + ':package.publish_failed';
      await bus.publish(event);
    }
  }
  // Do not use a publication event to forge a Job state change.
}
