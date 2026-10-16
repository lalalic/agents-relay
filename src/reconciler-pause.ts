import type { Job } from './types.js';

/** Stop only generations already invalidated by the durable pause mutation. */
export function cancelPausedGenerations(job: Job, cancelTask: (taskId: string, executionId: string) => void, cancelPlan: (planId: string) => void): void {
  if (!job.pause) return;
  for (const task of job.tasks) if (task.pausedExecution) cancelTask(task.id, task.pausedExecution.id);
  for (const plan of job.plans ?? []) if (plan.pausedExecutionId) cancelPlan(plan.id);
}
