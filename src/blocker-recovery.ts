import { createHash } from 'node:crypto';
import type { BlockerRecoveryReceipt, BlockerRecoveryRequest, BlockerResolutionMode, Job, Task } from './types.js';
import { ensureManagedGitHubJob } from './cli-job-create.js';
import { DisabledGitHubClient } from './no-github.js';
import { openLocalManagedStore, type LocalManagedStore } from './local-managed-store.js';
import { discoverLocalRelayStoreSnapshots, relayStoreDirectory } from './relay-store.js';
import { registerBlockerDependency } from './blockers.js';
import { dispatchBlockerRecovery } from './workflow/blocker-recovery.js';

export type BlockerRecoveryInput = {
  requestId: string;
  targetRepository: string;
  targetProjectRoot: string;
  dependentRepository: string;
  dependentJobId: string;
  dependentTaskId: string;
  reason: string;
  title: string;
  objective: string;
  projectPath?: string;
  resolutionMode: BlockerResolutionMode;
  origin: 'planner' | 'troubleshooter';
  authorized: boolean;
  authorizedRepositories: readonly string[];
  storeDirectory?: string;
  now?: string;
};

type OpenedStore = LocalManagedStore;
type RecoveryCandidate = { store: OpenedStore; job: Job; request: BlockerRecoveryRequest };

function normalizeRepository(value: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(trimmed) || trimmed.includes('..')) {
    throw new Error(`Invalid repository identity: ${value}`);
  }
  return trimmed;
}

