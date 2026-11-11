import type {Job, Task} from './types.js';

/** The first Shortcut launch is ALWAYS explicit. Only a previously suspended,
 * human-decided node may be auto-resumed through the shared Relay Worker Pool.
 * No separate queue, timer, or scheduler owns these Task transitions.
 */
export function shortcutAutoResumeTask(job: Job): Task | null {
  if (job.executionMode !== 'shortcut' || job.contentOnly !== true || job.state !== 'ACTIVE' ||
      job.pause || !job.shortcutRunnerContext || !job.shortcutRunnerContext.projectPath || !job.shortcutRunnerContext.workspaceRoot ||
      !job.shortcutExecutionStartedAt || !Number.isFinite(Date.parse(job.shortcutExecutionStartedAt))) return null;
  for (const task of job.tasks) {
    if (!task.agentGraph || task.state !== 'QUEUED' || task.executionId !== null || task.leaseOwner !== null) continue;
    const review=task.interactiveInvocation;
    const cp=task.result?.data?.shortcut as {inFlight?:Record<string,string>}|undefined;
    const pending=Object.entries(cp?.inFlight ?? {});
    if (pending.length !== 1 || !review?.decidedAt ||
        !['approved','changes_requested'].includes(review.status) ||
        review.executionId !== pending[0][1] || !/^[a-f0-9]{40}$/.test(review.revision) ||
        typeof review.invocationId !== 'string' || !review.invocationId) continue;
    return task;
  }
  return null;
}
