import { arg, hasArg, relayControlCommand } from './cli-support.js';
import { normalizeThreadId } from './reviewer-thread.js';
import { runOutcomeReview } from './outcome-review.js';

export function reviewRequestThreadOverride(args: readonly string[]): string | undefined {
  const values = [...args];
  return hasArg(values, '--thread-id')
    ? normalizeThreadId(arg(values, '--thread-id'), '--thread-id')
    : undefined;
}

export async function runReviewCommand(action: string, reviewArgs: string[]): Promise<void> {
  if (action === 'run') return runOutcomeReview(reviewArgs);
  if (action !== 'job') throw new Error('review supports: job | run');
  const jobId = arg(reviewArgs, '--id');
  if (!arg(reviewArgs, '--repo') || !jobId) throw new Error('review job requires --repo and --id');
  const threadId = reviewRequestThreadOverride(reviewArgs);
  const job = await relayControlCommand<any>(reviewArgs, { command: 'review.request', jobId, ...(threadId !== undefined ? { threadId } : {}) });
  console.log(JSON.stringify({ jobId: job.id, pr: job.prNumber ?? 0, reviewerThreadId: job.reviewerThreadId ?? null, status: 'requested', note: 'Relay graph will create the review Task once eligible; this is not a delivery receipt.' }, null, 2));
}
