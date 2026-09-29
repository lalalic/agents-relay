import { Job, JobRuntimeStatus, Task } from './types.js';

export type PullRequestRuntimeState = 'OPEN' | 'MERGED' | 'CLOSED';

function isSuperseded(task: Task): boolean {
  return task.state === 'CANCELLED' && typeof task.error === 'string' && task.error.startsWith('Superseded ');
}

export function implementationTasks(job: Job): Task[] {
  return job.tasks.filter(task => task.agentName !== 'reviewer'
    && task.agentName !== 'troubleshooter'
    && !isSuperseded(task)
    && !(task.state === 'BLOCKED' && task.unblock));
}

export function implementationComplete(job: Job): boolean {
  const tasks = implementationTasks(job);
  return tasks.length > 0 && tasks.every(task => task.state === 'SUCCEEDED');
}

export function deriveJobRuntimeStatus(job: Job, prState: PullRequestRuntimeState = 'OPEN'): JobRuntimeStatus {
  if (prState === 'MERGED') return 'MERGED';
  if (prState === 'CLOSED' || job.state === 'CANCELLED') return 'CANCELLED';
  if (job.state === 'DRAFT') return 'IDLE';

  if (job.schedule) {
    if (job.tasks.some(task => task.state === 'RUNNING')) return 'RUNNING';
    if (job.tasks.some(task => task.state === 'QUEUED')) return 'QUEUED';
    if (job.tasks.some(task => task.state === 'BLOCKED' && !task.unblock)) return 'BLOCKED';
    if (job.tasks.some(task => task.state === 'FAILED')) return 'FAILED';
    if (job.tasks.some(task => task.state === 'DRAFT')) return 'WAITING';
    return 'WAITING';
  }

  const reviewTasks = job.tasks.filter(task => task.agentName === 'reviewer');
  const reviewActive = reviewTasks.some(task => ['DRAFT', 'QUEUED', 'RUNNING'].includes(task.state))
    || job.review?.outcome === 'pending'
    || job.review?.outcome === 'started';
  if (job.review?.outcome === 'approved' && prState === 'OPEN') return 'MERGE_PENDING';
  if (reviewActive || (job.reviewEnabled !== false && implementationComplete(job) && job.review?.outcome !== 'approved')) return 'REVIEWING';

  if (job.tasks.some(task => task.state === 'RUNNING')) return 'RUNNING';
  if (job.tasks.some(task => task.state === 'QUEUED')) return 'QUEUED';
  if (job.tasks.some(task => task.state === 'BLOCKED' && !task.unblock)) return 'BLOCKED';
  if (job.tasks.some(task => task.state === 'FAILED')) return 'FAILED';
  if (job.tasks.some(task => task.state === 'DRAFT')) return 'WAITING';

  if (job.executionMode === 'autonomous' && job.autoMerge === false && job.reviewEnabled === false && implementationComplete(job) && prState === 'OPEN') return 'WAITING';
  if (job.reviewEnabled === false && implementationComplete(job) && prState === 'OPEN') return 'MERGE_PENDING';
  return 'IDLE';
}
