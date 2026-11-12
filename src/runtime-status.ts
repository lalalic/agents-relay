import { isFinalReviewAgent } from './final-review-role.js';
import { Job, JobRuntimeStatus, Task } from './types.js';

export type PullRequestRuntimeState = 'UNKNOWN' | 'OPEN' | 'MERGED' | 'CLOSED';

export function isSuperseded(task: Task, byId: ReadonlyMap<string, Task>): boolean {
  if (task.state === 'CANCELLED' && task.resolution?.path === 'cancel_supersede' && task.resolution.state === 'resolved') return true;
  const classification = task.resolutionClassification;
  return task.state === 'FAILED' && classification?.kind === 'superseded'
    && typeof classification.targetTaskId === 'string' && Boolean(classification.targetTaskId.trim())
    && typeof classification.evidence === 'string' && Boolean(classification.evidence.trim())
    && typeof classification.reason === 'string' && Boolean(classification.reason.trim())
    && byId.get(classification.targetTaskId)?.state === 'SUCCEEDED';
}

function staleTargetedRevisionTaskIds(job: Job): Set<string> {
  return new Set((job.reviewRevisionRequests ?? [])
    .filter(request => request.status === 'stale' && request.revisionTaskId)
    .map(request => request.revisionTaskId!));
}

export function implementationTasks(job: Job): Task[] {
  const byId = new Map(job.tasks.map(task => [task.id, task]));
  const staleRevisions = staleTargetedRevisionTaskIds(job);
  return job.tasks.filter(task => task.kind !== 'planner'
    && !isFinalReviewAgent(task.agentName)
    && task.agentName !== 'troubleshooter'
    && !isSuperseded(task, byId)
    && !staleRevisions.has(task.id)
    && (task.state !== 'DRAFT' || Boolean(task.revision)));
}

export function implementationComplete(job: Job): boolean {
  const tasks = implementationTasks(job);
  return tasks.length > 0 && tasks.every(task => task.state === 'SUCCEEDED');
}

export function deriveJobRuntimeStatus(job: Job, _prState: PullRequestRuntimeState = 'OPEN'): JobRuntimeStatus {
  // External PR state is display metadata, never a Job runtime state input.
  if (job.state === 'CANCELLED') return 'CANCELLED';
  if (job.state === 'COMPLETED') return 'COMPLETED';
  if (job.state === 'DRAFT') return 'IDLE';

  // A DAG Coordinator is not a leased worker. Human review waiting takes
  // precedence unless another Agent Task is genuinely running.
  if (job.tasks.some(t=>t.state==='AWAITING_DECISION') &&
      !job.tasks.some(t=>t.state==='RUNNING' && t.executionId!==null && t.leaseOwner)) return 'WAITING';

  const currentPlan = job.plans?.at(-1);
  // An unresolved planner failure is a Job failure, not an idle Job.
  // Active task execution still takes precedence below.
  const plannerFailed = currentPlan?.status === 'FAILED' && !job.tasks.some(task => ['QUEUED','RUNNING'].includes(task.state));
  const plannerRunning = currentPlan?.status === 'PLANNING';

  // Draft or queued reviewers must not mask implementation that is still active.
  const implementation = implementationTasks(job);
  if (implementation.some(task => task.state === 'RUNNING')) return 'RUNNING';
  if (implementation.some(task => task.state === 'QUEUED')) return 'QUEUED';

  const reviewRunning = job.tasks.some(task => isFinalReviewAgent(task.agentName) && task.state === 'RUNNING');
  if (job.review?.outcome === 'approved') return 'MERGE_PENDING';
  if (reviewRunning) return 'REVIEWING';

  if (job.tasks.some(task => task.state === 'RUNNING')) return 'RUNNING';
  if (job.tasks.some(task => task.state === 'QUEUED')) return 'QUEUED';
  if (job.tasks.some(task => task.state === 'BLOCKED')) return 'BLOCKED';
  const staleRevisions = staleTargetedRevisionTaskIds(job);
  if (job.tasks.some(task => task.state === 'FAILED' && !staleRevisions.has(task.id))) return 'FAILED';
  if (job.tasks.some(task => task.state === 'AWAITING_DECISION' || task.state === 'DRAFT')) return 'WAITING';
  if (plannerFailed) return 'FAILED';
  if (plannerRunning) return 'RUNNING';

  if (job.reviewEnabled === false && implementationComplete(job) ) return 'MERGE_PENDING';
  return 'IDLE';
}
