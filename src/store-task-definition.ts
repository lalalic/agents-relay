import type { Plan, Task } from './types.js';

export type DurableDefinitionKind = 'task' | 'plan';
export type DurableDefinitionOperation = 'append_task' | 'append_plan';

/**
 * Deterministic conflict between two different definitions that claim the same durable id.
 *
 * This is not a transient projection failure: the same id is already occupied by a
 * different immutable definition, so retrying the same append can never succeed.
 * Callers classify it once, stop consuming retry budget, and record diagnostic evidence.
 */
export class DurableDefinitionConflictError extends Error {
  readonly deterministic = true;

  constructor(
    readonly kind: DurableDefinitionKind,
    readonly operation: DurableDefinitionOperation,
    readonly jobId: string,
    readonly subjectId: string,
    readonly local: unknown,
    readonly remote: unknown,
    readonly divergingFields: readonly string[],
  ) {
    super(kind === 'task'
      ? `Task ${subjectId} already exists with a different definition`
      : `Plan ${subjectId} already exists with a different definition`);
    this.name = 'DurableDefinitionConflictError';
  }
}

export function isDurableDefinitionConflict(error: unknown): error is DurableDefinitionConflictError {
  return error instanceof DurableDefinitionConflictError
    || (typeof error === 'object' && error !== null && (error as { name?: string }).name === 'DurableDefinitionConflictError');
}

function immutableTaskDefinition(task: Task): unknown {
  const routing = task.routing ? {
    provider: task.routing.provider, model: task.routing.model, profile: task.routing.profile,
    reasoning: task.routing.reasoning, cwd: task.routing.cwd, projectId: task.routing.projectId
  } : undefined;
  return {
    jobId: task.jobId, id: task.id, priority: task.priority, storySize: task.storySize ?? 'M', projectName: task.projectName, agentName: task.agentName, agentGraph: task.agentGraph,
    kind: task.kind ?? 'work', planningDecisionId: task.planningDecisionId, planningSource: task.planningSource, planningRound: task.planningRound, plannerGuidance: task.plannerGuidance, manualPlanning: task.manualPlanning, parentTaskId: task.parentTaskId, dependencies: task.dependencies, capabilities: task.capabilities, workerRequirements: task.workerRequirements, workerSelection: task.workerSelection, adapter: task.adapter,
    input: task.input, attachments: task.attachments, output: task.output, review: task.review, routing, chatgptTabClosePolicy: task.chatgptTabClosePolicy ?? 'after-start', continuation: task.continuation ?? null, maxAttempts: task.maxAttempts, timeoutMs: task.timeoutMs
  };
}
export function sameTaskDefinition(left: Task, right: Task): boolean {
  return JSON.stringify(immutableTaskDefinition(left)) === JSON.stringify(immutableTaskDefinition(right));
}

/** Plan identity ignores the resolved comment URL, which is projection metadata rather than definition. */
export function planDefinition(plan: Plan): Record<string, unknown> {
  const { planUrl: _planUrl, ...rest } = plan;
  return rest as Record<string, unknown>;
}
export function samePlanDefinition(left: Plan, right: Plan): boolean {
  return JSON.stringify(planDefinition(left)) === JSON.stringify(planDefinition(right));
}

function observableDefinition(kind: DurableDefinitionKind, definition: unknown): Record<string, unknown> {
  if (typeof definition !== 'object' || definition === null) return {};
  if (kind === 'task') return immutableTaskDefinition(definition as Task) as Record<string, unknown>;
  const { planUrl: _planUrl, ...rest } = definition as Plan;
  return rest as Record<string, unknown>;
}

/** Top-level field names whose definition values diverge; enough to diagnose a conflicted id. */
export function divergingDefinitionFields(kind: DurableDefinitionKind, left: unknown, right: unknown): string[] {
  const observed = observableDefinition(kind, left);
  const other = observableDefinition(kind, right);
  const keys = [...new Set([...Object.keys(observed), ...Object.keys(other)])].sort();
  return keys.filter(key => JSON.stringify(observed[key]) !== JSON.stringify(other[key]));
}

export function taskDefinitionDivergence(left: Task, right: Task): string[] {
  return divergingDefinitionFields('task', left, right);
}

export function planDefinitionDivergence(left: Plan, right: Plan): string[] {
  return divergingDefinitionFields('plan', left, right);
}

export function isTaskForJob(task: Task, jobId: string, soleTrustedJob: boolean): boolean {
  if (task.jobId === jobId) return true;
  return !task.jobId && soleTrustedJob;
}
