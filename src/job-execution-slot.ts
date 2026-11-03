import type { Job } from './types.js';

/**
 * One active execution per Job, irrespective of adapter or current reconciler.
 * A claimed QUEUED execution also occupies the slot; synchronous P0/self work
 * occupies it by its RUNNING state even though it has no execution UUID.
 */
export function jobHasActiveExecution(job: Job, except: { taskId?: string; planId?: string } = {}): boolean {
  const worker = job.tasks.some(task => {
    if (task.id === except.taskId) return false;
    const shortcut = task.result?.data?.shortcut;
    const durableWait = job.executionMode === 'shortcut' && job.contentOnly === true && task.state === 'RUNNING'
      && task.leaseOwner === null && shortcut && typeof shortcut === 'object'
      && (shortcut as { waits?: Record<string, unknown> }).waits
      && Object.keys((shortcut as { waits: Record<string, unknown> }).waits).length > 0;
    return !durableWait && (task.state === 'RUNNING' || (task.executionId !== null && !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.state)));
  });
  const planner = (job.plans ?? []).some(plan => plan.id !== except.planId
    && plan.executionId !== null && plan.status === 'PLANNING');
  return worker || planner;
}
