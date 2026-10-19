import test, { managedReconciler } from './test-runtime.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteRelayStore } from '../dist/relay-store.js';
import { LocalAuthorityDurableStore } from '../dist/local-authority-store.js';
import { InMemoryStore } from '../dist/store.js';
import { eventFor } from '../dist/events.js';
import { parseGitHubWebhook } from '../dist/github-webhook.js';
import { subscribeLocalCommits } from '../dist/local-commit-events.js';
import { transitionTaskEvent } from '../dist/scheduler.js';

const at = '2026-10-08T20:00:00.000Z';
function job(id = 'local') {
  return {
    id, title: 'local-only', repository: 'owner/repo', prNumber: 12,
    executionMode: 'fixed', state: 'ACTIVE', continuation: null,
    createdAt: at, updatedAt: at, tasks: [],
  };
}
function task(state = 'QUEUED') {
  return {
    jobId: 'local', id: 't1', parentTaskId: null, dependencies: [],
    capabilities: [], adapter: 'orchestrator', input: 'do work', state,
    attempt: 0, maxAttempts: 2, leaseOwner: null, leaseExpiresAt: null,
    executionId: null, threadId: null, result: null, error: null,
    timeoutMs: 0, createdAt: at, updatedAt: at, continuation: null,
    continuationDeliveredAt: null,
  };
}

test('local authority never reads GitHub markers or creates lifecycle projections', async () => {
  const path = await mkdtemp(join(tmpdir(), 'relay-authority-'));
  let sqlite = new SQLiteRelayStore(join(path, 'state.db'));
  const remote = new InMemoryStore({ ...job(), state: 'CANCELLED', tasks: [task('FAILED')] });
  for (const op of ['load', 'comments', 'listAgents', 'pullRequestState', 'pullRequestHead']) {
    remote[op] = async () => { throw new Error('Forbidden GitHub ' + op); };
  }
  const local = new LocalAuthorityDurableStore(sqlite, remote);
  await assert.rejects(local.load('local'), /Local authoritative Job local not found/);
  await local.hydrate({ ...job(), state: 'CANCELLED', tasks: [task('FAILED')] });
  await assert.rejects(local.load('local'), /not found/);
  await local.saveJob(job());
  await local.appendTask(task());
  await local.appendTask(task());
  assert.equal((await local.load('local')).tasks.length, 1);
  await assert.rejects(local.appendTask({ ...task(), input: 'changed' }), /different definition/);
  const completed = { ...task('SUCCEEDED'), result: { summary: 'verified' } };
  await local.saveTask(completed);
  await assert.rejects(local.saveTask({ ...task(), id: 'missing' }), /not found/);
  await local.hydrate({ ...job(), state: 'CANCELLED', tasks: [task('FAILED')] });
  assert.equal((await local.load('local')).tasks[0].state, 'SUCCEEDED');
  assert.equal(await local.pullRequestState(), 'UNKNOWN');
  assert.deepEqual(await local.comments(), []);
  assert.deepEqual(await local.listAgents(), []);
  assert.equal(await sqlite.pendingProjectionCount(), 0);
  sqlite.close();
  sqlite = new SQLiteRelayStore(join(path, 'state.db'));
  const restarted = new LocalAuthorityDurableStore(sqlite, remote);
  assert.equal((await restarted.load('local')).tasks[0].state, 'SUCCEEDED');
  sqlite.close();
  await rm(path, { recursive: true, force: true });
});

test('same-state QUEUED platform reroute persists with unchanged attempt in local SQLite authority', async () => {
  const sqlite = new SQLiteRelayStore(':memory:');
  const local = new LocalAuthorityDurableStore(sqlite, new InMemoryStore());
  const rerouting = {
    ...task('QUEUED'), attempt: 1, executionId: 'chat-execution',
    leaseOwner: 'relay', leaseExpiresAt: '2099-01-01T00:00:00.000Z',
    routing: { provider: 'chatgpt', model: 'account-defaults', decidedBy: 'test', decidedAt: at },
    workerSelection: { workerId: 'chatgpt/browser-worker', adapter: 'chatgpt', capabilities: ['model'], selectedBy: 'test', selectedAt: at },
  };
  await local.saveJob({ ...job(), tasks: [rerouting] });
  const fresh = (await local.load('local')).tasks[0];
  const previousUpdatedAt = fresh.updatedAt;
  const decision = await transitionTaskEvent(fresh, 'worker.platform_failure', { platformFallbackSafe: true });
  assert.equal(decision.target, 'QUEUED');
  await local.saveTask(fresh);
  const saved = (await local.load('local')).tasks[0];
  assert.equal(saved.attempt, 1);
  assert.ok(saved.updatedAt > previousUpdatedAt);
  assert.equal(saved.executionId, null);
  assert.equal(saved.routing, undefined);
  assert.equal(saved.workerSelection, undefined);
  sqlite.close();
});


