import type { Job } from './types.js';

/**
 * One active execution per Job, irrespective of adapter or current reconciler.
 * A claimed QUEUED execution also occupies the slot; synchronous P0/self work
 * occupies it by its RUNNING state even though it has no execution UUID.
 */
export function jobHasActiveExecution(job: Job, except: { taskId?: string; planId?: string } = {}): boolean {
  const worker = job.tasks.some(task => task.id !== except.taskId
    && (task.state === 'RUNNING' || (task.executionId !== null && !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.state))));
  const planner = (job.plans ?? []).some(plan => plan.id !== except.planId
    && plan.executionId !== null && plan.status === 'PLANNING');
  return worker || planner;
}
