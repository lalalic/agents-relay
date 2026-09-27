import type { Task } from './types.js';

function immutableTaskDefinition(task: Task): unknown {
  const routing = task.routing ? {
    provider: task.routing.provider, model: task.routing.model, profile: task.routing.profile,
    reasoning: task.routing.reasoning, cwd: task.routing.cwd, projectId: task.routing.projectId
  } : undefined;
  return {
    jobId: task.jobId, id: task.id, priority: task.priority, storySize: task.storySize ?? 'M', projectName: task.projectName, agentName: task.agentName, agentGraph: task.agentGraph,
    kind: task.kind ?? 'work', planningDecisionId: task.planningDecisionId, planningSource: task.planningSource, planningRound: task.planningRound, plannerGuidance: task.plannerGuidance, manualPlanning: task.manualPlanning, parentTaskId: task.parentTaskId, dependencies: task.dependencies, capabilities: task.capabilities, workerRequirements: task.workerRequirements, workerSelection: task.workerSelection, adapter: task.adapter,
    input: task.input, attachments: task.attachments, output: task.output, routing, chatgptTabClosePolicy: task.chatgptTabClosePolicy ?? 'after-start', continuation: task.continuation ?? null, maxAttempts: task.maxAttempts, timeoutMs: task.timeoutMs
  };
}
export function sameTaskDefinition(left: Task, right: Task): boolean {
  return JSON.stringify(immutableTaskDefinition(left)) === JSON.stringify(immutableTaskDefinition(right));
}

export function isTaskForJob(task: Task, jobId: string, soleTrustedJob: boolean): boolean {
  if (task.jobId === jobId) return true;
  return !task.jobId && soleTrustedJob;
}