test('local authoritative registry and PR facts operate without any GitHub calls', async () => {
  const sqlite = new SQLiteRelayStore(':memory:');
  const remote = new InMemoryStore();
  remote.pullRequestHead = remote.pullRequestState = remote.load = async () => { throw new Error('network offline'); };
  const store = new LocalAuthorityDurableStore(sqlite, remote);
  await store.saveJob(job());
  await store.applyPullRequestFacts({ state: 'MERGED', head: { ref: 'feature', sha: 'abc' }, observedAt: at });
  assert.equal(await store.pullRequestState(), 'MERGED');
  assert.equal(await store.headSha(), 'abc');
  assert.equal((await sqlite.listJobs()).length, 1);
  assert.equal(await sqlite.pendingProjectionCount(), 0);
  sqlite.close();
});

test('atomic local task and plan updates preserve concurrent independent children', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-concurrent-'));
  const path = join(dir, 'relay.db');
  const firstSqlite = new SQLiteRelayStore(path);
  const secondSqlite = new SQLiteRelayStore(path);
  const first = new LocalAuthorityDurableStore(firstSqlite, new InMemoryStore());
  const second = new LocalAuthorityDurableStore(secondSqlite, new InMemoryStore());
  await first.saveJob(job());
  const a = { ...task(), id: 'a' };
  const b = { ...task(), id: 'b' };
  await Promise.all([first.appendTask(a), second.appendTask(b)]);
  assert.deepEqual((await first.load('local')).tasks.map(value => value.id).sort(), ['a', 'b']);

  const stale = await first.load('local');
  const finished = { ...a, state: 'SUCCEEDED', updatedAt: '2026-10-08T20:02:00.000Z' };
  await second.saveTask(finished);
  await first.saveJob(stale);
  assert.equal((await first.load('local')).tasks.find(value => value.id === 'a').state, 'SUCCEEDED');

  const plan = number => ({
    jobId: 'local', id: 'plan-' + number, round: number,
    status: 'completed', trigger: 'manual', createdAt: at,
    updatedAt: at, generatedTaskIds: [], assessment: 'local',
  });
  await Promise.all([first.appendPlan(plan(1)), second.appendPlan(plan(2))]);
  assert.deepEqual((await second.load('local')).plans.map(value => value.id), ['plan-1','plan-2']);
  firstSqlite.close(); secondSqlite.close();
  await rm(dir, { recursive: true, force: true });
});

test('atomic snapshot mutation rolls back related lifecycle changes together', async () => {
  const sqlite = new SQLiteRelayStore(':memory:');
  const store = new LocalAuthorityDurableStore(sqlite, new InMemoryStore());
  await store.saveJob({ ...job(), tasks: [task()] });
  await assert.rejects(() => store.mutateJob('local', current => {
    current.state = 'CANCELLED';
    current.tasks[0].state = 'CANCELLED';
    throw new Error('simulated notification preparation failure');
  }), /simulated notification preparation failure/);
  const unchanged = await store.load('local');
  assert.equal(unchanged.state, 'ACTIVE');
  assert.equal(unchanged.tasks[0].state, 'QUEUED');
  sqlite.close();
});

