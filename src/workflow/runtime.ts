import type { Job, JobLifecycleState, Task, TaskState } from '../types.js';
import type { WorkflowContext, WorkflowEngine } from './mermaid.js';
import {
  classifyWorkflowActions,
  emptyWorkflowDecision,
  type WorkflowDecision,
  type WorkflowMutationName,
} from './contracts.js';

export function graphWorkflowDecision<State extends string>(
  engine: WorkflowEngine,
  from: State,
  event: string,
  facts: WorkflowContext = {},
): WorkflowDecision<State> {
  const enabled = engine.enabledSync(from, event, facts);
  if (enabled.length === 0) return emptyWorkflowDecision<State>('no_transition');
  if (enabled.length > 1) return emptyWorkflowDecision<State>('ambiguous');
  const transition = enabled[0];
  const actions = [...transition.actions];
  const classified = classifyWorkflowActions(actions);
  return {
    accepted: true,
    target: transition.to as State,
    guard: transition.guard,
    actions,
    ...classified,
    reason: 'accepted',
  };
}

export function applyTaskMutation(task: Task, mutation: WorkflowMutationName): void {
  if (mutation === 'mutation.clearError') task.error = null;
  if (mutation === 'mutation.clearFailureReason') task.failureReason = undefined;
  if (mutation === 'mutation.clearLease') { task.leaseOwner = null; task.leaseExpiresAt = null; }
  if (mutation === 'mutation.clearExecution') task.executionId = null;
  if (mutation === 'mutation.markLeaseExpired') task.error = 'Lease expired after maximum attempts';
  if (mutation === 'mutation.markStartupOrphanedExhausted') task.error = 'Orphaned after relayd restart after maximum attempts';
  if (mutation === 'mutation.markPlannerUnavailable') task.error = 'No objective planner configured';
}


export function applyTaskGraphTarget(task: Task, target: TaskState, timestamp = new Date().toISOString()): void {
  const previous = Date.parse(task.updatedAt), candidate = Date.parse(timestamp);
  task.state = target;
  task.updatedAt = Number.isFinite(previous)
    ? new Date(Math.max(Number.isFinite(candidate) ? candidate : Date.now(), previous + 1)).toISOString()
    : timestamp;
}
export function applyJobGraphTarget(job: Job, target: JobLifecycleState, timestamp = new Date().toISOString()): void {
  const previous = Date.parse(job.updatedAt), candidate = Date.parse(timestamp);
  job.state = target;
  job.updatedAt = Number.isFinite(previous)
    ? new Date(Math.max(Number.isFinite(candidate) ? candidate : Date.now(), previous + 1)).toISOString()
    : timestamp;
}

export function applyTaskWorkflowDecision(
  task: Task,
  decision: WorkflowDecision<TaskState>,
  timestamp = new Date().toISOString(),
): void {
  if (!decision.accepted || !decision.target) throw new Error(`Cannot apply rejected workflow decision to task ${task.id}`);
  task.state = decision.target;
  for (const mutation of decision.mutations) applyTaskMutation(task, mutation);
  const previous = Date.parse(task.updatedAt), candidate = Date.parse(timestamp);
  task.updatedAt = Number.isFinite(previous)
    ? new Date(Math.max(Number.isFinite(candidate) ? candidate : Date.now(), previous + 1)).toISOString()
    : timestamp;
}

export function applyJobWorkflowDecision(
  job: Job,
  decision: WorkflowDecision<JobLifecycleState>,
  timestamp = new Date().toISOString(),
): void {
  if (!decision.accepted || !decision.target) throw new Error(`Cannot apply rejected workflow decision to job ${job.id}`);
  job.state = decision.target;
  job.updatedAt = timestamp;
}

/** Historical repair for records that stored derived runtime status as Job lifecycle. */
export function applyHistoricalJobCompatibilityRepair(
  job: Job,
  target: JobLifecycleState,
  timestamp = new Date().toISOString(),
): void {
  if (target !== 'COMPLETED' && target !== 'CANCELLED') throw new Error(`Invalid historical Job repair target ${target}`);
  job.state = target;
  job.updatedAt = timestamp;
}
