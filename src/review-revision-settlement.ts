import type { DurableStore } from './store.js';
import type { Job } from './types.js';
import { dispatchReviewLifecycle } from './workflow/review-v2.js';

/** SHA-bound review settlement: only Graph-authorized all-verified revision rounds rerun full Job review. */
export async function settleReviewRevisionRound(store: DurableStore, job: Job): Promise<Job> {
    if (!store.mutateJob) return job;
    const review = job.review;
    if (review?.outcome !== 'changes_required' || review.revisionDisposition !== 'targeted' || !review.taskId) return job;
    const requests = (job.reviewRevisionRequests ?? []).filter(item => item.reviewTaskId === review.taskId);
    const allVerified = requests.length > 0 && requests.every(request => request.status === 'verified'
      && job.tasks.some(task => task.id === request.revisionTaskId && task.state === 'SUCCEEDED'));
    const withinLimit = (job.reviewRevisionRounds ?? []).filter(item => item.status === 'changes_required').length < 5;
    const decision = await dispatchReviewLifecycle(review.outcome, 'revision.settled', {
      targetedRevisionsVerified: allVerified, reviewRoundWithinLimit: withinLimit,
    });
    if (!decision.accepted || decision.target !== 'STALE'
      || !decision.actions.some(action => action.id === 'review.prepareRereview')) return job;
    return store.mutateJob(job.id, current => {
      if (current.review?.outcome !== 'changes_required' || current.review.taskId !== review.taskId
        || current.review.headSha !== review.headSha || current.review.revisionDisposition !== 'targeted') return current;
      const currentRequests = (current.reviewRevisionRequests ?? []).filter(item => item.reviewTaskId === review.taskId);
      if (!currentRequests.length || !currentRequests.every(request => request.status === 'verified'
        && current.tasks.some(task => task.id === request.revisionTaskId && task.state === 'SUCCEEDED'))
        || (current.reviewRevisionRounds ?? []).filter(item => item.status === 'changes_required').length >= 5) return current;
      current.review = { ...current.review, outcome: 'stale', updatedAt: new Date().toISOString() };
      return current;
    });
}