test('atomic snapshot mutation serializes competing updates from fresh snapshots', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-atomic-snapshot-'));
  const path = join(dir, 'relay.db');
  const firstSqlite = new SQLiteRelayStore(path);
  const secondSqlite = new SQLiteRelayStore(path);
  const first = new LocalAuthorityDurableStore(firstSqlite, new InMemoryStore());
  const second = new LocalAuthorityDurableStore(secondSqlite, new InMemoryStore());
  await first.saveJob(job());
  await Promise.all([
    first.mutateJob('local', current => { current.tasks.push({ ...task(), id: 'first' }); return current; }),
    second.mutateJob('local', current => { current.tasks.push({ ...task(), id: 'second' }); return current; }),
  ]);
  assert.deepEqual((await first.load('local')).tasks.map(item => item.id).sort(), ['first', 'second']);
  firstSqlite.close();
  secondSqlite.close();
  await rm(dir, { recursive: true, force: true });
});

test('committed lifecycle state survives a listener notification failure', async () => {
  const sqlite = new SQLiteRelayStore(':memory:');
  const store = new LocalAuthorityDurableStore(sqlite, new InMemoryStore());
  await store.saveJob(job());
  const unsubscribe = subscribeLocalCommits(() => { throw new Error('dashboard listener unavailable'); });
  await assert.rejects(() => store.mutateJob('local', current => { current.state = 'CANCELLED'; return current; }), /dashboard listener unavailable/);
  unsubscribe();
  assert.equal((await store.load('local')).state, 'CANCELLED');
  sqlite.close();
});

test('read-only local discovery cannot reset an in-flight external action claim', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-discover-readonly-'));
  const sqlite = new SQLiteRelayStore(join(dir, 'relay.sqlite'), 'local');
  await sqlite.saveJob(job());
  await sqlite.enqueueProjection({
    idempotencyKey: 'merge-abc', operation: 'merge_pull_request',
    payload: { operation: 'merge_pull_request', expectedHeadSha: 'abc' },
  });
  assert.equal((await sqlite.claimDueProjections()).length, 1);
  const { discoverLocalRelayStoreSnapshots } = await import('../dist/relay-store.js');
  const snapshots = await discoverLocalRelayStoreSnapshots(join(dir, 'stores'));
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].jobs[0].id, 'local');
  assert.equal((await sqlite.claimDueProjections()).length, 0);
  sqlite.close();
  await rm(dir, { recursive: true, force: true });
});

test('explicit optional GitHub projection cannot complete local Job even after remote merge', async () => {
  const sqlite = new SQLiteRelayStore(':memory:');
  const offline = new InMemoryStore();
  let mergeCalls = 0;
  let available = false;
  offline.mergePullRequest = async sha => {
    mergeCalls++;
    assert.equal(sha, 'head-sha');
    if (!available) throw new Error('simulated GitHub outage');
  };
  const store = new LocalAuthorityDurableStore(sqlite, offline, () => store);
  const active = { ...job(), autoMerge: false, reviewEnabled: false, headSha: 'head-sha' };
  await store.saveJob(active);
  await store.applyPullRequestFacts({
    state: 'OPEN', head: { ref: 'feature', sha: 'head-sha' }, observedAt: at,
  });

  await Promise.all([store.mergePullRequest('head-sha'), store.mergePullRequest('head-sha')]);
  assert.equal(await sqlite.pendingProjectionCount(), 1);
  const deferred = await store.projection.flushOnce();
  assert.equal(deferred.projected, 0);
  assert.equal(deferred.deferred, 1);
  assert.equal(await sqlite.pendingProjectionCount(), 1);
  assert.equal(await store.pullRequestState(), 'OPEN');
  assert.equal((await store.load('local')).state, 'ACTIVE');

  // Repeated Graph decisions must not reset the durable retry/backoff claim.
  await store.mergePullRequest('head-sha');
  assert.deepEqual(await store.projection.flushOnce(), { projected: 0, deferred: 0 });
  assert.equal(mergeCalls, 1);

  available = true;
  assert.deepEqual(await store.projection.flushOnce(50, new Date(Date.now() + 120_000)), {
    projected: 1, deferred: 0,
  });
  assert.equal(mergeCalls, 2);
  assert.equal(await store.pullRequestState(), 'MERGED');
  assert.equal((await store.load('local')).state, 'ACTIVE');

  const reconciler = managedReconciler(store, {
    owner: 'test', maxConcurrent: 0, adapters: [],
    projectPathForJob: () => process.cwd(),
  });
  const settled = await reconciler.reconcile('local');
  assert.equal(settled.state, 'ACTIVE');
  assert.equal(await sqlite.pendingProjectionCount(), 0);
  await store.mergePullRequest('head-sha');
  assert.equal(await sqlite.pendingProjectionCount(), 0);
  assert.equal(mergeCalls, 2);
  sqlite.close();
});

