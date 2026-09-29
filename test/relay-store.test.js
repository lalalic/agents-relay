import test, { managedReconciler } from './test-runtime.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteRelayStore } from '../dist/relay-store.js';
import { ProjectedDurableStore, GitHubProjectionWriter, githubProjectionRetryAt } from '../dist/projected-store.js';
import { InMemoryStore } from '../dist/store.js';

const now = () => new Date().toISOString();
const makeTask = (state = 'QUEUED') => ({
  jobId: 'job-1', id: 'task-1', parentTaskId: null, dependencies: [], capabilities: [],
  adapter: 'orchestrator', input: 'work', state, attempt: 0, maxAttempts: 2,
  leaseOwner: null, leaseExpiresAt: null, executionId: null, threadId: null,
  result: null, error: null, timeoutMs: 1000, createdAt: now(), updatedAt: now(),
  continuation: null, continuationDeliveredAt: null
});
const makeJob = () => ({
  id: 'job-1', title: 'job', executionMode: 'fixed', prNumber: 1, repository: 'lalalic/agents-relay',
  state: 'ACTIVE', continuation: null, createdAt: now(), updatedAt: now(), tasks: [makeTask()]
});

async function tempDb() {
  const dir = await mkdtemp(join(tmpdir(), 'agents-relay-store-'));
  return { dir, path: join(dir, 'relay.db'), close: async store => { store?.close(); await rm(dir, { recursive: true, force: true }); } };
}

test('SQLiteRelayStore persists snapshots, event dedupe, and outbox across restart', async () => {
  const tmp = await tempDb();
  let store = new SQLiteRelayStore(tmp.path);
  const job = makeJob();
  await store.saveJob(job);
  assert.equal(await store.markEventProcessed('evt-1', 'tasks', 1), true);
  assert.equal(await store.markEventProcessed('evt-1', 'tasks', 1), false);
  await store.enqueueProjection({ idempotencyKey: 'task-1', coalesceKey: 'task:job-1:task-1', operation: 'save_task', payload: { operation: 'save_task', value: job.tasks[0] } });
  assert.equal(await store.pendingProjectionCount(), 1);
  store.close();

  store = new SQLiteRelayStore(tmp.path);
  assert.equal((await store.loadJob('job-1')).id, 'job-1');
  assert.equal(await store.pendingProjectionCount(), 1);
  const [claimed] = await store.claimDueProjections();
  assert.equal(claimed.idempotencyKey, 'task-1');
  store.close();

  store = new SQLiteRelayStore(tmp.path);
  const [recovered] = await store.claimDueProjections();
  assert.equal(recovered.id, claimed.id);
  await store.completeProjection(recovered.id);
  assert.equal(await store.pendingProjectionCount(), 0);
  await tmp.close(store);
});

test('ProjectedDurableStore reconciles from durable PR facts while GitHub reads are unavailable', async () => {
  const tmp = await tempDb();
  const relay = new SQLiteRelayStore(tmp.path);
  const root = makeJob();
  root.tasks = [
    { ...makeTask('SUCCEEDED'), id: 'dependency' },
    { ...makeTask('DRAFT'), id: 'dependent', dependencies: ['dependency'] },
  ];
  const remote = new InMemoryStore(root);
  remote.pullRequestState = async () => { throw new Error('GitHub state read should not run'); };
  remote.pullRequestHead = async () => { throw new Error('GitHub head read should not run'); };
  remote.headSha = async () => { throw new Error('GitHub SHA read should not run'); };
  const local = new ProjectedDurableStore(relay, remote, { prNode: { state: 'OPEN', headRefName: 'feat/local', headRefOid: 'offline-sha' }, comments: [] });
  const reconcilerStore = new Proxy(local, { get(target, property, receiver) { if (property === 'pullRequestHead') return undefined; if (property === 'headSha') return target.headSha.bind(target); return Reflect.get(target, property, receiver); } });
  const reconciler = managedReconciler(reconcilerStore, { owner: 'test', adapters: [], maxConcurrent: 1, projectPathForJob: () => process.cwd() });

  const reconciled = await reconciler.reconcile('job-1');
  assert.equal(reconciled.tasks.find(task => task.id === 'dependent').state, 'QUEUED');
  assert.equal(await local.pullRequestState(), 'OPEN');
  assert.deepEqual(await local.pullRequestHead(), { ref: 'feat/local', sha: 'offline-sha' });

  relay.close();
  const restarted = new SQLiteRelayStore(tmp.path);
  const restartedLocal = new ProjectedDurableStore(restarted, remote);
  assert.equal(await restartedLocal.pullRequestState(), 'OPEN');
  assert.deepEqual(await restartedLocal.pullRequestHead(), { ref: 'feat/local', sha: 'offline-sha' });
  await tmp.close(restarted);
});

test('SQLiteRelayStore coalesces pending mutations for the same projection key', async () => {
  const tmp = await tempDb();
  const store = new SQLiteRelayStore(tmp.path);
  await store.enqueueProjection({ idempotencyKey: 'v1', coalesceKey: 'task:j:t', operation: 'save_task', payload: { n: 1 } });
  await store.enqueueProjection({ idempotencyKey: 'v2', coalesceKey: 'task:j:t', operation: 'save_task', payload: { n: 2 } });
  assert.equal(await store.pendingProjectionCount(), 1);
  const [item] = await store.claimDueProjections();
  assert.deepEqual(item.payload, { n: 2 });
  await tmp.close(store);
});

