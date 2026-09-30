import type { DurableStore } from './store.js';
import type { BlockerDependent, BlockerReference, BlockerResolutionMode, Job, Task } from './types.js';
import { applyTaskReleaseAction, applyTaskUnblockRetryAction, dispatchTaskAction } from './task-actions.js';
import { isEffectivelyBlocked, unblockAutonomousTasks, unblockTask } from './unblock.js';
import { decideBlockerResolution } from './workflow/blocker-resolution-v2.js';

export type DependentStoreFactory = (repository: string, prNumber: number) => DurableStore;
export type BlockerResolutionSummary = { resumed: number; obsolete: number; waiting: number; unblocked: BlockerDependentTarget[] };
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
  const now = options.now ?? new Date().toISOString();
  const relations = blocker.unblocks ?? [];
  let resumed = 0;
  let obsolete = 0;
  const unblocked: BlockerDependentTarget[] = [];

  for (const relation of relations) {
    if (relation.state !== 'waiting') continue;
    const store = options.dependentStore(relation.repository, relation.prNumber);
    let targetJob: Job | null = null;
    let task: Task | undefined;
    let loadError: string | null = null;
    try {
      targetJob = await store.load(relation.jobId);
      task = targetJob.tasks.find(item => item.id === relation.taskId);
    } catch (error) {
      loadError = error instanceof Error ? error.message : String(error);
    }

    const targetMatches = !!task && ['DRAFT', 'FAILED', 'BLOCKED', 'UNBLOCKED'].includes(task.state) && task.attempt === relation.blockedAttempt;
    const decision = decideBlockerResolution({
      resolutionAllowed: !(mode === 'verified' && options.resolution !== 'verified'),
      targetMatches,
      autonomousJob: targetJob?.executionMode === 'autonomous',
      effectivelyBlocked: !!task && isEffectivelyBlocked(task),
      alreadyUnblocked: task?.state === 'UNBLOCKED' && Boolean(task.unblock),
      isDraft: task?.state === 'DRAFT',
      isBlocked: task?.state === 'BLOCKED',
      isFailed: task?.state === 'FAILED',
      isUnblocked: task?.state === 'UNBLOCKED',
    });
    if (!decision.accepted || decision.target === 'wait') continue;

    if (decision.target === 'obsolete') {
      relation.state = 'obsolete';
      relation.resolvedAt = now;
      relation.resolution = options.resolution;
      relation.note = loadError ?? obsoleteReason(task, relation);
      obsolete += 1;
      continue;
    }

    if (!targetJob || !task) throw new Error('Blocker graph requested resume without a matching dependent task');
    let note = 'dependent task requeued';
    for (const action of decision.actions) {
      if (action.id === 'blocker.autonomousUnblock') {
        await unblockAutonomousTasks({
          store,
          job: targetJob,
          tasks: [task],
          trigger: { source: 'blocker_job', reason: 'Blocker Job ' + blocker.id + ' resolved (' + options.resolution + ')', blockerJobId: blocker.id, resolution: options.resolution },
          now,
        });
        unblocked.push({ repository: relation.repository, prNumber: relation.prNumber, jobId: relation.jobId, taskId: relation.taskId });
        note = 'dependent task unblocked for replanning';
      } else if (action.id === 'blocker.acceptExistingUnblock') {
        note = 'dependent Job already unblocked for replanning';
      } else if (action.id === 'blocker.releaseDraft') {
        await applyTaskReleaseAction(task);
        task.error = null;
        task.updatedAt = now;
        delete task.blockedBy;
        await store.saveTask(task);
      } else if (action.id === 'blocker.unblockTask') {
        await unblockTask({ store, job: targetJob, task, trigger: { source: 'blocker_job', reason: 'Blocker Job ' + blocker.id + ' resolved (' + options.resolution + ')', blockerJobId: blocker.id, resolution: options.resolution }, now });
        unblocked.push({ repository: relation.repository, prNumber: relation.prNumber, jobId: relation.jobId, taskId: relation.taskId });
      } else if (action.id === 'blocker.retryFailed') {
        const result = await dispatchTaskAction(store, { id: 'task.retry', jobId: targetJob.id, taskId: task.id });
        delete result.task.blockedBy;
        result.task.updatedAt = now;
        await store.saveTask(result.task);
      } else if (action.id === 'blocker.retryUnblocked') {
        await applyTaskUnblockRetryAction(task);
        task.updatedAt = now;
        await store.saveTask(task);
      } else {
        throw new Error('Unsupported blocker graph action ' + action.id);
      }
    }
    relation.state = 'resumed';
    relation.resolvedAt = now;
    relation.resolution = options.resolution;
    relation.note = note;
    resumed += 1;
  }

  const remaining = relations.filter(relation => relation.state === 'waiting');
  const consumed = remaining.length !== relations.length;
  if (!consumed) return { resumed, obsolete, waiting: remaining.length, unblocked };
  if (remaining.length > 0) blocker.unblocks = remaining;
  else delete blocker.unblocks;
  blocker.blockerResolvedAt = now;
  blocker.updatedAt = now;
  await options.blockerStore.saveJob(blocker);
  return { resumed, obsolete, waiting: remaining.length, unblocked };
}