function normalizedIntent(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function intentFingerprint(input: Pick<BlockerRecoveryInput, 'targetRepository' | 'dependentRepository' | 'dependentJobId' | 'dependentTaskId' | 'reason' | 'title' | 'objective' | 'projectPath' | 'resolutionMode'>, blockedAttempt: number): string {
  const stable = {
    targetRepository: normalizeRepository(input.targetRepository),
    dependentRepository: normalizeRepository(input.dependentRepository),
    dependentJobId: input.dependentJobId,
    dependentTaskId: input.dependentTaskId,
    blockedAttempt,
    reason: normalizedIntent(input.reason),
    title: normalizedIntent(input.title),
    objective: normalizedIntent(input.objective),
    projectPath: input.projectPath ?? null,
    resolutionMode: input.resolutionMode,
  };
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

function validateInput(input: BlockerRecoveryInput): void {
  const requestId = input.requestId.trim();
  const title = input.title.trim();
  const objective = input.objective.trim();
  const reason = normalizedIntent(input.reason);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(requestId)) throw new Error('Blocker recovery requestId must be 8-200 safe identity characters');
  if (title.length < 10 || title.length > 200) throw new Error('Blocker recovery title must be 10-200 characters');
  if (reason.length < 20 || reason.length > 1000) throw new Error('Blocker recovery reason must be 20-1000 characters');
  const normalizedObjective = normalizedIntent(objective);
  const targetRepository = normalizeRepository(input.targetRepository);
  const dependentRepository = normalizeRepository(input.dependentRepository);
  if (normalizedObjective.length < 120 || normalizedObjective.length > 20000) throw new Error('Blocker recovery objective must contain 120-20000 characters of standalone context');
  if (input.origin !== 'planner' && input.origin !== 'troubleshooter') throw new Error('Blocker recovery origin must be planner or troubleshooter');
  if (input.resolutionMode !== 'merge' && input.resolutionMode !== 'verified') throw new Error('Blocker recovery resolutionMode must be merge or verified');
  if (!normalizedObjective.includes(targetRepository)) throw new Error(`Blocker recovery objective must identify target repository ${targetRepository}`);
  if (!normalizedObjective.includes(input.dependentTaskId)) throw new Error(`Blocker recovery objective must identify dependent Task ${input.dependentTaskId}`);
  if (input.projectPath && (input.projectPath.startsWith('/') || input.projectPath.includes('\\')
    || input.projectPath.split('/').some(segment => segment === '' || segment === '.' || segment === '..'))) {
    throw new Error('Blocker recovery projectPath must be a normalized repository-relative path');
  }
  if (targetRepository === dependentRepository) throw new Error('Blocker recovery requires a distinct target repository');
  if (!input.targetProjectRoot) throw new Error('Blocker recovery requires an explicit targetProjectRoot');
}

function receipt(
  input: BlockerRecoveryInput, blockerJobId: string, outcome: BlockerRecoveryReceipt['outcome'],
  planningRecoveryRequired: boolean, request: BlockerRecoveryRequest, now: string,
): BlockerRecoveryReceipt {
  return {
    requestId: input.requestId,
    reason: request.reason,
    status: planningRecoveryRequired ? 'planning_required' : request.status === 'planned' ? 'planned' : 'registered',
    blockerJobId,
    blockerRepository: request.targetRepository,
    dependentRepository: request.dependentRepository,
    dependentJobId: request.dependentJobId,
    dependentTaskId: request.dependentTaskId,
    resolutionMode: request.resolutionMode,
    outcome,
    planningRecoveryRequired,
    createdAt: request.createdAt,
    updatedAt: now,
  };
}

function makeRequest(input: BlockerRecoveryInput, now: string, blockedAttempt: number): BlockerRecoveryRequest {
  return {
    requestId: input.requestId.trim(),
    intentFingerprint: intentFingerprint(input, blockedAttempt),
    reason: normalizedIntent(input.reason),
    status: 'created',
    targetRepository: normalizeRepository(input.targetRepository),
    dependentRepository: normalizeRepository(input.dependentRepository),
    dependentJobId: input.dependentJobId,
    dependentTaskId: input.dependentTaskId,
    blockedAttempt,
    title: input.title.trim(),
    objective: input.objective.trim(),
    projectPath: input.projectPath,
    resolutionMode: input.resolutionMode,
    origin: input.origin,
    authorized: input.authorized,
    createdAt: now,
    updatedAt: now,
  };
}

function planningRequired(job: Job): boolean {
  if (job.state === 'COMPLETED' || job.state === 'CANCELLED') return false;
  const latestPlan = [...(job.plans ?? [])].sort((left, right) => right.round - left.round)[0];
  return job.state === 'DRAFT' || latestPlan?.status !== 'SUCCEEDED';
}

function requestStatus(job: Job, planningRecoveryRequired: boolean): BlockerRecoveryRequest['status'] {
  if (planningRecoveryRequired) return 'planning_required';
  if ((job.plans ?? []).some(plan => plan.status === 'SUCCEEDED')) return 'planned';
  return 'registered';
}

async function loadKnownCandidate(
  directory: string, input: BlockerRecoveryInput, request: BlockerRecoveryRequest,
): Promise<RecoveryCandidate | null> {
  const snapshots = await discoverLocalRelayStoreSnapshots(directory);
  const matchingRequests = snapshots.flatMap(snapshot => snapshot.jobs.filter(job =>
    job.blockerRecoveryRequest?.requestId === request.requestId));
  if (matchingRequests.length > 1) throw new Error(`Ambiguous blocker recovery requestId ${request.requestId}`);
  const summary = matchingRequests[0];
  if (!summary) return null;
  const store = openLocalManagedStore(summary.repository, 0, { directory, jobId: summary.id, noGitHub: true });
  const job = await store.store.load(summary.id);
  const stored = job.blockerRecoveryRequest;
  if (!stored
    || stored.intentFingerprint !== request.intentFingerprint
    || stored.targetRepository !== request.targetRepository
    || stored.dependentRepository !== request.dependentRepository
    || stored.dependentJobId !== request.dependentJobId
    || stored.dependentTaskId !== request.dependentTaskId) {
    throw new Error(`Blocker recovery requestId ${request.requestId} is already bound to a different durable intent`);
  }
  return { store, job, request: stored };
}

async function loadAuthoritativeCandidate(
  directory: string, request: BlockerRecoveryRequest,
): Promise<RecoveryCandidate | null> {
  const snapshots = await discoverLocalRelayStoreSnapshots(directory);
  const candidates = snapshots.flatMap(snapshot => snapshot.jobs.filter(job =>
    normalizeRepository(job.repository) === request.targetRepository
      && (job.unblocks ?? []).some(relation => normalizeRepository(relation.repository) === request.dependentRepository
        && relation.jobId === request.dependentJobId
        && relation.taskId === request.dependentTaskId
        && relation.blockedAttempt === request.blockedAttempt)));
  if (candidates.length > 1) throw new Error(`Ambiguous authoritative blocker dependency for ${request.dependentJobId}/${request.dependentTaskId}`);
  const summary = candidates[0];
  if (!summary) return null;
  const store = openLocalManagedStore(request.targetRepository, 0, { directory, jobId: summary.id, noGitHub: true });
  const job = await store.store.load(summary.id);
  return { store, job, request };
}

function adoptionValid(candidate: RecoveryCandidate, request: BlockerRecoveryRequest): boolean {
  if (candidate.job.state === 'CANCELLED') return false;
  if (candidate.job.repository !== request.targetRepository) return false;
  if (candidate.job.blockerResolutionMode && candidate.job.blockerResolutionMode !== request.resolutionMode) return false;
  const stored = candidate.job.blockerRecoveryRequest;
  return !stored || (stored.intentFingerprint === request.intentFingerprint && stored.targetRepository === request.targetRepository
    && stored.dependentRepository === request.dependentRepository && stored.dependentJobId === request.dependentJobId
    && stored.dependentTaskId === request.dependentTaskId);
}

async function closeStores(stores: Iterable<OpenedStore>): Promise<void> {
  for (const store of stores) store.relay.close();
}

export async function ensureBlockerRecovery(input: BlockerRecoveryInput): Promise<BlockerRecoveryReceipt> {
  validateInput(input);
  const directory = input.storeDirectory ?? relayStoreDirectory();
  const now = input.now ?? new Date().toISOString();
  const dependentRepository = normalizeRepository(input.dependentRepository);
  const dependentStore = openLocalManagedStore(dependentRepository, 0, { directory, jobId: input.dependentJobId, noGitHub: true });
  const opened: OpenedStore[] = [dependentStore];
  let candidate: RecoveryCandidate | null = null;
  let finalStore: OpenedStore | null = null;
  let outcome: BlockerRecoveryReceipt['outcome'] = 'created';
  try {
    const dependentJob = await dependentStore.store.load(input.dependentJobId);
    const task = dependentJob.tasks.find(item => item.id === input.dependentTaskId);
    if (!task) throw new Error(`Dependent Task ${input.dependentTaskId} not found`);
    if (!['FAILED', 'BLOCKED'].includes(task.state)) throw new Error(`Dependent Task ${task.id} must be failed or blocked before blocker recovery (${task.state})`);
    const request = makeRequest(input, now, task.attempt);
    const known = await loadKnownCandidate(directory, input, request);
    if (known) {
      opened.push(known.store);
      candidate = known;
    } else {
      const authoritative = await loadAuthoritativeCandidate(directory, request);
      if (authoritative) {
        opened.push(authoritative.store);
        candidate = authoritative;
      }
    }
    const authorizedRepositories = input.authorizedRepositories.map(normalizeRepository);
    const targetResolvable = authorizedRepositories.includes(request.targetRepository);
    const trustBoundaryValid = input.authorizedRepositories.map(normalizeRepository).includes(dependentRepository);
    const knownRequest = known !== null;
    const authoritativeDependency = !knownRequest && candidate !== null;
    const validAdoption = candidate ? adoptionValid(candidate, request) : false;
    let blockerJobId = candidate?.job.id;
    let planningRecovery = false;

    const decision = await dispatchBlockerRecovery({
      authorized: input.authorized,
      knownRequest,
      authoritativeDependency,
      adoptionValid: validAdoption,
      targetValid: targetResolvable,
      trustBoundaryValid,
    }, async actionId => {
      if (actionId === 'recovery.createBlocker') {
        const created = await ensureManagedGitHubJob(new DisabledGitHubClient(), request.targetRepository, new Set(), {
          idempotencyKey: `blocker-recovery:${request.requestId}`,
          title: request.title,
          objective: request.objective,
          projectPath: request.projectPath,
          projectRoot: input.targetProjectRoot,
          noGitHub: true,
          storeDirectory: directory,
        });
        blockerJobId = created.job.id;
        outcome = 'created';
        planningRecovery = true;
        const createdStore = openLocalManagedStore(request.targetRepository, 0, { directory, jobId: created.job.id, noGitHub: true });
        opened.push(createdStore);
        finalStore = createdStore;
        if (!createdStore.store.mutateJob) throw new Error('Blocker recovery requires atomic durable Job mutation');
        await createdStore.store.mutateJob(created.job.id, current => ({
          ...current,
          blockerRecoveryRequest: { ...request, blockedAttempt: task.attempt, updatedAt: now },
          blockerResolutionMode: request.resolutionMode,
        }));
        return {};
      }
      if (actionId !== 'recovery.adoptExistingBlocker' && actionId !== 'recovery.registerDependency') {
        throw new Error(`Unsupported blocker recovery action ${actionId}`);
      }
      if (actionId === 'recovery.adoptExistingBlocker') {
        if (!candidate) throw new Error('Graph selected adoption without a verified blocker Job');
        blockerJobId = candidate.job.id;
        finalStore = candidate.store;
        outcome = 'reused';
      }
      if (actionId === 'recovery.registerDependency') {
        if (!blockerJobId) throw new Error('Graph selected dependency registration without a blocker Job');
        const targetStore = finalStore ?? openLocalManagedStore(request.targetRepository, 0, { directory, jobId: blockerJobId, noGitHub: true });
        finalStore = targetStore;
        if (!opened.includes(targetStore)) opened.push(targetStore);
        const before = await targetStore.store.load(blockerJobId);
        if (before.blockerResolutionMode && before.blockerResolutionMode !== request.resolutionMode) {
          throw new Error(`Blocker ${blockerJobId} already uses ${before.blockerResolutionMode} resolution`);
        }
        const relation = await registerBlockerDependency({
          blockerStore: targetStore.store,
          blockerJobId,
          dependentStore: dependentStore.store,
          dependentJobId: request.dependentJobId,
          dependentTaskId: request.dependentTaskId,
          resolutionMode: request.resolutionMode,
          expectedAttempt: task.attempt,
          now,
        });
        if (!targetStore.store.mutateJob) throw new Error('Blocker recovery requires atomic durable Job mutation');
        const current = await targetStore.store.load(blockerJobId);
        const prior = current.blockerRecoveryRequest;
        if (prior && prior.intentFingerprint !== request.intentFingerprint) {
          throw new Error(`Blocker Job ${blockerJobId} is already bound to a different recovery intent`);
        }
        planningRecovery = planningRequired(current);
        const status = requestStatus(current, planningRecovery);
        await targetStore.store.mutateJob(blockerJobId, job => ({
          ...job,
          blockerRecoveryRequest: {
            ...(prior ?? request), blockedAttempt: relation.blockedAttempt,
            status, updatedAt: now,
          },
          blockerResolutionMode: request.resolutionMode,
        }));
        if (outcome !== 'created') outcome = before.unblocks?.some(item => item.jobId === request.dependentJobId && item.taskId === request.dependentTaskId) ? 'reused' : 'registered';
      }
      return {};
    });
    if (!decision.accepted) throw new Error(`Blocker recovery graph rejected request ${request.requestId}: ${decision.reason}`);
    if (decision.target !== 'ready' || !blockerJobId) throw new Error(`Blocker recovery graph did not produce ready state for ${request.requestId}`);

    finalStore ??= openLocalManagedStore(request.targetRepository, 0, { directory, jobId: blockerJobId, noGitHub: true });
    if (!opened.includes(finalStore)) opened.push(finalStore);
    const finalJob = await finalStore.store.load(blockerJobId);
    planningRecovery = planningRequired(finalJob);
    const receiptNow = now;
    const final = await finalStore.store.load(blockerJobId);
    await dependentStore.store.mutateJob(request.dependentJobId, current => {
      const index = current.tasks.findIndex(item => item.id === request.dependentTaskId);
      if (index < 0) throw new Error(`Dependent Task ${request.dependentTaskId} disappeared`);
      const updated: Task = {
        ...current.tasks[index],
        blockerRecoveryReceipt: receipt(input, blockerJobId!, outcome, planningRecovery, final.blockerRecoveryRequest ?? request, receiptNow),
      };
      current.tasks[index] = updated;
      current.updatedAt = receiptNow;
      return current;
    });
    return receipt(input, blockerJobId, outcome, planningRecovery, final.blockerRecoveryRequest ?? request, now);
  } finally {
    await closeStores(new Set(opened));
  }
}
