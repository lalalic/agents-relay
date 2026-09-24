import type { JobLifecycleState, TaskState } from '../types.js';
import { jobLifecycleWorkflow, taskLifecycleWorkflow } from './definitions.js';
import type { WorkflowContext } from './mermaid.js';
import {
  classifyWorkflowActions,
  emptyWorkflowDecision,
  type WorkflowDecision,
} from './contracts.js';
import { graphWorkflowDecision } from './runtime.js';

export type WorkflowRolloutMode = 'legacy' | 'shadow' | 'graph';
export type { WorkflowDecision } from './contracts.js';

export type WorkflowShadowDiagnostic = {
  type: 'workflow.shadow.match' | 'workflow.shadow.mismatch';
  kind: 'job' | 'task';
  jobId: string;
  taskId?: string;
  event: string;
  from: string;
  facts: WorkflowContext;
  legacy: WorkflowDecision<string>;
  graph: WorkflowDecision<string>;
};

export type WorkflowRolloutSnapshot = {
  mode: WorkflowRolloutMode;
  matches: number;
  mismatches: number;
};

type Reporter = (diagnostic: WorkflowShadowDiagnostic) => void;
type LegacyTransition<State extends string> = { target: State; guard?: string; actions?: readonly string[] };

let modeOverride: WorkflowRolloutMode | null = null;
let reporter: Reporter | null = null;
let matches = 0;
let mismatches = 0;

export function parseWorkflowRolloutMode(value: string | undefined): WorkflowRolloutMode {
  if (value === undefined || value === '') return 'legacy';
  if (value === 'legacy' || value === 'shadow' || value === 'graph') return value;
  throw new Error(`Invalid AGENTS_RELAY_WORKFLOW_MODE '${value}'; expected legacy, shadow, or graph`);
}

export function workflowRolloutMode(): WorkflowRolloutMode {
  return modeOverride ?? parseWorkflowRolloutMode(process.env.AGENTS_RELAY_WORKFLOW_MODE);
}

export function setWorkflowRolloutMode(mode: WorkflowRolloutMode | null): void { modeOverride = mode; }
export function setWorkflowShadowReporter(value: Reporter | null): void { reporter = value; }
export function resetWorkflowRolloutDiagnostics(): void { matches = 0; mismatches = 0; }
export function workflowRolloutSnapshot(): WorkflowRolloutSnapshot {
  return { mode: workflowRolloutMode(), matches, mismatches };
}

function accepted<State extends string>(
  target: State,
  guard: string | null = null,
  actions: readonly string[] = [],
): WorkflowDecision<State> {
  const actionList = [...actions];
  return {
    accepted: true,
    target,
    guard,
    actions: actionList,
    ...classifyWorkflowActions(actionList),
    reason: 'accepted',
  };
}

const CLEAR = ['mutation.clearError', 'mutation.clearFailureReason'] as const;

const taskLegacy: Readonly<Record<TaskState, Readonly<Record<string, LegacyTransition<TaskState>>>>> = {
  DRAFT: {
    release: { target: 'QUEUED', actions: CLEAR },
    block: { target: 'BLOCKED' },
    cancel: { target: 'CANCELLED' },
  },
  QUEUED: {
    hold: { target: 'DRAFT' },
    'task.started': { target: 'RUNNING', actions: CLEAR },
    block: { target: 'BLOCKED' },
    fail: { target: 'FAILED' },
    'effect.launchTask.failed': { target: 'FAILED' },
    cancel: { target: 'CANCELLED' },
  },
  RUNNING: {
    'task.blocked': { target: 'BLOCKED' },
    'task.completed': { target: 'SUCCEEDED', actions: CLEAR },
    'task.failed': { target: 'FAILED' },
    'task.cancelled': { target: 'CANCELLED' },
  },
  BLOCKED: {
    retry: { target: 'QUEUED', actions: CLEAR },
    cancel: { target: 'CANCELLED' },
  },
  SUCCEEDED: {},
  FAILED: {
    retry: { target: 'QUEUED', actions: CLEAR },
    'reconcile.started': { target: 'RUNNING', actions: CLEAR },
    'reconcile.completed': { target: 'SUCCEEDED', actions: CLEAR },
    'reconcile.blocked': { target: 'BLOCKED' },
    cancel: { target: 'CANCELLED' },
  },
  CANCELLED: {},
};

const CANCEL_EFFECT = ['effect.cancelActiveTasks'] as const;
const MERGE_EFFECT = ['effect.mergePullRequest'] as const;
const jobLegacy: Readonly<Record<JobLifecycleState, Readonly<Record<string, LegacyTransition<JobLifecycleState>>>>> = {
  DRAFT: {
    activate: { target: 'ACTIVE' },
    'pr.merged': { target: 'COMPLETED', actions: CANCEL_EFFECT },
    cancel: { target: 'CANCELLED' },
  },
  ACTIVE: {
    'pr.merged': { target: 'COMPLETED', actions: CANCEL_EFFECT },
    cancel: { target: 'CANCELLED' },
  },
  COMPLETED: {
    'effect.cancelActiveTasks.failed': { target: 'COMPLETED' },
  },
  CANCELLED: {
    'pr.merged': { target: 'COMPLETED', actions: CANCEL_EFFECT },
    'effect.cancelActiveTasks.failed': { target: 'CANCELLED' },
  },
};

