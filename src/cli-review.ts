import { arg, hasArg, relayControlCommand } from './cli-support.js';
import { normalizeThreadId } from './reviewer-thread.js';

export function reviewRequestThreadOverride(args: readonly string[]): string | undefined {
  const values = [...args];
  return hasArg(values, '--thread-id')
    ? normalizeThreadId(arg(values, '--thread-id'), '--thread-id')
    : undefined;
}

export async function runReviewCommand(action: string, reviewArgs: string[]): Promise<void> {
  if (action !== 'request') throw new Error('review supports: request');
  const jobId = arg(reviewArgs, '--id');
  if (!arg(reviewArgs, '--repo') || !jobId) throw new Error('review request requires --repo and --id');
  const threadId = reviewRequestThreadOverride(reviewArgs);
  const job = await relayControlCommand<any>(reviewArgs, { command: 'review.request', jobId, ...(threadId !== undefined ? { threadId } : {}) });
  console.log(JSON.stringify({ jobId: job.id, pr: job.externalPrNumber ?? job.prNumber ?? 0, reviewerThreadId: job.reviewerThreadId ?? null, status: 'requested', note: 'Relay graph will create the review Task once eligible; this is not a delivery receipt.' }, null, 2));
}
