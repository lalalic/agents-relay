import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLocalManagedStore } from '../dist/local-managed-store.js';
import { ensureBlockerRecovery } from '../dist/blocker-recovery.js';
import { resolveBlockerDependencies } from '../dist/blockers.js';
import { dispatchBlockerRecovery } from '../dist/workflow/blocker-recovery.js';

const now = '2026-11-10T14:00:00.000Z';

function task(id, jobId, state = 'FAILED', attempt = 1) {
  return {
    jobId, id, title: id, kind: 'work', priority: 'P1', storySize: 'S', parentTaskId: null,
    dependencies: [], capabilities: [], adapter: 'codex', input: 'recover this task',
    output: { kind: 'task_pr' }, state, attempt, maxAttempts: 3,
    leaseOwner: null, leaseExpiresAt: null, executionId: null, threadId: null,
    result: null, error: 'confirmed prerequisite is missing', timeoutMs: 300000,
    createdAt: now, updatedAt: now,
  };
}

function job(id, repository, tasks = [], state = 'ACTIVE') {
  return {
    id, title: id, objective: `${id} objective`, prNumber: 0, repository, state,
    continuation: null, createdAt: now, updatedAt: now, tasks,
  };
}

async function withDirectory(run) {
  const root = await mkdtemp(join(tmpdir(), 'relay-blocker-recovery-'));
  const directory = join(root, 'store');
  await mkdir(directory, { recursive: true });
  try { await run(directory); } finally { await rm(root, { recursive: true, force: true }); }
}

async function saveJob(directory, value) {
  const opened = openLocalManagedStore(value.repository, 0, { directory, jobId: value.id, noGitHub: true });
  try { await opened.store.createJobIfAbsent(value); } finally { opened.relay.close(); }
}

function input(directory, patch = {}) {
  return {
    requestId: 'cross-repo-gateway-589-task-877',
    targetRepository: 'owner/gateway', dependentRepository: 'owner/consumer',
    dependentJobId: '589', dependentTaskId: '877',
    reason: 'The dependent integration is blocked by a missing authorized gateway API.',
    title: 'Add the missing gateway activity API',
    objective: 'Implement the authorized gateway API in owner/gateway for dependent Task 877 from owner/consumer. Keep scope to the requested technical prerequisite.',
    resolutionMode: 'verified', origin: 'troubleshooter', authorized: true,
    authorizedRepositories: ['owner/consumer', 'owner/gateway'],
    storeDirectory: directory, now: '2026-11-10T14:01:00.000Z', ...patch,
  };
}

test('blocker ensure creates one no-PR Job and registers an exact reverse dependency idempotently', async () => withDirectory(async directory => {
  await saveJob(directory, job('589', 'owner/consumer', [task('877', '589')]));
  const first = await ensureBlockerRecovery(input(directory));
  assert.equal(first.blockerRepository, 'owner/gateway');
  assert.equal(first.dependentJobId, '589');
  assert.equal(first.dependentTaskId, '877');
  assert.equal(first.resolutionMode, 'verified');
  assert.equal(first.outcome, 'created');
  assert.equal(first.status, 'planning_required');
  assert.match(first.reason, /missing authorized gateway API/);
  assert.equal(first.planningRecoveryRequired, true);

  const dependent = openLocalManagedStore('owner/consumer', 0, { directory, jobId: '589', noGitHub: true });
  let taskAfter;
  try {
    const persisted = await dependent.store.load('589');
    taskAfter = persisted.tasks[0];
    assert.ok(taskAfter.blockerRecoveryReceipt, JSON.stringify(taskAfter));
    assert.equal(taskAfter.state, 'FAILED');
    assert.equal(taskAfter.resolution.state, 'waiting');
    assert.equal(taskAfter.blockerRecoveryReceipt.blockerJobId, first.blockerJobId);
    assert.equal(taskAfter.blockedBy.blockedAttempt, 1);
  } finally { dependent.relay.close(); }

  const blocker = openLocalManagedStore('owner/gateway', 0, { directory, jobId: first.blockerJobId, noGitHub: true });
  try {
    const persisted = await blocker.store.load(first.blockerJobId);
    assert.equal(persisted.prNumber, 0);
    assert.equal(persisted.blockerRecoveryRequest.requestId, 'cross-repo-gateway-589-task-877');
    assert.equal(persisted.blockerRecoveryRequest.blockedAttempt, 1);
    assert.equal(persisted.blockerRecoveryRequest.status, 'planning_required');
    assert.deepEqual(persisted.unblocks.map(relation => [relation.repository, relation.jobId, relation.taskId, relation.blockedAttempt]), [
      ['owner/consumer', '589', '877', 1],
    ]);
  } finally { blocker.relay.close(); }

  const blockerForRetry = openLocalManagedStore('owner/gateway', 0, { directory, jobId: first.blockerJobId, noGitHub: true });
  try {
    await blockerForRetry.store.mutateJob(first.blockerJobId, current => ({
      ...current,
      state: 'ACTIVE',
      plans: [{ id: 'plan-1', round: 1, source: 'manual', previousPlanId: null, trigger: { source: 'initial' }, status: 'FAILED', assessment: '', generatedTaskIds: [], createdAt: now, updatedAt: now, error: 'planner failed after Job creation' }],
    }));
  } finally { blockerForRetry.relay.close(); }

  const second = await ensureBlockerRecovery(input(directory, { now: '2026-11-10T14:02:00.000Z' }));
  assert.equal(second.blockerJobId, first.blockerJobId);
  assert.equal(second.outcome, 'reused');
  assert.equal(second.status, 'planning_required');
  assert.equal(second.planningRecoveryRequired, true);
}));

