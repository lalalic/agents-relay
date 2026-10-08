import { storeFor, arg, hasArg, withEventBus, requestManagedReconciliation } from './cli-support.js';
import { normalizeThreadId } from './reviewer-thread.js';

export async function runReviewCommand(action: string, reviewArgs: string[]): Promise<void> {
  if (action !== 'request') throw new Error('review supports: request');
  if (!arg(reviewArgs, '--repo') || !arg(reviewArgs, '--pr') || !arg(reviewArgs, '--id')) throw new Error('review request requires --repo, --pr and --id');
  if (!hasArg(reviewArgs, '--thread-id')) throw new Error('review request requires --thread-id');
  const threadId = normalizeThreadId(arg(reviewArgs, '--thread-id'), '--thread-id');
  const { store, job, localFile } = await storeFor(reviewArgs);
  if (localFile) throw new Error('review request requires a managed GitHub Job');
  if (job.state === 'CANCELLED' || job.state === 'COMPLETED') throw new Error('Cannot request review for terminal Job');
  if (!job.reviewEnabled) throw new Error('Review disabled for this Job');
  if (job.tasks.some(task => task.agentName === 'reviewer' && ['RUNNING','QUEUED','DRAFT'].includes(task.state))) throw new Error('Review already queued or running; refusing duplicate request');
  if (job.review?.outcome === 'approved') throw new Error('Current head already approved; review request not needed');
  job.reviewerThreadId = threadId;
  job.updatedAt = new Date().toISOString();
  await store.saveJob(job);
  await withEventBus(reviewArgs, async bus => requestManagedReconciliation(bus, job));
  console.log(JSON.stringify({ jobId: job.id, pr: job.prNumber, reviewerThreadId: threadId, status: 'requested', note: 'Relay graph will create the review Task once eligible; this is not a delivery receipt.' }, null, 2));
  return;
}