test('SQLiteRelayStore preserves a newer projection queued while an older one is processing', async () => {
  const tmp = await tempDb();
  const store = new SQLiteRelayStore(tmp.path);
  await store.enqueueProjection({ idempotencyKey: 'save_task:j:t', coalesceKey: 'task:j:t', operation: 'save_task', payload: { operation: 'save_task', value: { state: 'RUNNING' } } });
  const [inFlight] = await store.claimDueProjections();
  await store.enqueueProjection({ idempotencyKey: 'save_task:j:t', coalesceKey: 'task:j:t', operation: 'save_task', payload: { operation: 'save_task', value: { state: 'SUCCEEDED' } } });
  await store.completeProjection(inFlight.id);
  const [newer] = await store.claimDueProjections();
  assert.deepEqual(newer.payload, { operation: 'save_task', value: { state: 'SUCCEEDED' } });
  await tmp.close(store);
});

test('SQLiteRelayStore atomically rolls back a snapshot when projection enqueue fails', async () => {
  const tmp = await tempDb();
  const store = new SQLiteRelayStore(tmp.path);
  const job = makeJob();
  await assert.rejects(() => store.saveJobWithProjection(job, {
    idempotencyKey: 'bad', operation: 'save_job', payload: { value: BigInt(1) }
  }));
  assert.equal(await store.loadJob(job.id), null);
  assert.equal(await store.pendingProjectionCount(), 0);
  await tmp.close(store);
});

test('ProjectedDurableStore bootstraps state and head together on a cold start', async () => {
  const tmp = await tempDb();
  const relay = new SQLiteRelayStore(tmp.path);
  const remote = new InMemoryStore(makeJob());
  remote.pullRequestState = async () => 'OPEN';
  remote.pullRequestHead = async () => ({ ref: 'feat/cold', sha: 'cold-sha' });
  const local = new ProjectedDurableStore(relay, remote);
  assert.equal(await local.pullRequestState(), 'OPEN');
  assert.deepEqual(await local.pullRequestHead(), { ref: 'feat/cold', sha: 'cold-sha' });
  relay.close();
  const restarted = new SQLiteRelayStore(tmp.path);
  remote.pullRequestState = async () => { throw new Error('offline state read'); };
  remote.pullRequestHead = async () => { throw new Error('offline head read'); };
  const offline = new ProjectedDurableStore(restarted, remote);
  assert.equal(await offline.pullRequestState(), 'OPEN');
  assert.deepEqual(await offline.pullRequestHead(), { ref: 'feat/cold', sha: 'cold-sha' });
  await tmp.close(restarted);
});

test('ProjectedDurableStore advances local task state while GitHub projection is unavailable, then catches up', async () => {
  const tmp = await tempDb();
  const relay = new SQLiteRelayStore(tmp.path);
  const remote = new InMemoryStore(makeJob());
  const local = new ProjectedDurableStore(relay, remote);
  await local.load('job-1');

  const task = makeTask('RUNNING');
  await local.saveTask(task);
  task.state = 'SUCCEEDED';
  task.updatedAt = now();
  task.result = { summary: 'done' };
  await local.saveTask(task);

  assert.equal((await local.load('job-1')).tasks[0].state, 'SUCCEEDED');
  assert.equal((await remote.load('job-1')).tasks[0].state, 'QUEUED');
  assert.equal(await relay.pendingProjectionCount(), 1);

  const result = await local.projection.flushOnce();
  assert.deepEqual(result, { projected: 1, deferred: 0 });
  assert.equal((await remote.load('job-1')).tasks[0].state, 'SUCCEEDED');
  assert.equal(await relay.pendingProjectionCount(), 0);
  await tmp.close(relay);
});

test('GitHubProjectionWriter defers rate-limited writes and respects retry-after', async () => {
  const tmp = await tempDb();
  const relay = new SQLiteRelayStore(tmp.path);
  const job = makeJob();
  await relay.saveJob(job);
  await relay.enqueueProjection({
    idempotencyKey: 'save_job:job-1',
    operation: 'save_job',
    payload: { operation: 'save_job', value: job }
  });
  const failing = {
    ...new InMemoryStore(job),
    saveJob: async () => {
      const error = new Error('secondary rate limit');
      error.response = { headers: { 'retry-after': '60' } };
      throw error;
    }
  };
  const writer = new GitHubProjectionWriter(relay, failing);
  const base = new Date('2026-09-29T20:00:00.000Z');
  assert.deepEqual(await writer.flushOnce(10, base), { projected: 0, deferred: 1 });
  assert.equal(await relay.pendingProjectionCount(), 1);
  assert.deepEqual(await relay.claimDueProjections(10, new Date(base.getTime() + 59_000)), []);
  assert.equal((await relay.claimDueProjections(10, new Date(base.getTime() + 61_000))).length, 1);
  assert.equal(githubProjectionRetryAt({ headers: { 'retry-after': '7' } }, 0, base).toISOString(), '2026-09-29T20:00:07.000Z');
  await tmp.close(relay);
});

test('SQLite WAL permits a second store instance to read committed operational state', async () => {
  const tmp = await tempDb();
  const first = new SQLiteRelayStore(tmp.path);
  const second = new SQLiteRelayStore(tmp.path);
  await first.saveJob(makeJob());
  assert.equal((await second.loadJob('job-1')).id, 'job-1');
  assert.equal(await first.markEventProcessed('evt-concurrent'), true);
  assert.equal(await second.markEventProcessed('evt-concurrent'), false);
  second.close();
  await tmp.close(first);
});
