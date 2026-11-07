import { arg, hasArg, relayControlCommand } from './cli-support.js';
import { normalizeThreadId } from './reviewer-thread.js';
import { runOutcomeReview } from './outcome-review.js';

export function reviewRequestThreadOverride(args: readonly string[]): string | undefined {
  const values = [...args];
  return hasArg(values, '--thread-id')
    ? normalizeThreadId(arg(values, '--thread-id'), '--thread-id')
    : undefined;
}

/** Stable local CLI contract for Neo MCP's single-call interactive preview. */
export async function runInteractiveReviewCommand(argv: string[]): Promise<void> {
  const [action,...args]=argv;
  const commands=['begin','wait','ready','fail','abort'];
  if(!action||!commands.includes(action))throw new Error('review interactive requires begin|wait|ready|fail|abort');
  const jobId=arg(args,'--id');
  const taskId=arg(args,'--task-id');
  const executionId=arg(args,'--execution-id');
  const invocationId=arg(args,'--invocation-id');
  if(!jobId||!taskId||!executionId)throw new Error('review interactive requires --id --task-id --execution-id');
  if(action!=='begin'&&!invocationId)throw new Error('review interactive '+action+' requires --invocation-id');
  const revision=arg(args,'--revision');
  if(action==='ready'&&!/^[a-f0-9]{40}$/.test(revision))throw new Error('review interactive ready requires full 40-character Git Commit SHA');
  if(action==='fail'&&!arg(args,'--reason').trim())throw new Error('review interactive fail requires --reason');
  const body:Record<string,unknown>={command:`review.interactive.${action}`,jobId,taskId,executionId};
  if(action!=='begin')body.invocationId=invocationId;
  if(action==='ready')body.revision=revision;
  if(action==='fail')body.reason=arg(args,'--reason');
  console.log(JSON.stringify(await relayControlCommand(args,body)));
}

export async function runReviewCommand(action: string, reviewArgs: string[]): Promise<void> {
  if (action === 'run') return runOutcomeReview(reviewArgs);
  if (action === 'interactive') return runInteractiveReviewCommand(reviewArgs);
  if (action !== 'job') throw new Error('review supports: job | run | interactive');
  const jobId = arg(reviewArgs, '--id');
  if (!arg(reviewArgs, '--repo') || !jobId) throw new Error('review job requires --repo and --id');
  const threadId = reviewRequestThreadOverride(reviewArgs);
  const job = await relayControlCommand<any>(reviewArgs, { command: 'review.request', jobId, ...(threadId !== undefined ? { threadId } : {}) });
  console.log(JSON.stringify({ jobId: job.id, pr: job.prNumber ?? 0, reviewerThreadId: job.reviewerThreadId ?? null, status: 'requested', note: 'Relay graph will create the review Task once eligible; this is not a delivery receipt.' }, null, 2));
}
