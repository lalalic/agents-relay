import type { Job } from './types.js';

/** Resolve the execution-scoped contract from the authoritative Job snapshot. */
export function taskExecutionContext(job: Job, taskId: string, executionId: string) {
  if (!executionId) throw new Error('task context requires --execution-id');
  const task = job.tasks.find(item => item.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  if (task.executionId !== executionId || !['QUEUED', 'RUNNING'].includes(task.state))
    throw new Error(`Stale Task execution ${taskId}/${executionId}; current state ${task.state}`);
  const relevant = task.agentName === 'troubleshooter'
    ? job.tasks.filter(item => item.id === task.parentTaskId)
    : task.agentName === 'reviewer' ? task.dependencies.map(id => job.tasks.find(item => item.id === id)).filter((item): item is NonNullable<typeof item> => Boolean(item)) : [];
  return { job: { id: job.id, repository: job.repository, title: job.title, objective: job.objective,
    projectPath: job.projectPath, state: job.state }, task, currentState: task.state, resolution: task.resolution ?? null, escalation: task.escalation ?? null,
    comments: task.comments ?? [], relevantTasks: relevant.map(item => ({ id: item.id, title: item.title, state: item.state, attempt: item.attempt, executionId: item.executionId, resolution: item.resolution ?? null, escalation: item.escalation ?? null, comments: item.comments ?? [], result: item.result, error: item.error, failureReason: item.failureReason })),
    dependencies: task.dependencies.map(id => job.tasks.find(item => item.id === id) ?? { id, missing: true }),
    plan: job.plans?.find(plan => plan.id === task.planningDecisionId) ?? null };
}

/** Runtime-only task history; durable task.input remains the stable objective. */
export function taskAgentHistoryContext(job: Job, task: import('./types.js').Task): string {
  if (task.agentName !== 'troubleshooter' && task.agentName !== 'reviewer') return '';
  const related = task.agentName === 'troubleshooter'
    ? job.tasks.filter(item => item.id === task.parentTaskId)
    : task.dependencies.map(id => job.tasks.find(item => item.id === id)).filter((item): item is NonNullable<typeof item> => Boolean(item));
  return `\n\n[Authoritative task state and append-only comments]\n${JSON.stringify({
    currentTask: { id: task.id, state: task.state, attempt: task.attempt, executionId: task.executionId, resolution: task.resolution ?? null, escalation: task.escalation ?? null, comments: task.comments ?? [] },
    relatedTasks: related.map(item => ({ id: item.id, title: item.title, state: item.state, attempt: item.attempt, executionId: item.executionId, resolution: item.resolution ?? null, escalation: item.escalation ?? null, comments: item.comments ?? [], result: item.result, error: item.error, failureReason: item.failureReason })),
  }, null, 2)}\nTreat comments as supplementary history. Re-evaluate historical conditions using evidence from the original failing execution; a human response or prior condition alone does not prove recovery.`;
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