test('old lifecycle projection cannot write GitHub markers in local-authority mode', async () => {
  const sqlite = new SQLiteRelayStore(':memory:');
  const remote = new InMemoryStore(job());
  remote.saveTask = async () => { throw new Error('Forbidden lifecycle projection'); };
  const store = new LocalAuthorityDurableStore(sqlite, remote);
  await sqlite.enqueueProjection({
    idempotencyKey: 'legacy-save-task', operation: 'save_task',
    payload: { operation: 'save_task', value: task() },
  });
  assert.deepEqual(await store.projection.flushOnce(), { projected: 0, deferred: 0 });
  assert.equal(await sqlite.pendingProjectionCount(), 0);
  sqlite.close();
});

test('offline Graph reconciliation creates and persists a troubleshooter without manual retry', async () => {
  const db = new SQLiteRelayStore(':memory:');
  const remote = new InMemoryStore();
  for (const op of ['load','comments','pullRequestState','pullRequestHead']) {
    remote[op] = async () => { throw new Error('unexpected GitHub API: ' + op); };
  }
  const store = new LocalAuthorityDurableStore(db, remote);
  const failed = { ...task('FAILED'), id: 'broken', adapter: 'codex', attempt: 1,
    error: 'worker process exited unexpectedly', failureReason: 'worker_process_failed',
    output: { kind: 'file', path: 'runs/offline-recovery.md' },
    updatedAt: '2026-10-08T20:01:00.000Z' };
  await store.saveJob({ ...job(), repository: 'lalalic/agents-relay', reviewEnabled: false, autoMerge: false,
    tasks: [failed], updatedAt: '2026-10-08T20:01:00.000Z' });
  await store.applyPullRequestFacts({ state: 'OPEN',
    head: { ref: 'feature', sha: 'offline-head' }, observedAt: at });
  const reconciler = managedReconciler(store, {
    owner: 'offline-test', adapters: [], maxConcurrent: 0,
    projectPathForJob: () => process.cwd(),
  });
  await reconciler.reconcile('local');
  const current = await store.load('local');
  const recovery = current.tasks.filter(item => item.agentName === 'troubleshooter');
  assert.equal(recovery.length, 1);
  assert.equal(recovery[0].parentTaskId, 'broken');
  assert.equal(recovery[0].state, 'QUEUED');
  await reconciler.reconcile('local');
  assert.equal((await store.load('local')).tasks.filter(item => item.agentName === 'troubleshooter').length, 1);
  assert.equal(await db.pendingProjectionCount(), 0);
  db.close();
});

test('offline Review approval is Graph-owned, durable, and never queues GitHub merge', async () => {
  const db = new SQLiteRelayStore(':memory:');
  const remote = new InMemoryStore();
  for (const method of ['load','comments','pullRequestState','pullRequestHead']) {
    remote[method] = async () => { throw new Error('GitHub unavailable: ' + method); };
  }
  const local = new LocalAuthorityDurableStore(db, remote);
  const head = 'deadbeef0011223344556677889900abcdefabcd';
  const implementation = { ...task('SUCCEEDED'), id: 'implementation',
    updatedAt: '2026-10-08T20:01:00.000Z' };
  const review = { ...task('RUNNING'), id: 'review-local', agentName: 'reviewer',
    reviewHeadSha: head, dependencies: ['implementation'],
    updatedAt: '2026-10-08T20:02:00.000Z' };
  await local.saveJob({ ...job(), headSha: head, autoMerge: true, reviewEnabled: true,
    tasks: [implementation, review], review: {
      outcome: 'pending', headSha: head, taskId: review.id, evidence: null,
      updatedAt: '2026-10-08T20:02:00.000Z',
    }, updatedAt: '2026-10-08T20:02:00.000Z' });
  await local.applyPullRequestFacts({ state: 'OPEN',
    head: { ref: 'feature', sha: head }, observedAt: at });
  const reconciler = managedReconciler(local, {
    owner: 'offline-review-test', adapters: [], maxConcurrent: 0,
  });
  const observed = await reconciler.applyEvent(eventFor('local', review.id, null,
    'review.approved', 'succeeded', 'approved', 'orchestrator',
    { review: { headSha: head, summary: 'approved', blockingFindings: [] } }));
  assert.equal(observed.applied, true, observed.reason);
  const changed = await local.load('local');
  assert.equal(changed.review?.outcome, 'approved');
  assert.equal(changed.tasks.find(item => item.id === review.id)?.state, 'SUCCEEDED');
  assert.equal(changed.state, 'ACTIVE');
  assert.equal(await local.pullRequestState(), 'OPEN');
  assert.equal(await db.pendingProjectionCount(), 0);
  db.close();
});

