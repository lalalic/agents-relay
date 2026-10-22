import type { Job, Task } from './types.js';
import type { PlannerHistoryCleanup } from './planner-history-cleanup.js';
import { classifyTaskResolution } from './workflow/task-resolution.js';
import { tryTransitionTaskEvent } from './scheduler.js';
import { satisfiesWorker, type WorkerCandidate } from './worker-routing.js';

function dependencySatisfied(task: Task, byId: ReadonlyMap<string, Task>): boolean {
  return task.dependencies.every(id => {
    const dependency = byId.get(id);
    return dependency?.state === 'SUCCEEDED'
      || (dependency?.resolutionClassification?.kind === 'superseded'
        && byId.get(dependency.resolutionClassification.targetTaskId)?.state === 'SUCCEEDED');
  });
}

function eligibleWorkerRoute(task: Task, candidates?: readonly WorkerCandidate[]): boolean {
  if (!['codex', 'chatgpt'].includes(task.adapter)) return false;
  const required = task.workerRequirements?.capabilities ?? task.capabilities;
  if (task.workerSelection) {
    if (task.workerSelection.adapter !== task.adapter
      || required.some(capability => !task.workerSelection!.capabilities.includes(capability))) return false;
    const selected = candidates?.find(candidate => candidate.adapter === task.adapter && candidate.workerId === task.workerSelection!.workerId);
    return Boolean(selected && satisfiesWorker(selected, task.workerRequirements ?? { capabilities: required }, { strictCapabilities: true }));
  }
  return Boolean(candidates?.some(candidate => candidate.adapter === task.adapter
    && satisfiesWorker(candidate, task.workerRequirements ?? { capabilities: required })));
}

function runnable(task: Task, byId: ReadonlyMap<string, Task>, candidates?: readonly WorkerCandidate[]): boolean {
  return ['QUEUED', 'RUNNING'].includes(task.state)
    && dependencySatisfied(task, byId)
    && eligibleWorkerRoute(task, candidates)
    && (task.state !== 'RUNNING' || Boolean(task.executionId && task.leaseOwner));
}

function dependencyWaiting(task: Task, byId: ReadonlyMap<string, Task>, candidates?: readonly WorkerCandidate[], visiting = new Set<string>()): boolean {
  if (task.state !== 'DRAFT' || task.dependencies.length === 0 || visiting.has(task.id)) return false;
  visiting.add(task.id);
  const accounted = task.dependencies.every(id => {
    const dependency = byId.get(id);
    if (!dependency) return false;
    if (dependency.state === 'SUCCEEDED') return true;
    if (dependency.resolutionClassification?.kind === 'superseded'
      && byId.get(dependency.resolutionClassification.targetTaskId)?.state === 'SUCCEEDED') return true;
    return runnable(dependency, byId, candidates) || dependencyWaiting(dependency, byId, candidates, visiting);
  });
  visiting.delete(task.id);
  return accounted;
}

export function forceRestateRunnable(job: Job, candidates?: readonly WorkerCandidate[]): boolean {
  const byId = new Map(job.tasks.map(task => [task.id, task]));
  return job.tasks.some(task => task.kind !== 'planner' && runnable(task, byId, candidates));
}

export function forceRestateDependencyWaiting(job: Job, candidates?: readonly WorkerCandidate[]): boolean {
  const byId = new Map(job.tasks.map(task => [task.id, task]));
  return job.tasks.some(task => task.kind !== 'planner' && dependencyWaiting(task, byId, candidates));
}

export function forceRestateBlocked(job: Job, planId?: string): boolean {
  if (!planId) return false;
  return job.tasks.some(task => task.agentName === 'troubleshooter' && task.recoveryPlanId === planId && task.state === 'BLOCKED'
    && typeof task.error === 'string' && task.error.trim().length > 0
    && typeof task.result?.data?.evidence === 'string' && task.result.data.evidence.trim().length > 0
    && typeof task.result?.data?.unblock_conditions === 'string' && task.result.data.unblock_conditions.trim().length > 0);
}

export function forceRestateConverged(job: Job, planId?: string, candidates?: readonly WorkerCandidate[]): boolean {
  const completed = job.state === 'COMPLETED'
    && job.tasks.every(task => task.kind === 'planner' || !['DRAFT', 'QUEUED', 'RUNNING', 'BLOCKED'].includes(task.state));
  return completed || forceRestateRunnable(job, candidates) || forceRestateDependencyWaiting(job, candidates) || forceRestateBlocked(job, planId);
}

export type HistoryValidation = { valid: true } | { valid: false; issues: string[] };

/** Apply Planner-proposed history dispositions to a private candidate snapshot.
 * The caller invokes this before the storage mutator returns the candidate. */
export function applyPlannerHistoryCleanup(job: Job, expectedTaskIds: readonly string[], cleanup: readonly PlannerHistoryCleanup[], now: string): HistoryValidation {
  const issues: string[] = [];
  const expected = new Set(expectedTaskIds);
  if (cleanup.length !== expected.size || cleanup.some(item => !expected.delete(item.taskId)) || expected.size) {
    issues.push(`Provide exactly one history_cleanup disposition for each snapshotted failed Task: ${expectedTaskIds.join(', ') || '(none)'}.`);
    return { valid: false, issues };
  }
  for (const item of cleanup) {
    const task = job.tasks.find(candidate => candidate.id === item.taskId);
    if (!task || task.kind === 'planner' || task.state !== 'FAILED' || task.resolutionClassification) {
      issues.push(`Task ${item.taskId} changed since Force Restate began; reload the Planner context and revise this disposition.`);
      continue;
    }
    if (task.failureReason === 'worker_outcome_unknown' && item.outcome !== 'unresolved') {
      issues.push(`Task ${item.taskId} has an unknown execution outcome. Keep it unresolved until durable evidence proves the outcome.`);
      continue;
    }
    if (item.outcome === 'unresolved') continue;
    if (item.outcome === 'cancelled_review') {
      if (task.agentName !== 'reviewer' || !tryTransitionTaskEvent(task, 'cancel').accepted) {
        issues.push(`Task ${item.taskId} cannot be cancelled as a failed review. Only a FAILED reviewer Task can use cancelled_review.`);
        continue;
      }
      task.error = `Cancelled by Force Restate: ${item.reason}`;
      task.leaseOwner = null; task.leaseExpiresAt = null; task.executionId = null;
      task.updatedAt = now;
      continue;
    }
    const target = item.targetTaskId ? job.tasks.find(candidate => candidate.id === item.targetTaskId) : undefined;
    if (!target || target.state !== 'SUCCEEDED') {
      issues.push(`Task ${item.taskId} classification target ${item.targetTaskId ?? '(missing)'} must be an existing SUCCEEDED Task.`);
      continue;
    }
    try {
      classifyTaskResolution(task, { kind: item.outcome, targetTaskId: item.targetTaskId!, evidence: item.evidence, reason: item.reason }, now);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
    }
  }
  return issues.length ? { valid: false, issues } : { valid: true };
}
