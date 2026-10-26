import { Job, Task } from './types.js';
import { implementationTasks } from './runtime-status.js';
import { WorkflowContext } from './workflow/mermaid.js';
import { dispatchJobLifecycle, dispatchTaskLifecycle, dispatchTaskLifecycleSync, type WorkflowDecision } from './workflow/lifecycle.js';
import { dependencyReady, detectCycles, reconcileTaskDependencies } from './workflow/task-reconcile.js';
export { dependencyReady, detectCycles } from './workflow/task-reconcile.js';
import { observability } from './observability.js';
export function completionGateSatisfied(job: Job): boolean {
  const latest = [...(job.plans ?? [])].sort((a, b) => a.round - b.round).at(-1);
  const planSatisfied = latest?.status === 'SUCCEEDED' && latest.objectiveStatus === 'satisfied';
  const legacySatisfied = (job.plans?.length ?? 0) === 0 && job.tasks.some(task => task.kind === 'planner' && task.state === 'SUCCEEDED' && task.plannerResult?.objective_status === 'satisfied');
  return (planSatisfied || legacySatisfied) && implementationTasks(job).every(task => task.state === 'SUCCEEDED');
}
export function refreshTaskDependencies(job: Job): Job {
  if (job.pause) return job;
  reconcileTaskDependencies(job);

  return job;
}
export function extendRetryBudget(task: Pick<Task, 'attempt' | 'maxAttempts'>, windowSize = 3): number {
  if (!Number.isInteger(windowSize) || windowSize < 1) throw new Error('Retry window size must be a positive integer');
  const usedOrBudgeted = Math.max(task.maxAttempts, task.attempt);
  return Math.max(windowSize, (Math.floor(usedOrBudgeted / windowSize) + 1) * windowSize);
}
export function tryTransitionTaskEvent(task: Task, event: string, context: WorkflowContext = {}): WorkflowDecision<Task['state']> {
  return dispatchTaskLifecycleSync(task as Task & Record<string, unknown>, event, context);
}
export async function transitionTaskEvent(task: Task, event: string, context: WorkflowContext = {}, executeEffect?: (actionId:string)=>void|Promise<void>, persist?:()=>void|Promise<void>): Promise<WorkflowDecision<Task['state']>> {
  const from = task.state;
  const decision = await dispatchTaskLifecycle(task as Task & Record<string, unknown>, event, context, executeEffect, persist);
  if (!decision.accepted || !decision.target) throw new Error(decision.reason === 'ambiguous'
    ? `Ambiguous workflow transition from ${from} on ${event}`
    : `No enabled workflow transition from ${from} on ${event}`);
  observability().record({
    stage: 'transition',
    event,
    outcome: 'succeeded',
    message: `Task ${task.id} ${from} -> ${decision.target}`,
    correlation: { jobId: task.jobId, taskId: task.id, executionId: task.executionId ?? undefined },
    transition: { graph: 'task-lifecycle', from, to: decision.target, actions: decision.actions },
  });
  return decision;
}
export async function transitionJobEvent(job: Job, event: string, context: WorkflowContext = {}, executeEffect?: (actionId:string)=>void|Promise<void>, persist?:()=>void|Promise<void>): Promise<WorkflowDecision<Job['state']>> {
  const from = job.state;
  const decision = await dispatchJobLifecycle(job, event, context, executeEffect, persist);
  if (!decision.accepted || !decision.target) throw new Error(decision.reason === 'ambiguous'
    ? `Ambiguous workflow transition from ${from} on ${event}`
    : `No enabled workflow transition from ${from} on ${event}`);
  observability().record({
    stage: 'transition',
    event,
    outcome: 'succeeded',
    message: `Job ${job.id} ${from} -> ${decision.target}`,
    correlation: { repository: job.repository, prNumber: job.prNumber, jobId: job.id },
    transition: { graph: 'job-lifecycle', from, to: decision.target, actions: decision.actions },
  });
  return decision;
}
