import type { DurableStore } from './store.js';
import type { BlockerDependent, BlockerReference, BlockerResolutionMode, Job, Task } from './types.js';
import { extendRetryBudget, transitionTaskEvent } from './scheduler.js';

export type DependentStoreFactory = (repository: string, prNumber: number) => DurableStore;
export type BlockerResolutionSummary = { resumed: number; obsolete: number; waiting: number };
export type BlockerDependentTarget = { repository: string; prNumber: number; jobId: string; taskId: string; resolutionMode?: BlockerResolutionMode };

function dependentKey(value: Pick<BlockerDependent, 'repository' | 'prNumber' | 'jobId' | 'taskId' | 'blockedAttempt'>): string {
  return `${value.repository}#${value.prNumber}:${value.jobId}:${value.taskId}:a${value.blockedAttempt}`;
}

function sameBlocker(left: BlockerReference | undefined, right: BlockerReference): boolean {
  return !!left && left.repository === right.repository && left.prNumber === right.prNumber && left.jobId === right.jobId;
}

export async function registerBlockerDependency(options: {
  blockerStore: DurableStore;
  blockerJobId: string;
  dependentStore: DurableStore;
  dependentJobId: string;
  dependentTaskId: string;
  resolutionMode?: BlockerResolutionMode;
  now?: string;
}): Promise<BlockerDependent> {
  const blocker = await options.blockerStore.load(options.blockerJobId);
  const dependentJob = await options.dependentStore.load(options.dependentJobId);
  const task = dependentJob.tasks.find(item => item.id === options.dependentTaskId);
  if (!task) throw new Error(`Dependent task ${options.dependentTaskId} not found`);
  if (!['DRAFT', 'FAILED', 'BLOCKED'].includes(task.state)) throw new Error(`Dependent task ${task.id} is not waiting/blocked/failed (${task.state})`);
  const now = options.now ?? new Date().toISOString();
  const relation: BlockerDependent = {
    repository: dependentJob.repository,
    prNumber: dependentJob.prNumber,
    jobId: dependentJob.id,
    taskId: task.id,
    blockedAttempt: task.attempt,
    registeredAt: now,
    state: 'waiting',
  };
  const existing = (blocker.unblocks ?? []).find(item => dependentKey(item) === dependentKey(relation));
  const requestedMode = options.resolutionMode ?? blocker.blockerResolutionMode ?? 'merge';
  const taskBlocker = { repository: blocker.repository, prNumber: blocker.prNumber, jobId: blocker.id, blockedAttempt: task.attempt, registeredAt: existing?.registeredAt ?? now };
  if (existing) {
    if (!task.blockedBy || !sameBlocker(task.blockedBy, taskBlocker) || task.blockedBy.blockedAttempt !== task.attempt) {
      task.blockedBy = taskBlocker;
      task.updatedAt = now;
      await options.dependentStore.saveTask(task);
    }
    return existing;
  }
  if (blocker.blockerResolutionMode && blocker.blockerResolutionMode !== requestedMode) throw new Error(`Blocker ${blocker.id} already uses ${blocker.blockerResolutionMode} resolution`);
  blocker.blockerResolutionMode = requestedMode;
  blocker.unblocks = [...(blocker.unblocks ?? []), relation];
  blocker.updatedAt = now;
  await options.blockerStore.saveJob(blocker);
  task.blockedBy = taskBlocker;
  task.updatedAt = now;
  await options.dependentStore.saveTask(task);
  return relation;
}

function obsoleteReason(task: Task | undefined, relation: BlockerDependent): string {
  if (!task) return 'dependent task no longer exists';
  if (!['DRAFT', 'FAILED', 'BLOCKED'].includes(task.state)) return `dependent task advanced to ${task.state}`;
  if (task.attempt !== relation.blockedAttempt) return `dependent task advanced from attempt ${relation.blockedAttempt} to ${task.attempt}`;
  return 'dependent task no longer matches blocker registration';
}

export async function resolveBlockerDependencies(options: {
  blockerStore: DurableStore;
  blockerJobId: string;
  dependentStore: DependentStoreFactory;
  resolution: 'merge' | 'verified';
  now?: string;
}): Promise<BlockerResolutionSummary> {
  const blocker = await options.blockerStore.load(options.blockerJobId);
  const mode = blocker.blockerResolutionMode ?? 'merge';
  if (mode === 'verified' && options.resolution !== 'verified') {
    const waiting = (blocker.unblocks ?? []).filter(item => item.state === 'waiting').length;
    return { resumed: 0, obsolete: 0, waiting };
  }
  const now = options.now ?? new Date().toISOString();
  let resumed = 0;
  let obsolete = 0;
  for (const relation of blocker.unblocks ?? []) {
    if (relation.state !== 'waiting') continue;
    const store = options.dependentStore(relation.repository, relation.prNumber);
    let targetJob: Job;
    try {
      targetJob = await store.load(relation.jobId);
    } catch (error) {
      relation.state = 'obsolete'; relation.resolvedAt = now; relation.resolution = options.resolution; relation.note = error instanceof Error ? error.message : String(error); obsolete += 1; continue;
    }
    const task = targetJob.tasks.find(item => item.id === relation.taskId);
    const matches = !!task && ['DRAFT', 'FAILED', 'BLOCKED'].includes(task.state) && task.attempt === relation.blockedAttempt;
    if (!matches) {
      relation.state = 'obsolete'; relation.resolvedAt = now; relation.resolution = options.resolution; relation.note = obsoleteReason(task, relation); obsolete += 1; continue;
    }
    if (task.state === 'DRAFT') {
      await transitionTaskEvent(task, 'release');
    } else {
      task.maxAttempts = extendRetryBudget(task);
      await transitionTaskEvent(task, 'retry');
    }
    task.error = null;
    task.leaseOwner = null;
    task.leaseExpiresAt = null;
    task.executionId = null;
    delete task.blockedBy;
    task.updatedAt = now;
    await store.saveTask(task);
    relation.state = 'resumed'; relation.resolvedAt = now; relation.resolution = options.resolution; relation.note = 'dependent task requeued'; resumed += 1;
  }
  blocker.blockerResolvedAt = now;
  blocker.updatedAt = now;
  await options.blockerStore.saveJob(blocker);
  return { resumed, obsolete, waiting: (blocker.unblocks ?? []).filter(item => item.state === 'waiting').length };
}
