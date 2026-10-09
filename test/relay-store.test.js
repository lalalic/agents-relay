import test, { managedReconciler } from './test-runtime.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { discoverLocalRelayStoreSnapshots, SQLiteRelayStore } from '../dist/relay-store.js';
import { ProjectedDurableStore, GitHubProjectionWriter, githubProjectionRetryAt, isTerminalProjectionFailure } from '../dist/projected-store.js';
import { DurableDefinitionConflictError } from '../dist/store-task-definition.js';
import { decideProjectionFailure } from '../dist/workflow/projection-conflict-v2.js';
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

const makeAgent = () => ({
  id: 'agent-1', name: 'Agent One', responsibility: 'test', role: 'implementation', capabilities: ['implementation'], boundaries: [],
  endpoint: { kind: 'adapter', target: 'codex' }, runtime: { adapter: 'codex' }, availability: 'available', routing: {},
  evidence: { evaluations: [], outcomes: { succeeded: 0, failed: 0, timedOut: 0 }, lastObservedAt: null }, registeredAt: now(), updatedAt: now()
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

  // Opening another client must not steal a live action claim.
  const second = new SQLiteRelayStore(tmp.path);
  assert.equal((await second.claimDueProjections()).length, 0);
  second.close();

  // A crashed writer's old claim eventually becomes recoverable.
  const ageing = new DatabaseSync(tmp.path);
  ageing.prepare("UPDATE projection_outbox SET updated_at=? WHERE status='processing'")
    .run(new Date(Date.now() - 180_000).toISOString());
  ageing.close();
  store = new SQLiteRelayStore(tmp.path);
  const [recovered] = await store.claimDueProjections();
  assert.equal(recovered.id, claimed.id);
  await store.completeProjection(recovered.id);
  assert.equal(await store.pendingProjectionCount(), 0);
  await tmp.close(store);
});

test('RelayStore discovery rebuilds local operational inventory without GitHub', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agents-relay-store-discovery-'));
  const a = new SQLiteRelayStore(join(dir, 'a.db'));
  const first = makeJob();
  first.id = 'first'; first.prNumber = 11; first.repository = 'owner/one';
  await a.saveJob(first);
  await a.savePullRequestFacts({ state: 'OPEN', head: { ref: 'feat/one', sha: 'sha-one' }, observedAt: now() });
  a.close();
  const b = new SQLiteRelayStore(join(dir, 'b.db'));
  const second = makeJob();
  second.id = 'second'; second.prNumber = 22; second.repository = 'owner/two';
  await b.saveJob(second);
  await b.savePullRequestFacts({ state: 'CLOSED', head: null, observedAt: now() });
  b.close();
  await writeFile(join(dir, 'not-a-db.db'), 'invalid');
  const snapshots = await discoverLocalRelayStoreSnapshots(dir);
  assert.deepEqual(snapshots.map(item => item.jobs[0]?.id).filter(Boolean).sort(), ['first','second']);
  assert.deepEqual(snapshots.map(item => item.facts?.state).filter(Boolean).sort(), ['CLOSED','OPEN']);
  await rm(dir, { recursive: true, force: true });
});

test('RelayStore inbound snapshots merge new remote records without regressing newer local execution', async () => {
  const tmp = await tempDb();
  const relay = new SQLiteRelayStore(tmp.path);
  const localTask = { ...makeTask('RUNNING'), id: 'existing', executionId: 'exec-1', updatedAt: '2026-09-30T00:02:00.000Z' };
  const localJob = { ...makeJob(), state: 'ACTIVE', updatedAt: '2026-09-30T00:02:00.000Z', tasks: [localTask] };
  await relay.saveJob(localJob);

  const remoteExisting = { ...localTask, state: 'QUEUED', executionId: null, updatedAt: '2026-09-30T00:01:00.000Z' };
  const remoteNew = { ...makeTask('QUEUED'), id: 'external-new', updatedAt: '2026-09-30T00:03:00.000Z' };
  const remoteJob = { ...localJob, state: 'DRAFT', updatedAt: '2026-09-30T00:01:00.000Z', tasks: [remoteExisting, remoteNew] };
  const projected = new ProjectedDurableStore(relay, new InMemoryStore(remoteJob));
  await projected.hydrate(remoteJob);
  let merged = await relay.loadJob('job-1');
  assert.equal(merged.state, 'ACTIVE');
  assert.equal(merged.tasks.find(task => task.id === 'existing').state, 'RUNNING');
  assert.equal(merged.tasks.find(task => task.id === 'existing').executionId, 'exec-1');
  assert.equal(merged.tasks.find(task => task.id === 'external-new').state, 'QUEUED');

  const remoteTerminal = { ...remoteExisting, state: 'SUCCEEDED', result: { summary: 'external terminal evidence' }, updatedAt: '2026-09-30T00:04:00.000Z' };
  await projected.hydrate({ ...remoteJob, tasks: [remoteTerminal, remoteNew] });
  merged = await relay.loadJob('job-1');
  assert.equal(merged.tasks.find(task => task.id === 'existing').state, 'SUCCEEDED');
  assert.equal(merged.tasks.find(task => task.id === 'existing').result.summary, 'external terminal evidence');
  await tmp.close(relay);
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
  assert.deepEqual(await local.listAgents(), []);
  remote.listAgents = async () => { throw new Error('GitHub agent registry read should not run'); };
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
  assert.deepEqual(await restartedLocal.listAgents(), []);
  await tmp.close(restarted);
});