test('blocker ensure adopts the exact pre-existing reverse relation without making a duplicate', async () => withDirectory(async directory => {
  const dependentTask = task('877', '589');
  dependentTask.blockedBy = { repository: 'owner/gateway', prNumber: 0, jobId: '592', blockedAttempt: 1, registeredAt: now };
  await saveJob(directory, job('589', 'owner/consumer', [dependentTask]));
  const blockerJob = job('592', 'owner/gateway', [], 'COMPLETED');
  blockerJob.blockerResolutionMode = 'verified';
  blockerJob.unblocks = [{ repository: 'owner/consumer', prNumber: 0, jobId: '589', taskId: '877', blockedAttempt: 1, registeredAt: now, state: 'waiting' }];
  await saveJob(directory, blockerJob);

  const check = openLocalManagedStore('owner/consumer', 0, { directory, jobId: '589', noGitHub: true });
  try {
    const persisted = await check.store.load('589');
    assert.ok(persisted.tasks[0].blockedBy, JSON.stringify(persisted.tasks[0]));
    assert.equal(persisted.tasks[0].blockedBy.jobId, '592');
  } finally { check.relay.close(); }

  const result = await ensureBlockerRecovery(input(directory));
  assert.equal(result.blockerJobId, '592');
  assert.equal(result.outcome, 'reused');
  const dependent = openLocalManagedStore('owner/consumer', 0, { directory, jobId: '589', noGitHub: true });
  const store = openLocalManagedStore('owner/gateway', 0, { directory, jobId: '592', noGitHub: true });
  try {
    const persisted = await store.store.load('592');
    assert.equal(persisted.unblocks.length, 1);
    assert.equal(persisted.blockerRecoveryRequest.blockedAttempt, 1);
    assert.equal(persisted.blockerRecoveryRequest.status, 'registered');
    assert.equal((await resolveBlockerDependencies({
      blockerStore: store.store, blockerJobId: '592', dependentStore: () => dependent.store, resolution: 'merge',
    })).waiting, 1);
    assert.equal((await dependent.store.load('589')).tasks[0].state, 'FAILED');
    // Verification alone cannot bypass the failed Task's fresh recovery path.
    const verified = await resolveBlockerDependencies({
      blockerStore: store.store, blockerJobId: '592', dependentStore: () => dependent.store, resolution: 'verified',
    });
    assert.equal(verified.resumed, 0);
    assert.equal(verified.waiting, 1);
    assert.equal((await dependent.store.load('589')).tasks[0].state, 'FAILED');
  } finally { store.relay.close(); dependent.relay.close(); }
}));

test('blocker ensure rejects changed intent, different owners, stale tasks, and unsafe project paths', async () => withDirectory(async directory => {
  await saveJob(directory, job('589', 'owner/consumer', [task('877', '589')]));
  const first = await ensureBlockerRecovery(input(directory));
  await assert.rejects(
    ensureBlockerRecovery(input(directory, { title: 'Different scoped gateway work' })),
    /different durable intent/,
  );
  // Existing recovery identity must not bypass workspace authorization after a
  // provider/repository is deauthorized between retries.
  await assert.rejects(
    ensureBlockerRecovery(input(directory, { authorizedRepositories: ['owner/consumer'] })),
    /graph did not produce ready/,
  );
  await assert.rejects(
    ensureBlockerRecovery(input(directory, {
      requestId: 'cross-repo-foreign-owner', targetRepository: 'other/gateway',
      objective: 'Implement the authorized gateway API in other/gateway for dependent Task 877 from owner/consumer. Keep scope to the requested technical prerequisite.',
    })),
    /owner.*workspace/,
  );
  await assert.rejects(
    ensureBlockerRecovery(input(directory, {
      requestId: 'cross-repo-unconfigured', targetRepository: 'owner/unlisted',
      objective: 'Implement the authorized technical API in owner/unlisted for dependent Task 877 from owner/consumer. Keep scope to the requested technical prerequisite.',
    })),
    /graph did not produce ready/,
  );
  await assert.rejects(
    ensureBlockerRecovery(input(directory, { requestId: 'cross-repo-unsafe-path', projectPath: '../gateway' })),
    /repository-relative path/,
  );

  const dependent = openLocalManagedStore('owner/consumer', 0, { directory, jobId: '589', noGitHub: true });
  try {
    const persisted = await dependent.store.load('589');
    persisted.tasks[0].attempt = 2;
    await dependent.store.saveTask(persisted.tasks[0]);
  } finally { dependent.relay.close(); }
  await assert.rejects(ensureBlockerRecovery(input(directory)), /different durable intent/);
  const registry = openLocalManagedStore('owner/gateway', 0, { directory, jobId: first.blockerJobId, noGitHub: true });
  try { assert.equal((await registry.relay.listJobs()).filter(value => value.repository === 'owner/gateway').length, 1); }
  finally { registry.relay.close(); }
}));

