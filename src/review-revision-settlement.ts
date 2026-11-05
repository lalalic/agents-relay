import type { DurableStore } from './store.js';
import { appendTaskComment } from './task-comments.js';
import type { Job } from './types.js';
import { dispatchReviewLifecycle } from './workflow/review-v2.js';
import { repeatedFindingRounds, reviewRevisionLimits, type ReviewRevisionLimits } from './review-revision-policy.js';

/** Pure durable facts for the canonical Review Graph, not an alternate decision engine. */
function settlementFacts(job: Job, taskId: string, limits: ReviewRevisionLimits) {
  const requests = (job.reviewRevisionRequests ?? []).filter(item => item.reviewTaskId === taskId);
  const targetedRevisionsVerified = requests.length > 0 && requests.every(request =>
    request.status === 'verified' && job.tasks.some(task => task.id === request.revisionTaskId && task.state === 'SUCCEEDED'));
  const rounds = (job.reviewRevisionRounds ?? []).filter(item => item.status === 'changes_required');
  const currentRound = rounds.find(item => item.reviewTaskId === taskId);
  return {
    targetedRevisionsVerified,
    reviewRoundWithinLimit: rounds.length < limits.maxRounds,
    reviewNoProgressWithinLimit: !currentRound || repeatedFindingRounds(job, currentRound) < limits.maxNoProgressRounds,
  };
}

/** The Graph alone decides whether the verified round can proceed or must escalate. */
export async function settleReviewRevisionRound(store: DurableStore, job: Job): Promise<Job> {
  if (!store.mutateJob) return job;
  const review = job.review;
  if (review?.outcome !== 'changes_required' || review.revisionDisposition !== 'targeted' || !review.taskId) return job;
  const limits = reviewRevisionLimits();
  const facts = settlementFacts(job, review.taskId, limits);
  const decision = await dispatchReviewLifecycle(review.outcome, 'revision.settled', facts);
  if (!decision.accepted) return job;
  const action = decision.actions.map(item => item.id);
  const prepare = decision.accepted && decision.target === 'STALE' && action.includes('review.prepareRereview');
  const exhausted = decision.accepted && decision.target === 'CHANGES_REQUIRED' && action.includes('review.requireOwnerResolution');
  if (!prepare && !exhausted) return job;
  return store.mutateJob(job.id, current => {
    const latest = current.review;
    if (latest?.outcome !== 'changes_required' || latest.revisionDisposition !== 'targeted'
      || latest.taskId !== review.taskId || latest.headSha !== review.headSha) return current;
    const currentFacts = settlementFacts(current, review.taskId!, limits);
    if (Object.keys(facts).some(key => currentFacts[key as keyof typeof facts] !== facts[key as keyof typeof facts])) return current;
    const at = new Date().toISOString();
    if (exhausted) {
      current.review = { ...latest, revisionDisposition: 'needs-ownership', updatedAt: at };
      const reason = !currentFacts.reviewRoundWithinLimit
        ? `Targeted review loop reached its configured ${limits.maxRounds}-round limit`
        : `The same blocking findings recurred without progress ${limits.maxNoProgressRounds} time(s)`;
      appendTaskComment(current, review.taskId!, `${reason}; explicit Planner/owner recovery required. No approval or merge authorized.`,
        { author: 'relay', idempotencyKey: 'review-round-limit/' + review.taskId });
    } else {
      current.review = { ...latest, outcome: 'stale', updatedAt: at };
    }
    return current;
  });
}
