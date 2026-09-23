import type { JobLifecycleState, TaskState } from '../types.js';
import { jobLifecycleWorkflow, taskLifecycleWorkflow } from './definitions.js';
import { WorkflowContext, WorkflowEngine } from './mermaid.js';

export type WorkflowRolloutMode = 'legacy' | 'shadow' | 'graph';
export type WorkflowDecision<State extends string> = {
  accepted: boolean;
  target: State | null;
  guard: string | null;
  actions: readonly string[];
  reason: 'accepted' | 'no_transition' | 'ambiguous';
};
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

export function setWorkflowRolloutMode(mode: WorkflowRolloutMode | null): void {
  modeOverride = mode;
}

export function setWorkflowShadowReporter(value: Reporter | null): void {
  reporter = value;
}

export function resetWorkflowRolloutDiagnostics(): void {
  matches = 0;
  mismatches = 0;
}

export function workflowRolloutSnapshot(): WorkflowRolloutSnapshot {
  return { mode: workflowRolloutMode(), matches, mismatches };
}

function graphDecision<State extends string>(
  engine: WorkflowEngine,
  from: State,
  event: string,
  context: WorkflowContext,
): WorkflowDecision<State> {
  const enabled = engine.enabledSync(from, event, context);
  if (enabled.length === 0) return { accepted: false, target: null, guard: null, actions: [], reason: 'no_transition' };
  if (enabled.length > 1) return { accepted: false, target: null, guard: null, actions: [], reason: 'ambiguous' };
  const transition = enabled[0];
  return {
    accepted: true,
    target: transition.to as State,
    guard: transition.guard,
    actions: [...transition.actions],
    reason: 'accepted',
  };
}

const taskLegacy: Readonly<Record<TaskState, Readonly<Record<string, { target: TaskState; guard?: string; actions?: readonly string[] }>>>> = {
  DRAFT: {
    release: { target: 'QUEUED' },
    block: { target: 'BLOCKED' },
    cancel: { target: 'CANCELLED' },
  },
  QUEUED: {
    hold: { target: 'DRAFT' },
    'task.started': { target: 'RUNNING' },
    block: { target: 'BLOCKED' },
    fail: { target: 'FAILED' },
    cancel: { target: 'CANCELLED' },
  },
  RUNNING: {
    'task.blocked': { target: 'BLOCKED' },
    'task.completed': { target: 'SUCCEEDED' },
    'task.failed': { target: 'FAILED' },
    'task.cancelled': { target: 'CANCELLED' },
  },
  BLOCKED: {
    retry: { target: 'QUEUED' },
    cancel: { target: 'CANCELLED' },
  },
  SUCCEEDED: {},
  FAILED: {
    retry: { target: 'QUEUED' },
    'reconcile.started': { target: 'RUNNING' },
    'reconcile.completed': { target: 'SUCCEEDED' },
    'reconcile.blocked': { target: 'BLOCKED' },
    cancel: { target: 'CANCELLED' },
  },
  CANCELLED: {},
};

const jobLegacy: Readonly<Record<JobLifecycleState, Readonly<Record<string, { target: JobLifecycleState; guard?: string; actions?: readonly string[] }>>>> = {
  DRAFT: {
    activate: { target: 'ACTIVE' },
    'pr.merged': { target: 'COMPLETED' },
    cancel: { target: 'CANCELLED' },
  },
  ACTIVE: {
    'pr.merged': { target: 'COMPLETED' },
    cancel: { target: 'CANCELLED' },
  },
  COMPLETED: {},
  CANCELLED: {
    'pr.merged': { target: 'COMPLETED' },
  },
};

function taskLegacyDecision(from: TaskState, event: string, context: WorkflowContext): WorkflowDecision<TaskState> {
  if (event === 'reconcile') {
    if (from === 'DRAFT' && context.dependenciesSatisfied === true) return { accepted: true, target: 'QUEUED', guard: 'dependenciesSatisfied', actions: ['release'], reason: 'accepted' };
    if (from === 'QUEUED' && context.dependenciesUnsatisfied === true) return { accepted: true, target: 'DRAFT', guard: 'dependenciesUnsatisfied', actions: ['hold'], reason: 'accepted' };
    if (from === 'QUEUED' && context.runnable === true) return { accepted: true, target: 'QUEUED', guard: 'runnable', actions: ['release'], reason: 'accepted' };
    return { accepted: false, target: null, guard: null, actions: [], reason: 'no_transition' };
  }
  const transition = taskLegacy[from][event];
  if (!transition) return { accepted: false, target: null, guard: null, actions: [], reason: 'no_transition' };
  return { accepted: true, target: transition.target, guard: transition.guard ?? null, actions: transition.actions ?? [], reason: 'accepted' };
}

function jobLegacyDecision(from: JobLifecycleState, event: string, context: WorkflowContext): WorkflowDecision<JobLifecycleState> {
  if (event === 'pr.closed') {
    if ((from === 'DRAFT' || from === 'ACTIVE') && context.notMerged === true) {
      return { accepted: true, target: 'CANCELLED', guard: 'notMerged', actions: ['cancelJob'], reason: 'accepted' };
    }
    return { accepted: false, target: null, guard: null, actions: [], reason: 'no_transition' };
  }
  const transition = jobLegacy[from][event];
  if (!transition) return { accepted: false, target: null, guard: null, actions: [], reason: 'no_transition' };
  return { accepted: true, target: transition.target, guard: transition.guard ?? null, actions: transition.actions ?? [], reason: 'accepted' };
}

function sameDecision(a: WorkflowDecision<string>, b: WorkflowDecision<string>): boolean {
  return a.accepted === b.accepted
    && a.target === b.target
    && a.guard === b.guard
    && a.reason === b.reason
    && a.actions.length === b.actions.length
    && a.actions.every((value, index) => value === b.actions[index]);
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
  context: WorkflowContext = {},
): WorkflowDecision<TaskState> {
  const legacy = taskLegacyDecision(task.state, event, context);
  const mode = workflowRolloutMode();
  if (mode === 'legacy') return legacy;
  const graph = graphDecision(taskLifecycleWorkflow, task.state, event, context);
  if (mode === 'shadow') {
    report('task', task.jobId ?? 'unknown', task.id, event, task.state, context, legacy, graph);
    return legacy;
  }
  return graph;
}

export function decideJobLifecycle(
  job: Pick<{ id: string; state: JobLifecycleState }, 'id' | 'state'>,
  event: string,
  context: WorkflowContext = {},
): WorkflowDecision<JobLifecycleState> {
  const legacy = jobLegacyDecision(job.state, event, context);
  const mode = workflowRolloutMode();
  if (mode === 'legacy') return legacy;
  const graph = graphDecision(jobLifecycleWorkflow, job.state, event, context);
  if (mode === 'shadow') {
    report('job', job.id, undefined, event, job.state, context, legacy, graph);
    return legacy;
  }
  return graph;
}
