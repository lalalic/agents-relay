import type { Job, Task } from './types.js';

function dependencySatisfied(task: Task, byId: ReadonlyMap<string, Task>): boolean {
  return task.dependencies.every(id => {
    const dependency = byId.get(id);
    return dependency?.state === 'SUCCEEDED'
      || (dependency?.resolutionClassification?.kind === 'superseded'
        && byId.get(dependency.resolutionClassification.targetTaskId)?.state === 'SUCCEEDED');
  });
}

/** Checks durable post-reconcile evidence; it never schedules or mutates work. */
export function forceRestateConverged(job: Job, planId?: string): boolean {
  return job.state === 'COMPLETED' || forceRestateRunnable(job) || forceRestateBlocked(job, planId);
}

export function forceRestateRunnable(job: Job): boolean {
  const byId = new Map(job.tasks.map(task => [task.id, task]));
  const runnable = job.tasks.some(task => {
    const worker = task.workerSelection;
    const required = task.workerRequirements?.capabilities ?? task.capabilities;
    return task.kind !== 'planner'
      && ['QUEUED', 'RUNNING'].includes(task.state)
      && dependencySatisfied(task, byId)
      && Boolean(task.adapter && task.routing && worker)
      && worker !== undefined
      && worker.adapter === task.adapter
      && required.every(capability => worker.capabilities.includes(capability))
      && (task.state !== 'RUNNING' || Boolean(task.executionId && task.leaseOwner));
  });
  return runnable;
}

export function forceRestateBlocked(job: Job, planId?: string): boolean {
  if (!planId) return false;
  return job.tasks.some(task => task.agentName === 'troubleshooter' && task.recoveryPlanId === planId && task.state === 'BLOCKED'
    && typeof task.error === 'string' && task.error.trim().length > 0
    && typeof task.result?.data?.evidence === 'string' && task.result.data.evidence.trim().length > 0
    && typeof task.result?.data?.unblock_conditions === 'string' && task.result.data.unblock_conditions.trim().length > 0);
}
