import type { DurableStore } from './store.js';
import { applyTaskCancelAction } from './task-actions.js';
export async function cancelActiveTasks(
  store: DurableStore, jobId: string, reason: string,
  cancelPlanner: (taskId: string) => void,
  cancelExecutionGeneration: (jobId: string, taskId: string, executionId: string | null | undefined) => void,
): Promise<void> {
    const job = await store.load(jobId);
    for (const plan of (job.plans ?? []).filter(item => item.status === 'PLANNING')) {
      cancelPlanner(plan.id);
      plan.status = 'FAILED';
      plan.error = reason;
      plan.assessment = `Planning failed: ${reason}`;
      plan.leaseOwner = null;
      plan.leaseExpiresAt = null;
      plan.executionId = null;
      plan.updatedAt = new Date().toISOString();
      await store.savePlan(plan);
    }
    for (const task of job.tasks.filter(item => item.kind !== 'planner' && !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(item.state))) {
      cancelExecutionGeneration(job.id, task.id, task.executionId ?? task.executionHistory?.at(-1)?.id);
      cancelPlanner(task.id);
      await applyTaskCancelAction(task, reason);
      await store.saveTask(task);
    }
  }
