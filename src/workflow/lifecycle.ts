import type { JobLifecycleState, TaskState } from '../types.js';
import { jobLifecycleWorkflow, taskLifecycleWorkflow } from './definitions.js';
import type { WorkflowContext } from './mermaid.js';
import type { WorkflowDecision } from './contracts.js';
import { graphWorkflowDecision } from './runtime.js';

export type { WorkflowDecision } from './contracts.js';

export function decideTaskLifecycle(
  task: Pick<{ id: string; state: TaskState }, 'id' | 'state'>,
  event: string,
  facts: WorkflowContext = {},
): WorkflowDecision<TaskState> {
  return graphWorkflowDecision(taskLifecycleWorkflow, task.state, event, facts);
}

export function decideJobLifecycle(
  job: Pick<{ id: string; state: JobLifecycleState }, 'id' | 'state'>,
  event: string,
  facts: WorkflowContext = {},
): WorkflowDecision<JobLifecycleState> {
  return graphWorkflowDecision(jobLifecycleWorkflow, job.state, event, facts);
}
