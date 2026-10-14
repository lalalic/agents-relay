import type { Job } from './types.js';

/** Resolve the execution-scoped contract from the authoritative Job snapshot. */
export function taskExecutionContext(job: Job, taskId: string, executionId: string) {
  if (!executionId) throw new Error('task context requires --execution-id');
  const task = job.tasks.find(item => item.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  if (task.executionId !== executionId || !['QUEUED', 'RUNNING'].includes(task.state))
    throw new Error(`Stale Task execution ${taskId}/${executionId}; current state ${task.state}`);
  return { job: { id: job.id, repository: job.repository, title: job.title, objective: job.objective,
    projectPath: job.projectPath, state: job.state }, task, comments: task.comments ?? [], dependencies: task.dependencies.map(id => job.tasks.find(item => item.id === id) ?? { id, missing: true }),
    plan: job.plans?.find(plan => plan.id === task.planningDecisionId) ?? null };
}

export function taskReferencePrompt(repository: string, jobId: string, taskId: string, executionId: string, managedInput?: string): string {
  const marker = '[Execution event contract — mandatory]';
  const index = managedInput?.indexOf(marker) ?? -1;
  if (managedInput !== undefined && index < 0) throw new Error(`Missing managed execution event contract for ${jobId}/${taskId}/${executionId}`);
  const eventContract = index >= 0 ? `\n\n${managedInput!.slice(index)}` : '';
  return `[Agents Relay managed task]\nRepository: ${repository}\nJob ID: ${jobId}\nTask ID: ${taskId}\nExecution ID: ${executionId}\n\nRetrieve the authoritative task contract using the connected NeoY shell/Agents Relay CLI:\n  agents-relay task context --repo ${repository} --id ${jobId} --task-id ${taskId} --execution-id ${executionId}\nRead the returned Task input, dependencies, Plan, project context, and output requirements before execution. Check that the execution ID matches. If the CLI or context is unavailable, report blocked; never guess or execute from this envelope. Continue in this thread; Relay owns completion and review. Do not create another Job.${eventContract}`;
}