test('SQLiteRelayStore atomically persists agent registry updates with their projection', async () => {
  const tmp = await tempDb();
  const store = new SQLiteRelayStore(tmp.path);
  const agent = makeAgent();
  await assert.rejects(() => store.saveAgentWithProjection(agent, {
    idempotencyKey: 'bad-agent', operation: 'save_agent', payload: { value: BigInt(1) }
  }));
  assert.equal(await store.loadAgents(), null);
  assert.equal(await store.pendingProjectionCount(), 0);

  await store.saveAgentWithProjection(agent, {
    idempotencyKey: 'save_agent:agent-1', operation: 'save_agent', payload: { operation: 'save_agent', value: agent }
  });
  assert.deepEqual((await store.loadAgents()).map(item => item.id), ['agent-1']);
  assert.equal(await store.pendingProjectionCount(), 1);
  store.close();

  const restarted = new SQLiteRelayStore(tmp.path);
  assert.deepEqual((await restarted.loadAgents()).map(item => item.id), ['agent-1']);
  await tmp.close(restarted);
});

test('ProjectedDurableStore preserves a complete agent baseline before first saveAgent', async () => {
  const tmp = await tempDb();
  const relay = new SQLiteRelayStore(tmp.path);
  const remote = new InMemoryStore(makeJob());
  const existing = { ...makeAgent(), id: 'existing-agent', name: 'Existing' };
  await remote.saveAgent(existing);
  const local = new ProjectedDurableStore(relay, remote);

  const added = { ...makeAgent(), id: 'new-agent', name: 'New' };
  await local.saveAgent(added);
  assert.deepEqual((await local.listAgents()).map(agent => agent.id).sort(), ['existing-agent', 'new-agent']);

  remote.listAgents = async () => { throw new Error('GitHub registry read must not run after baseline'); };
  const offlineAdded = { ...makeAgent(), id: 'offline-agent', name: 'Offline' };
  await local.saveAgent(offlineAdded);
  assert.deepEqual((await local.listAgents()).map(agent => agent.id).sort(), ['existing-agent', 'new-agent', 'offline-agent']);
  await tmp.close(relay);
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


test('ProjectedDurableStore queues merge and close as durable GitHub projections', async () => {
  const tmp = await tempDb();
  const relay = new SQLiteRelayStore(tmp.path);
  const remote = new InMemoryStore(makeJob());
  let merges = 0;
  let closes = 0;
  remote.mergePullRequest = async expectedHeadSha => {
    merges += 1;
    assert.equal(expectedHeadSha, 'merge-sha');
  };
  remote.closePullRequest = async () => { closes += 1; };
  const local = new ProjectedDurableStore(relay, remote);

  await local.mergePullRequest('merge-sha');
  await local.closePullRequest();
  assert.equal(merges, 0);
  assert.equal(closes, 0);
  assert.equal(await relay.pendingProjectionCount(), 2);

  assert.deepEqual(await local.projection.flushOnce(), { projected: 2, deferred: 0 });
  assert.equal(merges, 1);
  assert.equal(closes, 1);
  assert.equal(await relay.pendingProjectionCount(), 0);
  await tmp.close(relay);
});

test('ProjectedDurableStore resolves blocker domain mutations locally without direct GitHub blocker writes', async () => {
  const rootTmp = await tempDb();
  const dependentTmp = await tempDb();
  const blockerRelay = new SQLiteRelayStore(rootTmp.path);
  const dependentRelay = new SQLiteRelayStore(dependentTmp.path);

  const blockerJob = { ...makeJob(), id: 'blocker-job', repository: 'owner/blocker', prNumber: 10, tasks: [] };
  const dependentTask = { ...makeTask('DRAFT'), jobId: 'dependent-job', id: 'dependent-task' };
  const dependentJob = { ...makeJob(), id: 'dependent-job', repository: 'owner/dependent', prNumber: 20, tasks: [dependentTask] };
  const blockerRemote = new InMemoryStore(blockerJob);
  const dependentRemote = new InMemoryStore(dependentJob);
  blockerRemote.registerBlockerDependent = async () => { throw new Error('direct GitHub blocker registration must not run'); };
  blockerRemote.resolveBlockerDependents = async () => { throw new Error('direct GitHub blocker resolution must not run'); };

  let blockerLocal;
  let dependentLocal;
  const relatedStore = (repository, prNumber) => {
    if (repository === 'owner/dependent' && prNumber === 20) return dependentLocal;
    if (repository === 'owner/blocker' && prNumber === 10) return blockerLocal;
    throw new Error(`unexpected related store ${repository}#${prNumber}`);
  };
  blockerLocal = new ProjectedDurableStore(blockerRelay, blockerRemote, null, relatedStore);
  dependentLocal = new ProjectedDurableStore(dependentRelay, dependentRemote, null, relatedStore);
  await blockerLocal.hydrate(blockerJob);
  await dependentLocal.hydrate(dependentJob);

  await blockerLocal.registerBlockerDependent('blocker-job', {
    repository: 'owner/dependent',
    prNumber: 20,
    jobId: 'dependent-job',
    taskId: 'dependent-task',
    resolutionMode: 'merge',
  });
  const registered = await blockerLocal.load('blocker-job');
  assert.equal(registered.unblocks.length, 1);
  assert.equal((await dependentLocal.load('dependent-job')).tasks[0].blockedBy.jobId, 'blocker-job');

  const resolved = await blockerLocal.resolveBlockerDependents('blocker-job', 'merge');
  assert.equal(resolved.resumed, 1);
  assert.equal(resolved.waiting, 0);
  assert.equal((await dependentLocal.load('dependent-job')).tasks[0].state, 'QUEUED');
  assert.equal((await blockerLocal.load('blocker-job')).unblocks, undefined);
  assert.ok(await blockerRelay.pendingProjectionCount() > 0);
  assert.ok(await dependentRelay.pendingProjectionCount() > 0);

  await rootTmp.close(blockerRelay);
  await dependentTmp.close(dependentRelay);
});

test('GitHubProjectionWriter classifies a deterministic append_task conflict once with diagnostic evidence', async () => {
  const tmp = await tempDb();
  let relay = new SQLiteRelayStore(tmp.path);
  const remoteTask = { ...makeTask('SUCCEEDED'), result: { summary: 'remote' }, updatedAt: '2026-09-30T00:02:00.000Z' };
  const remote = new InMemoryStore({ ...makeJob(), tasks: [remoteTask] });
  const localTask = { ...makeTask('QUEUED'), input: 'different definition', updatedAt: '2026-09-30T00:03:00.000Z' };
  const observations = [];
  await relay.enqueueProjection({
    idempotencyKey: 'append_task:job-1:task-1',
    operation: 'append_task',
    payload: { operation: 'append_task', value: localTask },
  });
  const writer = new GitHubProjectionWriter(relay, remote, event => observations.push(event));
  assert.deepEqual(await writer.flushOnce(), { projected: 0, deferred: 0 });
  assert.equal(await relay.pendingProjectionCount(), 0);
  assert.equal(await relay.terminalProjectionCount(), 0);
  assert.equal(await relay.conflictProjectionCount(), 1);
  assert.deepEqual(await relay.claimDueProjections(), []);

  const [conflict] = await relay.listProjectionConflicts();
  assert.equal(conflict.status, 'conflict');
  assert.equal(conflict.operation, 'append_task');
  assert.equal(conflict.operationKey, 'append_task:job-1:task-1');
  assert.equal(conflict.diagnostic.kind, 'task');
  assert.equal(conflict.diagnostic.jobId, 'job-1');
  assert.equal(conflict.diagnostic.subjectId, 'task-1');
  assert.ok(conflict.diagnostic.divergingFields.includes('input'));
  assert.equal(conflict.diagnostic.localDefinition.input, 'different definition');
  assert.equal(conflict.diagnostic.remoteDefinition.id, 'task-1');
  assert.equal(conflict.resolution, null);

  assert.equal(observations.length, 1);
  assert.equal(observations[0].type, 'projection.conflict');
  assert.equal(observations[0].data.subjectId, 'task-1');

  // Restart/recovery: the classified conflict and its diagnostic survive daemon death.
  relay.close();
  relay = new SQLiteRelayStore(tmp.path);
  assert.equal(await relay.pendingProjectionCount(), 0);
  assert.equal(await relay.conflictProjectionCount(), 1);
  assert.deepEqual(await relay.claimDueProjections(), []);
  const [restarted] = await relay.listProjectionConflicts();
  assert.equal(restarted.diagnostic.divergingFields.includes('input'), true);
  assert.equal(restarted.attempts, 1);

  await tmp.close(relay);
});

test('a classified conflict does not consume retry budget for the blocked definition', async () => {
  const tmp = await tempDb();
  const relay = new SQLiteRelayStore(tmp.path);
  const remoteTask = { ...makeTask('SUCCEEDED'), result: { summary: 'remote' } };
  const remote = new InMemoryStore({ ...makeJob(), tasks: [remoteTask] });
  const localTask = { ...makeTask('QUEUED'), input: 'different definition' };
  await relay.enqueueProjection({
    idempotencyKey: 'append_task:job-1:task-1',
    operation: 'append_task',
    payload: { operation: 'append_task', value: localTask },
  });
  const writer = new GitHubProjectionWriter(relay, remote);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.deepEqual(await writer.flushOnce(), { projected: 0, deferred: 0 });
  }
  const [conflict] = await relay.listProjectionConflicts();
  assert.equal(conflict.attempts, 1);
  assert.equal(await relay.conflictProjectionCount(), 1);
  await tmp.close(relay);
});

test('append_plan definition conflicts are classified with plan identity, not silently overwritten', async () => {
  const tmp = await tempDb();
  const relay = new SQLiteRelayStore(tmp.path);
  const remotePlan = { jobId: 'job-1', id: 'plan-1', round: 1, source: 'manual', previousPlanId: null, trigger: { source: 'manual' }, status: 'SUCCEEDED', assessment: 'remote', generatedTaskIds: [], createdAt: '2026-09-30T00:00:00.000Z', updatedAt: '2026-09-30T00:00:00.000Z' };
  const job = { ...makeJob(), plans: [remotePlan] };
  const remote = new InMemoryStore(job);
  const localPlan = { ...remotePlan, assessment: 'local divergence', updatedAt: '2026-09-30T00:01:00.000Z' };
  await relay.enqueueProjection({
    idempotencyKey: 'append_plan:job-1:plan-1',
    operation: 'append_plan',
    payload: { operation: 'append_plan', value: localPlan },
  });
  const writer = new GitHubProjectionWriter(relay, remote);
  assert.deepEqual(await writer.flushOnce(), { projected: 0, deferred: 0 });
  assert.equal(await relay.pendingProjectionCount(), 0);
  assert.equal(await relay.conflictProjectionCount(), 1);
  const [conflict] = await relay.listProjectionConflicts();
  assert.equal(conflict.diagnostic.kind, 'plan');
  assert.equal(conflict.diagnostic.subjectId, 'plan-1');
  assert.ok(conflict.diagnostic.divergingFields.includes('assessment'));
  // GitHub still owns the original definition: nothing was overwritten.
  assert.equal((await remote.load('job-1')).plans[0].assessment, 'remote');
  await tmp.close(relay);
});

test('identical duplicate append remains idempotent and never conflicts', async () => {
  const tmp = await tempDb();
  const relay = new SQLiteRelayStore(tmp.path);
  const task = makeTask('SUCCEEDED');
  const remote = new InMemoryStore({ ...makeJob(), tasks: [task] });
  await relay.enqueueProjection({
    idempotencyKey: 'append_task:job-1:task-1',
    operation: 'append_task',
    payload: { operation: 'append_task', value: task },
  });
  const writer = new GitHubProjectionWriter(relay, remote);
  assert.deepEqual(await writer.flushOnce(), { projected: 1, deferred: 0 });
  assert.equal(await relay.conflictProjectionCount(), 0);
  assert.equal(await relay.pendingProjectionCount(), 0);
  await tmp.close(relay);
});

test('explicit repair requeues or discards a classified conflict without overwriting either side', async () => {
  const tmp = await tempDb();
  const relay = new SQLiteRelayStore(tmp.path);
  const remoteTask = { ...makeTask('SUCCEEDED'), result: { summary: 'remote' } };
  const remote = new InMemoryStore({ ...makeJob(), tasks: [remoteTask] });
  const localTask = { ...makeTask('QUEUED'), input: 'different definition' };
  await relay.enqueueProjection({
    idempotencyKey: 'append_task:job-1:task-1',
    operation: 'append_task',
    payload: { operation: 'append_task', value: localTask },
  });
  const writer = new GitHubProjectionWriter(relay, remote);
  assert.deepEqual(await writer.flushOnce(), { projected: 0, deferred: 0 });
  const [conflict] = await relay.listProjectionConflicts();

  // requeue re-arms the original projection for an explicit retry after reconciliation.
  assert.equal(await relay.resolveProjectionConflict(conflict.id, { action: 'requeue', note: 'github reconciled' }), true);
  assert.equal(await relay.conflictProjectionCount(), 0);
  assert.equal(await relay.pendingProjectionCount(), 1);
  assert.deepEqual((await relay.listProjectionConflicts()), []);

  const [requeued] = await relay.claimDueProjections();
  await relay.recordProjectionConflict(requeued.id, { ...conflict.diagnostic, detectedAt: new Date().toISOString() });
  assert.equal(await relay.conflictProjectionCount(), 1);

  // discard_local removes the blocked local mutation so a fresh one can be enqueued.
  const [again] = await relay.listProjectionConflicts();
  assert.equal(await relay.resolveProjectionConflict(again.id, { action: 'discard_local' }), true);
  assert.equal(await relay.conflictProjectionCount(), 0);
  assert.equal(await relay.pendingProjectionCount(), 0);
  assert.equal(await relay.resolveProjectionConflict(9999, { action: 'requeue' }), false);
  await tmp.close(relay);
});

test('classified conflict and diagnostic remain durable across restart', async () => {
  const tmp = await tempDb();
  let relay = new SQLiteRelayStore(tmp.path);
  const remoteTask = { ...makeTask('SUCCEEDED') };
  const remote = new InMemoryStore({ ...makeJob(), tasks: [remoteTask] });
  const localTask = { ...makeTask('QUEUED'), input: 'different definition' };
  await relay.enqueueProjection({
    idempotencyKey: 'append_task:job-1:task-1',
    operation: 'append_task',
    payload: { operation: 'append_task', value: localTask },
  });
  assert.deepEqual(await new GitHubProjectionWriter(relay, remote).flushOnce(), { projected: 0, deferred: 0 });
  const [classified] = await relay.listProjectionConflicts();
  assert.equal(classified.status, 'conflict');
  relay.close();

  // Re-open: the classification and diagnostic remain durable across restart.
  relay = new SQLiteRelayStore(tmp.path);
  const [reopened] = await relay.listProjectionConflicts();
  assert.equal(reopened.diagnostic.subjectId, 'task-1');
  assert.equal(reopened.attempts, 1);
  assert.equal(await relay.pendingProjectionCount(), 0);
  assert.deepEqual(await relay.claimDueProjections(), []);
  await tmp.close(relay);
});

test('v4 schema with dead deterministic conflicts migrates to classified conflict state', async () => {
  const tmp = await tempDb();
  // Build a genuine pre-v5 outbox: old status CHECK, no operation_key, one dead conflict row.
  const legacy = new DatabaseSync(tmp.path);
  try {
    legacy.exec(`
      CREATE TABLE relay_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE projection_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT NOT NULL UNIQUE,
        coalesce_key TEXT,
        operation TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','dead')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO relay_meta(key,value) VALUES('schema_version','4');
      INSERT INTO projection_outbox(idempotency_key,coalesce_key,operation,payload_json,priority,status,attempts,next_attempt_at,last_error,created_at,updated_at)
      VALUES('append_task:job-1:task-1',NULL,'append_task','{"operation":"append_task","value":{"id":"task-1"}}',40,'dead',31,NULL,'Task task-1 already exists with a different definition','2026-09-29T00:00:00.000Z','2026-09-29T00:00:00.000Z');
      INSERT INTO projection_outbox(idempotency_key,coalesce_key,operation,payload_json,priority,status,attempts,next_attempt_at,last_error,created_at,updated_at)
      VALUES('save_job:job-1','job:job-1','save_job','{"operation":"save_job","value":{"id":"job-1"}}',20,'pending',0,NULL,NULL,'2026-09-29T00:00:00.000Z','2026-09-29T00:00:00.000Z');
    `);
  } finally {
    legacy.close();
  }

  const relay = new SQLiteRelayStore(tmp.path);
  const conflicts = await relay.listProjectionConflicts();
  assert.equal(conflicts.length, 1);
  const [migrated] = conflicts;
  assert.equal(migrated.status, 'conflict');
  assert.equal(migrated.operationKey, 'append_task:job-1:task-1');
  assert.match(migrated.diagnostic.message, /different definition/);
  assert.equal(migrated.diagnostic.kind, 'task');
  // The unrelated pending projection is preserved, not misclassified.
  assert.equal(await relay.pendingProjectionCount(), 1);
  const [due] = await relay.claimDueProjections();
  assert.equal(due.operation, 'save_job');
  assert.equal(due.operationKey, 'save_job:job-1');
  await tmp.close(relay);
});

test('projection terminal classifier is narrow and leaves transient writes retryable', () => {
  assert.equal(isTerminalProjectionFailure({ operation: 'append_task' }, new Error('Task task-1 already exists with a different definition')), true);
  assert.equal(isTerminalProjectionFailure({ operation: 'append_plan' }, new Error('Plan plan-1 already exists with a different definition')), true);
  assert.equal(isTerminalProjectionFailure({ operation: 'save_task' }, new Error('Task task-1 already exists with a different definition')), false);
  assert.equal(isTerminalProjectionFailure({ operation: 'append_task' }, new Error('secondary rate limit')), false);
  assert.equal(isTerminalProjectionFailure({ operation: 'append_task' }, new DurableDefinitionConflictError('task', 'append_task', 'job-1', 'task-1', { input: 'a' }, { input: 'b' }, ['input'])), true);
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

test('expired processing outbox leases are reclaimed on ordinary retry ticks after restart', async () => {
  const path=join(await mkdtemp(join(tmpdir(),'relay-stale-external-')),'state.db');
  let store=new SQLiteRelayStore(path);
  const firstAt=new Date();
  try {
    await store.enqueueProjection({idempotencyKey:'recover-remote-merge',operation:'merge_pull_request',
      payload:{operation:'merge_pull_request',expectedHeadSha:'test-sha'}});
    const first=await store.claimDueProjections(5,firstAt);
    assert.equal(first.length,1);
    store.close();
    store=new SQLiteRelayStore(path);
    assert.equal((await store.claimDueProjections(5,new Date(firstAt.getTime()+60_000))).length,0);
    const recovered=await store.claimDueProjections(5,new Date(firstAt.getTime()+121_000));
    assert.equal(recovered.length,1);
    assert.equal(recovered[0].id,first[0].id);
    await store.completeProjection(recovered[0].id);
    assert.equal(await store.pendingProjectionCount(),0);
  } finally {
    store.close();
    await rm(join(path,'..'),{recursive:true,force:true});
  }
});

test('UNKNOWN is represented by missing evidence and confirmed PR facts advance normally', async () => {
  const store=new SQLiteRelayStore(':memory:');
  const t0='2026-10-09T01:00:00.000Z', t1='2026-10-09T01:01:00.000Z', t2='2026-10-09T01:02:00.000Z';
  await store.savePullRequestFacts({state:'UNKNOWN',head:null,observedAt:t0});
  assert.equal(await store.loadPullRequestFacts(),null);
  await store.savePullRequestFacts({state:'OPEN',head:{ref:'feature',sha:'abc'},observedAt:t1});
  assert.equal((await store.loadPullRequestFacts()).state,'OPEN');
  await store.savePullRequestFacts({state:'MERGED',head:{ref:'feature',sha:'abc'},observedAt:t2});
  assert.equal((await store.loadPullRequestFacts()).state,'MERGED');
  store.close();
});

test('publication success and failure survive restart and webhook replay remains idempotent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-publication-'));
  const path = join(dir, 'store.db');
  let sqlite = new SQLiteRelayStore(path);
  try {
    const published = { package: 'agents-relay', version: '2.0.1', registry: 'https://registry.npmjs.org', sha: 'abc123' };
    assert.equal(await sqlite.recordPublication('job-a', 'delivery-1', published, null), true);
    assert.equal(await sqlite.recordPublication('job-a', 'delivery-1', published, null), false);
    const failed = { runId: '123', attempt: 1, sha: 'abc123', stage: 'npm-publish' };
    assert.equal(await sqlite.recordPublication('job-a', 'delivery-2', null, failed), true);
    assert.equal((await sqlite.loadPublication('job-a')).latest.version, '2.0.1');
    assert.equal((await sqlite.loadPublication('job-a')).failure.stage, 'npm-publish');
    assert.equal(await sqlite.loadPublication('job-b'), null);
    sqlite.close();
    sqlite = new SQLiteRelayStore(path);
    assert.equal((await sqlite.loadPublication('job-a')).latest.version, '2.0.1');
    assert.equal((await sqlite.loadPublication('job-a')).failure.runId, '123');
    await sqlite.recordPublication('job-a', 'delivery-3', { ...published, version: '2.0.2' }, null);
    assert.equal((await sqlite.loadPublication('job-a')).failure, null);
    assert.equal((await sqlite.loadPublication('job-a')).latest.version, '2.0.2');
    const { discoverLocalRelayStoreSnapshots } = await import('../dist/relay-store.js');
    const snapshots = await discoverLocalRelayStoreSnapshots(dir);
    assert.equal(snapshots[0].publications['job-a'].latest.version, '2.0.2');
  } finally { sqlite.close(); await rm(dir, { recursive: true, force: true }); }
});

