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

/** An immutable re-review must wait for the finding-driven Plan and its work to settle. */
export function reviewPlanReady(job: Job): boolean {
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
  return (job.plans ?? []).some(plan => plan.status === 'SUCCEEDED'
    && plan.trigger.source === 'review' && plan.trigger.reviewTaskId === review.taskId);
}