test('overlapping ensure requests converge on one blocker and one reverse relation', async () => withDirectory(async directory => {
  await saveJob(directory, job('589', 'owner/consumer', [task('877', '589')]));
  const [left, right] = await Promise.all([
    ensureBlockerRecovery(input(directory)),
    ensureBlockerRecovery(input(directory)),
  ]);
  assert.equal(left.blockerJobId, right.blockerJobId);
  const blocker = openLocalManagedStore('owner/gateway', 0, { directory, jobId: left.blockerJobId, noGitHub: true });
  try {
    const persisted = await blocker.store.load(left.blockerJobId);
    assert.equal(persisted.unblocks.length, 1);
    assert.equal(persisted.blockerRecoveryRequest.requestId, left.requestId);
  } finally { blocker.relay.close(); }
}));

test('cancelled blocker Jobs are never adopted as successful recovery', async () => withDirectory(async directory => {
  const dependentTask = task('877', '589');
  dependentTask.blockedBy = { repository: 'owner/gateway', prNumber: 0, jobId: '592', blockedAttempt: 1, registeredAt: now };
  await saveJob(directory, job('589', 'owner/consumer', [dependentTask]));
  const cancelled = job('592', 'owner/gateway', [], 'CANCELLED');
  cancelled.blockerResolutionMode = 'merge';
  cancelled.unblocks = [{ repository: 'owner/consumer', prNumber: 0, jobId: '589', taskId: '877', blockedAttempt: 1, registeredAt: now, state: 'waiting' }];
  await saveJob(directory, cancelled);

  await assert.rejects(ensureBlockerRecovery(input(directory, { resolutionMode: 'merge' })), /graph did not produce ready/);
  const dependent = openLocalManagedStore('owner/consumer', 0, { directory, jobId: '589', noGitHub: true });
  try {
    const persisted = await dependent.store.load('589');
    assert.equal(persisted.tasks[0].state, 'FAILED');
    assert.equal(persisted.tasks[0].blockerRecoveryReceipt, undefined);
  } finally { dependent.relay.close(); }
}));

test('blocker ensure fails closed when a task is not in a failed or blocked lifecycle state', async () => withDirectory(async directory => {
  await saveJob(directory, job('589', 'owner/consumer', [task('877', '589', 'SUCCEEDED')]));
  await assert.rejects(ensureBlockerRecovery(input(directory)), /must be failed or blocked/);
  const store = openLocalManagedStore('owner/consumer', 0, { directory, jobId: '589', noGitHub: true });
  try { assert.equal((await store.relay.listJobs()).length, 1); } finally { store.relay.close(); }
}));

test('blocker recovery graph selects guarded create, adoption, and registration actions', async () => {
  const run = async (facts) => {
    const actions = [];
    const decision = await dispatchBlockerRecovery(facts, actionId => { actions.push(actionId); return {}; });
    return { decision, actions };
  };
  const created = await run({
    authorized: true, knownRequest: false, authoritativeDependency: false,
    adoptionValid: false, targetValid: true, trustBoundaryValid: true,
  });
  assert.equal(created.decision.accepted, true);
  assert.deepEqual(created.actions, ['recovery.createBlocker', 'recovery.registerDependency']);
  const unauthorizedAdoption = await run({
    authorized: true, knownRequest: true, authoritativeDependency: false,
    adoptionValid: true, targetValid: false, trustBoundaryValid: true,
  });
  assert.equal(unauthorizedAdoption.decision.target, 'rejected');
  assert.deepEqual(unauthorizedAdoption.actions, []);

  const reused = await run({
    authorized: true, knownRequest: true, authoritativeDependency: false,
    adoptionValid: true, targetValid: true, trustBoundaryValid: true,
  });
  assert.equal(reused.decision.accepted, true);
  assert.deepEqual(reused.actions, ['recovery.adoptExistingBlocker', 'recovery.registerDependency']);

  const rejected = await run({
    authorized: false, knownRequest: false, authoritativeDependency: false,
    adoptionValid: false, targetValid: true, trustBoundaryValid: true,
  });
  assert.equal(rejected.decision.accepted, true);
  assert.equal(rejected.decision.target, 'rejected');
  assert.deepEqual(rejected.actions, []);
});
