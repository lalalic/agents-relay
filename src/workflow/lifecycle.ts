import type { JobLifecycleState, TaskState } from '../types.js';
import type { WorkflowContext } from './mermaid.js';
import type { WorkflowDecision } from './contracts.js';
import { classifyWorkflowActions, emptyWorkflowDecision } from './contracts.js';
import { jobLifecycleV2, taskLifecycleV2 } from './definitions-v2.js';
import type { GraphRuntime } from './graph-v2.js';

export type { WorkflowDecision } from './contracts.js';

function v2WorkflowDecision<State extends string>(
  runtime: GraphRuntime,
  from: State,
  event: string,
  facts: WorkflowContext = {},
): WorkflowDecision<State> {
  const decision = runtime.evaluateSync({
    currentState: from,
    input: { transport: 'event', id: event, payload: {} },
    durableFacts: facts,
  });
  if (!decision.accepted) return emptyWorkflowDecision<State>(decision.reason === 'ambiguous' ? 'ambiguous' : 'no_transition');
  const actions = decision.actions.map(action => action.id);
  const classified = classifyWorkflowActions(actions);
  return {
    accepted: true,
    target: decision.target as State,
    guard: null,
    actions,
    ...classified,
    reason: 'accepted',
  };
}

export function decideTaskLifecycle(
  task: Pick<{ id: string; state: TaskState }, 'id' | 'state'>,
  event: string,
  facts: WorkflowContext = {},
): WorkflowDecision<TaskState> {
  return v2WorkflowDecision(taskLifecycleV2, task.state, event, facts);
}

export function decideJobLifecycle(
  job: Pick<{ id: string; state: JobLifecycleState }, 'id' | 'state'>,
  event: string,
  facts: WorkflowContext = {},
): WorkflowDecision<JobLifecycleState> {
  return v2WorkflowDecision(jobLifecycleV2, job.state, event, facts);
}
