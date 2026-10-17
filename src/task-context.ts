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

/** Browser new-turn envelope: the local Contract and durable Task Context are authoritative. */
export function taskReferencePrompt(repository: string, jobId: string, taskId: string, executionId: string, managedInput?: string): string {
  if (managedInput !== undefined && !managedInput.includes('[Execution event contract — mandatory]'))
    throw new Error(`Missing managed execution event contract for ${jobId}/${taskId}/${executionId}`);
  const source = `job/${jobId}/task/${taskId}/execution/${executionId}`;
  return `[Agents Relay managed task]
Repository: ${repository}
Job ID: ${jobId}
Task ID: ${taskId}
Execution ID: ${executionId}
Exact event source.id: ${source}

FIRST publish exactly one task.started through the canonical Neo events-bus with this exact source.id.
THEN read the entire authoritative event contract from /Users/chengli/Workspace/agents-relay/skills/agents-relay/contracts/event-contract.md before any task work. If unavailable publish task.failed and stop.
THEN retrieve the authoritative Task Context:
  agents-relay task context --repo ${repository} --id ${jobId} --task-id ${taskId} --execution-id ${executionId}
Verify the execution ID. Read Task input, dependencies, Plan, project context, and output requirements from that response. Never guess or create a new Job. Continue in this thread; Relay owns completion and review.
Follow the file's lifecycle contract, including progress/heartbeat and exactly one task.completed or task.failed before exiting. If context is unavailable publish task.failed with the blocker.`;
}
