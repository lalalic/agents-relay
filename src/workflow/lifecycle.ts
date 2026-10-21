import type { JobLifecycleState, TaskState } from '../types.js';
import type { WorkflowContext } from './mermaid.js';
import type { WorkflowDecision } from './contracts.js';
import { classifyWorkflowActions, emptyWorkflowDecision, type WorkflowMutationName } from './contracts.js';
import { jobLifecycleV2, taskLifecycleV2 } from './definitions-v2.js';
import type { GraphRuntime } from './graph-v2.js';
import { dispatchWorkflowGraph, dispatchWorkflowGraphSync } from './dispatcher.js';
import { applyJobGraphTarget, applyTaskGraphTarget, applyTaskMutation } from './runtime.js';

export type { WorkflowDecision } from './contracts.js';

function v2WorkflowDecision<State extends string>(
  runtime: GraphRuntime,
  from: State,
  event: string,
  facts: WorkflowContext = {},
): WorkflowDecision<State> {
  // Pure lifecycle predicates still enter through the dispatcher facade, but
  // suppress observability because no durable transition is being applied.
  const actions: string[] = [];
  const decision = dispatchWorkflowGraphSync(runtime, {
    initialState: from,
    input: { transport: 'event', id: event, payload: {} },
    durableFacts: facts,
    observe: false,
    executeAction: actionId => { actions.push(actionId); return {}; },
  });
  if (!decision.accepted) return emptyWorkflowDecision<State>(decision.reason === 'ambiguous' ? 'ambiguous' : 'no_transition');
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
  task: Pick<{ id: string; state: TaskState; agentName?: string }, 'id' | 'state' | 'agentName'>,
  event: string,
  facts: WorkflowContext = {},
): WorkflowDecision<TaskState> {
  return v2WorkflowDecision(taskLifecycleV2, task.state, event, { ...facts, troubleshooterTask: task.agentName === 'troubleshooter' });
}

export function decideJobLifecycle(
  job: Pick<{ id: string; state: JobLifecycleState }, 'id' | 'state'>,
  event: string,
  facts: WorkflowContext = {},
): WorkflowDecision<JobLifecycleState> {
  return v2WorkflowDecision(jobLifecycleV2, job.state, event, facts);
}



export function dispatchTaskLifecycleSync(
  task: { id: string; state: TaskState; updatedAt: string } & Record<string, unknown>,
  event: string,
  facts: WorkflowContext = {},
): WorkflowDecision<TaskState> {
  const actions: string[] = [];
  const result = dispatchWorkflowGraphSync(taskLifecycleV2, {
    initialState: task.state,
    input: { transport: 'event', id: event, payload: {} },
    durableFacts: { ...facts, troubleshooterTask: task.agentName === 'troubleshooter' },
    graphName: 'task-lifecycle',
    persistTransition: (_source, target) => applyTaskGraphTarget(task as never, target as TaskState, new Date().toISOString(), event === 'task.unblocked' && task.agentName === 'troubleshooter'),
    executeAction: actionId => { actions.push(actionId); if (actionId.startsWith('mutation.')) applyTaskMutation(task as never, actionId as WorkflowMutationName); return {}; },
  });
  if (!result.accepted) return emptyWorkflowDecision<TaskState>(result.reason === 'ambiguous' ? 'ambiguous' : 'no_transition');
  return { accepted: true, target: result.target as TaskState, guard: null, actions, ...classifyWorkflowActions(actions), reason: 'accepted' };
}

export async function dispatchTaskLifecycle(
  task: { id: string; state: TaskState; updatedAt: string } & Record<string, unknown>,
  event: string,
  facts: WorkflowContext = {},
  executeEffect?: (actionId: string) => void | Promise<void>,
  persist?: () => void | Promise<void>,
): Promise<WorkflowDecision<TaskState>> {
  const actions: string[] = [];
  const result = await dispatchWorkflowGraph(taskLifecycleV2, {
    initialState: task.state, input: { transport: 'event', id: event, payload: {} }, durableFacts: { ...facts, troubleshooterTask: task.agentName === 'troubleshooter' },
    graphName: 'task-lifecycle',
    persistTransition: async (_source, target) => { applyTaskGraphTarget(task as never, target as TaskState, new Date().toISOString(), event === 'task.unblocked' && task.agentName === 'troubleshooter'); await persist?.(); },
    executeAction: async actionId => {
      actions.push(actionId);
      if (actionId.startsWith('mutation.')) applyTaskMutation(task as never, actionId as WorkflowMutationName);
      else await executeEffect?.(actionId);
      return {};
    },
  });
  if (!result.accepted) return emptyWorkflowDecision<TaskState>(result.reason === 'ambiguous' ? 'ambiguous' : 'no_transition');
  return { accepted: true, target: result.target as TaskState, guard: null, actions, ...classifyWorkflowActions(actions), reason: 'accepted' };
}

export function dispatchJobLifecycleSync(
  job: { id: string; state: JobLifecycleState; updatedAt: string },
  event: string,
  facts: WorkflowContext = {},
): WorkflowDecision<JobLifecycleState> {
  const actions: string[] = [];
  const result = dispatchWorkflowGraphSync(jobLifecycleV2, {
    initialState: job.state,
    input: { transport: 'event', id: event, payload: {} },
    durableFacts: facts,
    graphName: 'job-lifecycle',
    persistTransition: (_source, target) => applyJobGraphTarget(job as never, target as JobLifecycleState),
    executeAction: actionId => { actions.push(actionId); return {}; },
  });
  if (!result.accepted) return emptyWorkflowDecision<JobLifecycleState>(result.reason === 'ambiguous' ? 'ambiguous' : 'no_transition');
  return { accepted: true, target: result.target as JobLifecycleState, guard: null, actions, ...classifyWorkflowActions(actions), reason: 'accepted' };
}

export async function dispatchJobLifecycle(
  job: { id: string; state: JobLifecycleState; updatedAt: string },
  event: string,
  facts: WorkflowContext = {},
  executeEffect?: (actionId: string) => void | Promise<void>,
  persist?: () => void | Promise<void>,
): Promise<WorkflowDecision<JobLifecycleState>> {
  const actions: string[] = [];
  const result = await dispatchWorkflowGraph(jobLifecycleV2, {
    initialState: job.state, input: { transport: 'event', id: event, payload: {} }, durableFacts: facts,
    graphName: 'job-lifecycle',
    persistTransition: async (_source, target) => { applyJobGraphTarget(job as never, target as JobLifecycleState); await persist?.(); },
    executeAction: async actionId => { actions.push(actionId); await executeEffect?.(actionId); return {}; },
  });
  if (!result.accepted) return emptyWorkflowDecision<JobLifecycleState>(result.reason === 'ambiguous' ? 'ambiguous' : 'no_transition');
  return { accepted: true, target: result.target as JobLifecycleState, guard: null, actions, ...classifyWorkflowActions(actions), reason: 'accepted' };
}