test('stale Job snapshots cannot overwrite newer head and policy scalars', async () => {
  const sqlite = new SQLiteRelayStore(':memory:');
  const store = new LocalAuthorityDurableStore(sqlite, new InMemoryStore());
  await store.saveJob({ ...job(), updatedAt: '2026-10-08T20:00:00.000Z' });
  const stale = await store.load('local');
  const latest = { ...stale, headSha: 'sha-new', reviewEnabled: false,
    objective: 'newer objective', updatedAt: '2026-10-08T20:04:00.000Z' };
  await store.saveJob(latest);
  await store.saveJob({ ...stale, title: 'stale caller',
    updatedAt: '2026-10-08T20:01:00.000Z' });
  const preserved = await store.load('local');
  assert.equal(preserved.headSha, 'sha-new');
  assert.equal(preserved.reviewEnabled, false);
  assert.equal(preserved.objective, 'newer objective');
  assert.notEqual(preserved.title, 'stale caller');
  sqlite.close();
});

test('stale Task and Plan writes cannot resurrect completed execution or regress durable plans', async () => {
  const sqlite = new SQLiteRelayStore(':memory:');
  const store = new LocalAuthorityDurableStore(sqlite, new InMemoryStore());
  await store.saveJob(job());
  const initial = { ...task('RUNNING'), attempt: 1,
    updatedAt: '2026-10-08T20:01:00.000Z' };
  await store.appendTask(initial);
  const completed = { ...initial, state: 'SUCCEEDED', executionId: null,
    result: { summary: 'done' }, updatedAt: '2026-10-08T20:03:00.000Z' };
  await store.saveTask(completed);
  await store.saveTask({ ...initial, updatedAt: '2026-10-08T20:02:00.000Z' });
  assert.equal((await store.load('local')).tasks[0].state, 'SUCCEEDED');
  await store.saveTask({ ...initial, attempt: 0, updatedAt: '2026-10-08T20:04:00.000Z' });
  assert.equal((await store.load('local')).tasks[0].state, 'SUCCEEDED');

  const oldPlan = {
    jobId: 'local', id: 'p1', round: 1, status: 'PLANNING',
    source: 'model-planner', previousPlanId: null,
    trigger: { source: 'initial' }, createdAt: at,
    updatedAt: '2026-10-08T20:01:00.000Z',
    generatedTaskIds: [], assessment: 'draft',
  };
  await store.appendPlan(oldPlan);
  await store.savePlan({ ...oldPlan, status: 'SUCCEEDED',
    updatedAt: '2026-10-08T20:03:00.000Z' });
  await store.savePlan({ ...oldPlan, status: 'PLANNING',
    updatedAt: '2026-10-08T20:02:00.000Z' });
  assert.equal((await store.load('local')).plans[0].status, 'SUCCEEDED');
  sqlite.close();
});

