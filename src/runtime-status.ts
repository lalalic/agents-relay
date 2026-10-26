import { Job, JobRuntimeStatus, Task } from './types.js';

export type PullRequestRuntimeState = 'UNKNOWN' | 'OPEN' | 'MERGED' | 'CLOSED';

function isSuperseded(task: Task): boolean {
  return task.state === 'CANCELLED' && ((task.resolution?.path === 'cancel_supersede' && task.resolution.state === 'resolved')
    || (typeof task.error === 'string' && task.error.startsWith('Superseded ')));
}

export function implementationTasks(job: Job): Task[] {
  return job.tasks.filter(task => task.kind !== 'planner'
    && task.agentName !== 'reviewer'
    && task.agentName !== 'troubleshooter'
    && !isSuperseded(task)
    && task.state !== 'DRAFT');
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

  const currentPlan = job.plans?.at(-1);
  // An unresolved planner failure is a Job failure, not an idle Job.
  // Active task execution still takes precedence below.
  const plannerFailed = currentPlan?.status === 'FAILED' && !job.tasks.some(task => ['QUEUED','RUNNING'].includes(task.state));
  const plannerRunning = currentPlan?.status === 'PLANNING';

  // Draft or queued reviewers must not mask implementation that is still active.
  const implementation = implementationTasks(job);
  if (implementation.some(task => task.state === 'RUNNING')) return 'RUNNING';
  if (implementation.some(task => task.state === 'QUEUED')) return 'QUEUED';

  const reviewRunning = job.tasks.some(task => task.agentName === 'reviewer' && task.state === 'RUNNING');
  if (job.review?.outcome === 'approved') return 'MERGE_PENDING';
  if (reviewRunning) return 'REVIEWING';

  if (job.tasks.some(task => task.state === 'RUNNING')) return 'RUNNING';
  if (job.tasks.some(task => task.state === 'QUEUED')) return 'QUEUED';
  if (job.tasks.some(task => task.state === 'BLOCKED')) return 'BLOCKED';
  if (job.tasks.some(task => task.state === 'FAILED')) return 'FAILED';
  if (job.tasks.some(task => task.state === 'DRAFT')) return 'WAITING';
  if (plannerFailed) return 'FAILED';
  if (plannerRunning) return 'RUNNING';

  if (job.reviewEnabled === false && implementationComplete(job) ) return 'MERGE_PENDING';
  return 'IDLE';
}
