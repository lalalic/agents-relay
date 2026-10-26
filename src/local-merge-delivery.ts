import { createHash } from 'node:crypto';
import type { Job, EventRecord } from './types.js';
import { eventFor } from './events.js';
import type { DurableStore } from './store.js';
import { transitionJobEvent } from './task-transitions.js';
import { deliverLocalMerge, localMergeFacts, type LocalMergeReceipt } from './local-git-merge.js';
import { errorMessage } from './observability.js';
import { decideJobLifecycle } from './workflow/lifecycle.js';


export type LocalMergeEffect = (repoPath: string, receipt: LocalMergeReceipt) => { sourceSha: string; mergedCommitSha: string };
/** Graph-selected durable local merge and completion; no checked-out worktree is ever changed. */
export async function reconcileLocalGitCompletion(
  store: DurableStore,
  finalState: Job,
  headSha: string | null,
  noGitHub: boolean,
  projectPathForJob?: (job: Job) => string | Promise<string>,
  emit?: (event: EventRecord) => Promise<void>,
  mergeEffect: LocalMergeEffect = deliverLocalMerge,
  now: () => number = Date.now,
): Promise<boolean> {
  const facts = localMergeFacts(finalState, headSha, now);
  if (decideJobLifecycle(finalState, 'local.completed', facts).target === 'COMPLETED') {
    await transitionJobEvent(finalState, 'local.completed', facts);
    await store.saveJob(finalState);
    return true;
  }
  if (decideJobLifecycle(finalState, 'local.merge.requested', facts).actions.includes('effect.deliverLocalMerge')) {
        const receipt = finalState.localMerge;
        if (!receipt) return false;
        let activeReceipt = receipt;
        if (receipt.status !== 'succeeded' &&
            (!receipt.nextAttemptAt || Date.parse(receipt.nextAttemptAt) <= now())) {
          await transitionJobEvent(finalState, 'local.merge.requested', facts, async actionId => {
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
            const delivered = mergeEffect(repoPath, { ...activeReceipt, sourceSha: activeReceipt.sourceSha ?? headSha ?? undefined,
              correlationJobId: finalState.id, displayPrNumber: finalState.prNumber > 0 ? finalState.prNumber : undefined });
            finalState.localMerge = { ...activeReceipt, ...delivered, status: 'succeeded', projectionStrategy: 'target_ref_push',
              error: undefined, nextAttemptAt: undefined, updatedAt: new Date().toISOString() };
          } catch (error) {
            const attempts = (activeReceipt.attempts ?? 0) + 1;
            finalState.localMerge = { ...activeReceipt, status: 'failed', attempts,
              error: errorMessage(error),
              nextAttemptAt: new Date(now() + Math.min(300_000, 1000 * (2 ** Math.min(attempts, 8)))).toISOString(),
              updatedAt: new Date().toISOString() };
          }
          finalState.updatedAt = new Date().toISOString();
          const merge = finalState.localMerge;
          if (!merge) throw new Error('Graph local merge effect produced no receipt');
          const succeeded = merge.status === 'succeeded';
          const reason = merge.error?.includes('tracked or index changes') ? 'dirty_target_worktree' : 'merge_delivery_failed';
          // Event identity is deterministic for one committed effect outcome.
          const idempotencyBasis = `${finalState.id}:${merge.sourceSha ?? ''}:${merge.attempts ?? 0}:${merge.status}:${merge.mergedCommitSha ?? ''}`;
          const eventKey = `workflow-local-merge-${createHash('sha256').update(idempotencyBasis).digest('hex')}`;
          const outcomeEvent = eventFor(finalState.id, 'merge', null,
            succeeded ? 'job.merge.succeeded' : 'job.merge.failed',
            succeeded ? 'succeeded' : 'failed',
            succeeded ? 'Local merge succeeded' : (merge.error ?? 'Local merge failed'),
            'user', succeeded ? { mergedCommitSha: merge.mergedCommitSha, sourceSha: merge.sourceSha }
              : { reason, message: merge.error, attempts: merge.attempts, retryable: true, nextAttemptAt: merge.nextAttemptAt },
            { id: `job/${finalState.id}/task/merge/execution/attempt-${merge.attempts ?? 0}`, agent: 'relay' });
          outcomeEvent.event_id = eventKey;
          if (store.commitWorkflowMutationAndEvents) {
            // Persist only the Graph-selected merge receipt into the latest
            // authoritative Job; never replace concurrent Task/Review changes.
            const current = await store.commitWorkflowMutationAndEvents(finalState.id, existing => {
              if (existing.state !== 'ACTIVE' || !existing.localMerge
                || existing.localMerge.sourceRef !== receipt.sourceRef
                || existing.localMerge.targetRef !== receipt.targetRef
                || existing.localMerge.status === 'succeeded') throw new Error('stale local merge outcome');
              existing.localMerge = structuredClone(merge);
              existing.updatedAt = finalState.updatedAt;
              return existing;
            }, [{key:eventKey,event:outcomeEvent}]);
            Object.assign(finalState, structuredClone(current));
          } else {
            await store.saveJob(finalState);
            await emit?.(outcomeEvent);
          }
          });
        }
        if (finalState.localMerge?.status === 'succeeded') {
          const completionFacts = localMergeFacts(finalState, headSha, now);
          await transitionJobEvent(finalState, 'local.completed', completionFacts);
          await store.saveJob(finalState);
            return true;
        }
      }
  return false;
}