test('offline Graph automatically creates exactly one final-review Task', async () => {
  const sqlite = new SQLiteRelayStore(':memory:');
  const remote = new InMemoryStore();
  remote.load = remote.comments = remote.pullRequestState = async () => {
    throw new Error('GitHub unavailable');
  };
  const store = new LocalAuthorityDurableStore(sqlite, remote);
  const head = 'cafebabedeadbeefcafebabedeadbeef00112233';
  await store.saveJob({ ...job(), reviewEnabled: true, autoMerge: false, headSha: head,
    tasks: [{ ...task('SUCCEEDED'), id: 'work', adapter: 'codex',
      routing: { provider: 'openai', model: 'gpt-test', decidedBy: 'test', decidedAt: at },
      result: { summary: 'done' } }] });
  await store.applyPullRequestFacts({ state: 'OPEN',
    head: { ref: 'feature', sha: head }, observedAt: at });
  const reconciler = managedReconciler(store, {
    owner: 'offline-review-creation', adapters: [{ name: 'codex', id: 'fake-codex',
      capabilities: ['model', 'codex'] }], maxConcurrent: 0,
    reviewer: { adapter: 'chatgpt',
      routing: { provider: 'chatgpt', model: 'account-defaults', decidedBy: 'test', decidedAt: at } },
    projectPathForJob: () => process.cwd(),
  });
  await reconciler.reconcile('local');
  await reconciler.reconcile('local');
  const observed = await store.load('local');
  assert.equal(observed.tasks.filter(t => t.agentName === 'reviewer').length, 1);
  assert.equal(observed.review?.outcome, 'pending');
  assert.equal(await sqlite.pendingProjectionCount(), 0);
  sqlite.close();
});

test('out-of-order synchronize webhook timestamps cannot regress the durable PR head', async () => {
  const sqlite = new SQLiteRelayStore(':memory:');
  const local = new LocalAuthorityDurableStore(sqlite, new InMemoryStore());
  await local.saveJob(job());
  const toFacts = (sha, updated_at, delivery) => {
    const wake = parseGitHubWebhook({
      'x-github-delivery': delivery, 'x-github-event': 'pull_request',
    }, Buffer.from(JSON.stringify({
      action: 'synchronize', repository: { full_name: 'owner/repo' },
      pull_request: { number: 12, head: { ref: 'feature', sha }, updated_at },
    })));
    return wake.pullRequestFacts;
  };
  const newer = toFacts('sha-latest', '2026-10-08T20:04:00Z', 'delivery-new');
  const older = toFacts('sha-stale', '2026-10-08T20:01:00Z', 'delivery-old');
  assert.equal(newer.observedAt, '2026-10-08T20:04:00.000Z');
  await local.applyPullRequestFacts(newer);
  await local.applyPullRequestFacts(older);
  assert.equal((await local.pullRequestHead()).sha, 'sha-latest');
  sqlite.close();
});

test('concurrent local agent registration never deletes another agent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-agent-atomic-'));
  const path = join(dir, 'registry.db');
  const one = new SQLiteRelayStore(path);
  const two = new SQLiteRelayStore(path);
  const a = new LocalAuthorityDurableStore(one, new InMemoryStore());
  const b = new LocalAuthorityDurableStore(two, new InMemoryStore());
  await Promise.all([
    a.saveAgent({ id: 'agent-a', name: 'A', updatedAt: at }),
    b.saveAgent({ id: 'agent-b', name: 'B', updatedAt: at }),
  ]);
  assert.deepEqual((await a.listAgents()).map(item => item.id).sort(), ['agent-a','agent-b']);
  one.close(); two.close();
  await rm(dir, { recursive: true, force: true });
});

test('UNKNOWN PR proceeds through local worker scheduling without GitHub reads', async () => {
  const sqlite = new SQLiteRelayStore(':memory:');
  const remote = new InMemoryStore();
  remote.pullRequestState = async () => { throw new Error('GitHub offline'); };
  remote.pullRequestHead = async () => { throw new Error('GitHub offline'); };
  const local = new LocalAuthorityDurableStore(sqlite, remote);
  await local.saveJob({ ...job(), state: 'ACTIVE', tasks: [task('QUEUED')] });
  assert.equal(await local.pullRequestState(), 'UNKNOWN');
  const reconciler = managedReconciler(local, {
    owner: 'unknown-pr-test', adapters: [], maxConcurrent: 2,
    projectPathForJob: () => process.cwd(),
  });
  await reconciler.reconcile('local');
  assert.equal((await local.load('local')).tasks[0].state, 'BLOCKED'); // reached dispatch; model worker requires EventBus
  assert.equal(await sqlite.pendingProjectionCount(), 0);
  sqlite.close();
});

