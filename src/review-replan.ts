import { isFinalReviewAgent } from './final-review-role.js';
import type { Job } from './types.js';
import { pendingTroubleshooterTasks, pendingTroubleshooterReopens, pendingTroubleshooterRetries } from './troubleshooter.js';

const terminal = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);

/** A Final Reviewer reads all terminal outcomes, including failures, not just successes. */
export function reviewWorkSettled(job: Job): boolean {
  const work = job.tasks.filter(task => task.kind !== 'planner' && !isFinalReviewAgent(task.agentName));
  return work.some(task => task.agentName !== 'troubleshooter')
    && work.every(task => terminal.has(task.state) && !['active', 'waiting'].includes(task.resolution?.state ?? ''))
    && !pendingTroubleshooterTasks(job).length
    && !pendingTroubleshooterReopens(job).length
    && !pendingTroubleshooterRetries(job).length;
}

/** New reviews use Review -> Replan; older persisted targeted revisions remain recoverable. */
export function reviewNeedsReplan(job: Job): boolean {
  const review = job.review;
  if (!review?.taskId || review.revisionDisposition === 'targeted') return false;
  const changes = review.outcome === 'changes_required'
    || (review.outcome === 'stale' && (job.reviewRevisionRounds ?? []).some(round =>
      round.reviewTaskId === review.taskId && round.status === 'changes_required'));
  return changes && !(job.plans ?? []).some(plan =>
    plan.trigger.source === 'review' && plan.trigger.reviewTaskId === review.taskId && plan.status !== 'FAILED');
}

/** Re-review a new committed head after work/planning settles, regardless of Planner bookkeeping. */
export function reviewPlanReady(job: Job, currentHeadSha: string | null = job.headSha ?? null): boolean {
  if ((job.plans ?? []).some(plan => plan.status === 'PLANNING')) return false;
  const latest = (job.plans ?? []).at(-1);
  const legacy = !latest && job.tasks.some(task => task.kind === 'planner' && task.state === 'SUCCEEDED');
  // A plan-free Graph Job has no Planner round to wait for. Final Review
  // still validates its durable Agent Tasks under the same Job lifecycle.
  if (!legacy && latest && latest.status !== 'SUCCEEDED') return false;
  if (!job.tasks.some(task => task.kind !== 'planner' && !isFinalReviewAgent(task.agentName))) return false;
  const review = job.review;
  if (!review?.taskId || review.revisionDisposition === 'targeted') return true;
  const requiresRevision = review.outcome === 'changes_required'
    || (review.outcome === 'stale' && (job.reviewRevisionRounds ?? []).some(round =>
      round.reviewTaskId === review.taskId && round.status === 'changes_required'));
  if (!requiresRevision) return true;
  // Re-review requires a changed immutable source ref. Planner provenance
  // may be incomplete (an initial Plan can own a valid repair), so it is audit
  // data rather than an additional eligibility gate.
  return Boolean(currentHeadSha && review.headSha && currentHeadSha !== review.headSha);
}