function taskLegacyDecision(from: TaskState, event: string, facts: WorkflowContext): WorkflowDecision<TaskState> {
  if (event === 'reconcile') {
    if (from === 'DRAFT' && facts.dependenciesSatisfied === true) return accepted('QUEUED', 'dependenciesSatisfied', CLEAR);
    if (from === 'QUEUED' && facts.dependenciesUnsatisfied === true) return accepted('DRAFT', 'dependenciesUnsatisfied');
    if (from === 'QUEUED' && facts.runnable === true) return accepted('QUEUED', 'runnable', CLEAR);
    return emptyWorkflowDecision('no_transition');
  }
  if (event === 'dispatch') {
    if (from === 'QUEUED' && facts.dispatchable === true) return accepted('QUEUED', 'dispatchable', ['effect.launchTask']);
    return emptyWorkflowDecision('no_transition');
  }
  const transition = taskLegacy[from][event];
  if (!transition) return emptyWorkflowDecision('no_transition');
  return accepted(transition.target, transition.guard ?? null, transition.actions ?? []);
}

function jobLegacyDecision(from: JobLifecycleState, event: string, facts: WorkflowContext): WorkflowDecision<JobLifecycleState> {
  if (event === 'pr.closed') {
    if ((from === 'DRAFT' || from === 'ACTIVE') && facts.notMerged === true) {
      return accepted('CANCELLED', 'notMerged', CANCEL_EFFECT);
    }
    return emptyWorkflowDecision('no_transition');
  }
  if (event === 'review.approved' || event === 'implementation.completed') {
    if (from === 'ACTIVE' && facts.autoMerge === true) return accepted('ACTIVE', 'autoMerge', MERGE_EFFECT);
    return emptyWorkflowDecision('no_transition');
  }
  if (event === 'effect.mergePullRequest.failed' && from === 'ACTIVE') return accepted('ACTIVE');
  const transition = jobLegacy[from][event];
  if (!transition) return emptyWorkflowDecision('no_transition');
  return accepted(transition.target, transition.guard ?? null, transition.actions ?? []);
}

function sameDecision(a: WorkflowDecision<string>, b: WorkflowDecision<string>): boolean {
  return a.accepted === b.accepted
    && a.target === b.target
    && a.guard === b.guard
    && a.reason === b.reason
    && a.actions.length === b.actions.length
    && a.actions.every((value, index) => value === b.actions[index])
    && a.mutations.length === b.mutations.length
    && a.mutations.every((value, index) => value === b.mutations[index])
    && a.effects.length === b.effects.length
    && a.effects.every((value, index) => value === b.effects[index]);
}

function report(
  kind: 'job' | 'task',
  jobId: string,
  taskId: string | undefined,
  event: string,
  from: string,
  facts: WorkflowContext,
  legacy: WorkflowDecision<string>,
  graph: WorkflowDecision<string>,
): void {
  const match = sameDecision(legacy, graph);
  if (match) matches += 1;
  else mismatches += 1;
  const diagnostic: WorkflowShadowDiagnostic = {
    type: match ? 'workflow.shadow.match' : 'workflow.shadow.mismatch',
    kind,
    jobId,
    ...(taskId ? { taskId } : {}),
    event,
    from,
    facts: { ...facts },
    legacy,
    graph,
  };
  reporter?.(diagnostic);
  if (!match && !reporter) console.warn(JSON.stringify(diagnostic));
}

export function decideTaskLifecycle(
  task: Pick<{ jobId?: string; id: string; state: TaskState }, 'jobId' | 'id' | 'state'>,
  event: string,
  facts: WorkflowContext = {},
): WorkflowDecision<TaskState> {
  const legacy = taskLegacyDecision(task.state, event, facts);
  const mode = workflowRolloutMode();
  if (mode === 'legacy') return legacy;
  const graph = graphWorkflowDecision(taskLifecycleWorkflow, task.state, event, facts);
  if (mode === 'shadow') {
    report('task', task.jobId ?? 'unknown', task.id, event, task.state, facts, legacy, graph);
    return legacy;
  }
  return graph;
}

export function decideJobLifecycle(
  job: Pick<{ id: string; state: JobLifecycleState }, 'id' | 'state'>,
  event: string,
  facts: WorkflowContext = {},
): WorkflowDecision<JobLifecycleState> {
  const legacy = jobLegacyDecision(job.state, event, facts);
  const mode = workflowRolloutMode();
  if (mode === 'legacy') return legacy;
  const graph = graphWorkflowDecision(jobLifecycleWorkflow, job.state, event, facts);
  if (mode === 'shadow') {
    report('job', job.id, undefined, event, job.state, facts, legacy, graph);
    return legacy;
  }
  return graph;
}