test('one GitHub delivery records a publish event for each local Job and stale webhooks cannot regress status', async () => {
  const sqlite = new SQLiteRelayStore(':memory:');
  try {
    const one = { package: 'agents-relay', version: '2.1.0', registry: null, sha: 'abcd123' };
    const old = { package: 'agents-relay', version: '2.0.9', registry: null, sha: 'aaaa123' };
    const latest = '2026-10-08T21:00:00.000Z';
    const earlier = '2026-10-08T20:00:00.000Z';
    assert.equal(await sqlite.recordPublication('job-1', 'delivery-a', one, null, latest), true);
    assert.equal(await sqlite.recordPublication('job-2', 'delivery-a', one, null, latest), true);
    assert.equal(await sqlite.recordPublication('job-1', 'delivery-a', one, null, latest), false);
    await sqlite.recordPublication('job-1', 'delivery-old', old, null, earlier);
    assert.equal((await sqlite.loadPublication('job-1')).latest.version, '2.1.0');
    assert.equal((await sqlite.loadPublication('job-2')).latest.version, '2.1.0');
    const events = await sqlite.listPublicationEvents('job-1');
    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'package.published');
    assert.equal(events[0].payload.version, '2.0.9');
    assert.equal(events[1].payload.version, '2.1.0');
  } finally { sqlite.close(); }
});

test('read-only inventory discovers older SQLite schema without publication tables', async () => {
  const dir=await mkdtemp(join(tmpdir(),'relay-legacy-schema-inventory-'));
  const path=join(dir,'old.db');
  try {
    const db=new DatabaseSync(path);
    db.exec('CREATE TABLE job_snapshot (job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL)');
    db.exec('CREATE TABLE pull_request_facts (id INTEGER PRIMARY KEY,state TEXT,head_ref TEXT,head_sha TEXT,observed_at TEXT)');
    db.prepare('INSERT INTO job_snapshot VALUES (?,?,?)').run('legacy-active',JSON.stringify({...makeJob(),id:'legacy-active',state:'ACTIVE'}),now());
    db.close();
    const snapshots=await discoverLocalRelayStoreSnapshots(dir);
    assert.equal(snapshots.length,1);
    assert.equal(snapshots[0].jobs[0].id,'legacy-active');
    assert.deepEqual(snapshots[0].publications,{});
    const verify=new DatabaseSync(path,{readOnly:true});
    assert.equal(verify.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='publication_state'").get().n,0);
    verify.close();
  } finally {await rm(dir,{recursive:true,force:true});}
});