test('UNKNOWN PR still reconciles local failed-work recovery without launching PR work', async () => {
  const sqlite = new SQLiteRelayStore(':memory:');
  const local = new LocalAuthorityDurableStore(sqlite, new InMemoryStore());
  await local.saveJob({ ...job(), repository: 'lalalic/agents-relay', state: 'ACTIVE',
    tasks: [{
      ...task('FAILED'), id: 'broken-unverified', adapter: 'codex',
      error: 'worker process failed', failureReason: 'worker_process_failed',
      updatedAt: '2026-10-08T20:02:00.000Z',
    }] });
  assert.equal(await local.pullRequestState(), 'UNKNOWN');
  const reconciler = managedReconciler(local, {
    owner: 'unknown-recovery-test', adapters: [], maxConcurrent: 0,
    projectPathForJob: () => process.cwd(),
  });
  await reconciler.reconcile('local');
  const saved = await local.load('local');
  assert.equal(saved.tasks.filter(t => t.agentName === 'troubleshooter').length, 1);
  assert.equal(await local.pullRequestState(), 'UNKNOWN');
  assert.equal(await sqlite.pendingProjectionCount(), 0);
  sqlite.close();
});


test('UNKNOWN PR still creates a local final Review without requesting Merge', async () => {
  const sqlite = new SQLiteRelayStore(':memory:');
  const remote = new InMemoryStore();
  remote.pullRequestState = async () => { throw new Error('GitHub offline'); };
  const local = new LocalAuthorityDurableStore(sqlite, remote);
  const sha = 'offline-review-head';
  await local.saveJob({ ...job(), state:'ACTIVE', headSha: sha, autoMerge: true, reviewEnabled: true,
    tasks:[{ ...task('SUCCEEDED'), id: 'done', updatedAt: new Date().toISOString() }] });
  const reconciler = managedReconciler(local, { owner:'offline-review-reconcile', adapters:[], maxConcurrent:0,
    reviewer: { adapter:'chatgpt', routing:{provider:'chatgpt', model:'account-defaults', decidedBy:'test', decidedAt: new Date().toISOString()} },
    projectPathForJob: () => process.cwd() });
  await reconciler.reconcile('local');
  const saved = await local.load('local');
  assert.equal(saved.tasks.filter(t => t.agentName === 'reviewer').length, 1);
  assert.equal(saved.state, 'ACTIVE');
  assert.equal(await sqlite.pendingProjectionCount(), 0);
  sqlite.close();
});

test('local managed store rejects repository identities that can escape the stores directory', async () => {
  const { openLocalManagedStore } = await import('../dist/local-managed-store.js');
  for (const repository of ['owner/../escape','../owner/repo','owner/repo/extra','owner//repo','owner/repo..']) {
    assert.throws(() => openLocalManagedStore(repository,1,{directory:'/tmp/relay-safe-store',noGitHub:true}),/requires a repository/);
  }
});

test('equal-timestamp stale Job save cannot overwrite newer SQLite scalars', async () => {
  const sqlite=new SQLiteRelayStore(':memory:');
  const store=new LocalAuthorityDurableStore(sqlite,new InMemoryStore());
  const base={...job(),updatedAt:'2026-10-09T01:20:00.000Z',objective:'base'};
  await store.saveJob(base);
  const stale=await store.load('local');
  await store.appendTask({...task(),id:'new-child'});
  const afterMutation=await store.load('local');
  assert.ok(afterMutation.updatedAt>stale.updatedAt);
  await store.saveJob({...stale,updatedAt:afterMutation.updatedAt,objective:'stale-overwrite',reviewEnabled:false});
  const preserved=await store.load('local');
  assert.notEqual(preserved.objective,'stale-overwrite');
  assert.notEqual(preserved.reviewEnabled,false);
  assert.ok(preserved.tasks.some(item=>item.id==='new-child'));
  sqlite.close();
});

