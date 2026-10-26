import test, { managedReconciler } from './test-runtime.js';
import assert from 'node:assert/strict';
import { InMemoryStore } from '../dist/store.js';
import { pauseJob, resumeJob } from '../dist/job-pause.js';
import { refreshTaskDependencies } from '../dist/task-transitions.js';

const now = () => new Date().toISOString();
const task = (id, state = 'RUNNING', executionId = 'exec-1') => ({
  jobId: id.split('-')[0], id, kind: 'work', parentTaskId: null, dependencies: [], capabilities: [], adapter: 'codex', input: 'work',
  state, attempt: 2, maxAttempts: 3, leaseOwner: 'relay', leaseExpiresAt: now(), executionId, threadId: null, result: null, error: null, timeoutMs: 1000, createdAt: now(), updatedAt: now(),
});
const job = (id, tasks) => ({ id, title: id, repository: 'local/test', prNumber: 0, state: 'ACTIVE', executionMode: 'fixed', continuation: null, createdAt: now(), updatedAt: now(), tasks });

test('pause atomically gates dispatch and preserves resumable execution identity', async () => {
  const work = task('a-work');
  const store = new InMemoryStore(job('a', [work]));
  const paused = await pauseJob(store, 'a');
  assert.equal(paused.state, 'ACTIVE');
  assert.equal(paused.pause?.generation, 1);
  assert.equal(paused.tasks[0].state, 'QUEUED');
  assert.equal(paused.tasks[0].executionId, null);
  assert.equal(paused.tasks[0].pausedExecution?.id, 'exec-1');
  assert.equal(refreshTaskDependencies(paused).tasks[0].state, 'QUEUED');

  const resumed = await resumeJob(store, 'a');
  assert.equal(resumed.pause, undefined);
  assert.equal(resumed.tasks[0].state, 'QUEUED');
  assert.equal(resumed.tasks[0].pausedExecution, undefined);
  assert.equal(resumed.tasks[0].executionId, null);
});

test('pause and resume are isolated between Jobs', async () => {
  const store = new InMemoryStore(job('a', [task('a-work')])) ;
  await store.saveJob(job('b', []));
  await store.appendTask(task('b-work', 'QUEUED', null));
  await pauseJob(store, 'a');
  assert.ok((await store.load('a')).pause);
  assert.equal((await store.load('b')).pause, undefined);
  assert.equal((await store.load('b')).tasks[0].state, 'QUEUED');
});

test('late terminal events cannot correlate after pause', async () => {
  const work = task('a-work');
  const store = new InMemoryStore(job('a', [work]));
  await pauseJob(store, 'a');
  const current = await store.load('a');
  assert.equal(current.tasks[0].executionId, null);
  assert.equal(current.tasks[0].pausedExecution?.id, 'exec-1');
});

test('paused reconciliation does not dispatch new work', async () => {
  const store = new InMemoryStore(job('a', [task('a-work', 'QUEUED', null)]));
  await pauseJob(store, 'a');
  const reconciler = managedReconciler(store, { owner: 'pause-test', noGitHub: true, maxConcurrent: 1, adapters: [] });
  const result = await reconciler.reconcile('a');
  assert.equal(result.tasks[0].state, 'QUEUED');
  assert.equal(result.tasks[0].executionId, null);
});


test('resume restores an executable retry budget after interrupted final attempt', async () => {
  const work = { ...task('a-work'), attempt: 3, maxAttempts: 3 };
  const store = new InMemoryStore(job('a', [work]));
  await pauseJob(store, 'a');
  const resumed = await resumeJob(store, 'a');
  assert.equal(resumed.tasks[0].state, 'QUEUED');
  assert.ok(resumed.tasks[0].maxAttempts > resumed.tasks[0].attempt);
});
