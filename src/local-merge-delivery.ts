import type { Job } from './types.js';
import type { DurableStore } from './store.js';
import { transitionJobEvent } from './scheduler.js';
import { deliverLocalMerge, localMergeEligible, requiresLocalGitMerge } from './local-git-merge.js';
import { errorMessage } from './observability.js';


/** Graph-selected durable local merge and completion; no checked-out worktree is ever changed. */
export async function reconcileLocalGitCompletion(
  store: DurableStore,
  finalState: Job,
  headSha: string | null,
  noGitHub: boolean,
  projectPathForJob?: (job: Job) => string | Promise<string>,
): Promise<boolean> {
  if (localMergeEligible(finalState) && !requiresLocalGitMerge(finalState)) {
        await transitionJobEvent(finalState, 'local.completed', { localCompletionAllowed: true });
        await store.saveJob(finalState);
        return true;
      }
  if (localMergeEligible(finalState) &&
        finalState.localMerge && (!finalState.reviewEnabled || finalState.review?.headSha === headSha)) {
        const receipt = finalState.localMerge;
        let activeReceipt = receipt;
        if (receipt.status !== 'succeeded' &&
            (!receipt.nextAttemptAt || Date.parse(receipt.nextAttemptAt) <= Date.now())) {
          await transitionJobEvent(finalState, 'local.merge.requested', { localMergeReady: true }, async actionId => {
          if (actionId !== 'effect.deliverLocalMerge') throw new Error('Unsupported local merge Graph effect ' + actionId);
          try {
            if (receipt.sourceSha !== headSha && headSha) {
              activeReceipt = { ...receipt, sourceSha: headSha, status: 'pending' };
              finalState.localMerge = activeReceipt;
              finalState.updatedAt = new Date().toISOString();
              await store.saveJob(finalState);
            }
            if (!projectPathForJob) throw new Error('Local Git merge requires an explicit project path');
            const repoPath = await projectPathForJob(finalState);
            const delivered = deliverLocalMerge(repoPath, { ...activeReceipt, sourceSha: activeReceipt.sourceSha ?? headSha ?? undefined,
              correlationJobId: finalState.id, displayPrNumber: finalState.prNumber > 0 ? finalState.prNumber : undefined });
            finalState.localMerge = { ...activeReceipt, ...delivered, status: 'succeeded', projectionStrategy: 'target_ref_push',
              error: undefined, nextAttemptAt: undefined, updatedAt: new Date().toISOString() };
          } catch (error) {
            const attempts = (activeReceipt.attempts ?? 0) + 1;
            finalState.localMerge = { ...activeReceipt, status: 'failed', attempts,
              error: errorMessage(error),
              nextAttemptAt: new Date(Date.now() + Math.min(300_000, 1000 * (2 ** Math.min(attempts, 8)))).toISOString(),
              updatedAt: new Date().toISOString() };
          }
          finalState.updatedAt = new Date().toISOString();
          await store.saveJob(finalState);
          });
        }
        if (finalState.localMerge?.status === 'succeeded') {
          await transitionJobEvent(finalState, 'local.completed', { localCompletionAllowed: true });
          await store.saveJob(finalState);
            return true;
        }
      }
  return false;
}