test('equal-timestamp stale Task save cannot regress durable Task state', async () => {
  const sqlite=new SQLiteRelayStore(':memory:');
  const store=new LocalAuthorityDurableStore(sqlite,new InMemoryStore());
  await store.saveJob(job());
  const running={...task('RUNNING'),attempt:1,updatedAt:'2026-10-09T01:30:00.000Z'};
  await store.appendTask(running);
  const succeeded={...running,state:'SUCCEEDED',result:{summary:'done'},executionId:null,
    updatedAt:'2026-10-09T01:31:00.000Z'};
  await store.saveTask(succeeded);
  await store.saveTask({...running,state:'RUNNING',updatedAt:'2026-10-09T01:31:00.000Z'});
  const preserved=(await store.load('local')).tasks.find(item=>item.id===running.id);
  assert.equal(preserved.state,'SUCCEEDED');
  assert.equal(preserved.result.summary,'done');
  sqlite.close();
});

test('MERGED and CLOSED GitHub facts are audit-only: no local Task mutation or reconcile wake', async () => {
  const sqlite = new SQLiteRelayStore(':memory:');
  const store = new LocalAuthorityDurableStore(sqlite, new InMemoryStore());
  await store.saveJob({ ...job(), tasks: [task('QUEUED')], headSha: 'local-authoritative-sha' });
  const reconciler = managedReconciler(store, {
    owner: 'github-fact-audit-test', adapters: [], maxConcurrent: 0,
  });
  for (const [index, state] of ['CLOSED', 'MERGED'].entries()) {
    await store.applyPullRequestFacts({
      state, head: { ref: 'remote-branch', sha: state === 'MERGED' ? 'external-merge' : 'external-close' },
      observedAt: new Date(Date.now() + index * 1000).toISOString(),
    });
    const received = await reconciler.applyEvent(eventFor('local', 'github', null,
      'github.webhook', 'queued', 'Remote state observed', 'orchestrator',
      { repository: 'owner/repo', prNumber: 12, state }));
    assert.equal(received.reconcile, false);
    const after = await reconciler.reconcile('local');
    assert.equal(after.state, 'ACTIVE');
    assert.equal(after.tasks.find(item => item.id === 't1').state, 'QUEUED');
    assert.equal(after.headSha, 'local-authoritative-sha');
  }
  assert.equal(await store.pullRequestState(), 'MERGED');
  sqlite.close();
});
test('newer stale DRAFT snapshot cannot roll an activated Job back to DRAFT', async () => {
  const sqlite = new SQLiteRelayStore(':memory:');
  const store = new LocalAuthorityDurableStore(sqlite, new InMemoryStore());
  const draft = { ...job(), state: 'DRAFT', updatedAt: '2026-10-09T01:00:00.000Z' };
  await store.saveJob(draft);
  const stale = await store.load('local');
  await store.mutateJob('local', current => {
    current.state = 'ACTIVE';
    current.updatedAt = '2026-10-09T01:01:00.000Z';
    return current;
  });
  // Simulate a late-arriving stale snapshot from another lifecycle action.
  await store.saveJob({ ...stale, updatedAt: '2026-10-09T01:02:00.000Z' });
  assert.equal((await store.load('local')).state, 'ACTIVE');
  sqlite.close();
});

test('manual planner atomically activates a DRAFT job in SQLite before launching planner', async () => {
  const { executeManualPlan } = await import('../dist/manual-plan.js');
  const path = await mkdtemp(join(tmpdir(), 'relay-atomic-manual-plan-'));
  const sqlite = new SQLiteRelayStore(join(path, 'state.db'));
  try {
    const store = new LocalAuthorityDurableStore(sqlite, new InMemoryStore());
    await store.saveJob({ ...job('manual-atomic'), state: 'DRAFT', plans: [] });
    const result = await executeManualPlan(store, 'manual-atomic', 'implement', 30000, async (_job, plan) => {
      assert.equal((await store.load('manual-atomic')).state, 'ACTIVE');
      await store.savePlan({ ...plan, status: 'SUCCEEDED', updatedAt: new Date().toISOString() });
    });
    assert.equal(result.job.state, 'ACTIVE');
    assert.equal((await store.load('manual-atomic')).state, 'ACTIVE');
  } finally {
    sqlite.close();
    await rm(path, { recursive: true, force: true });
  }
});
