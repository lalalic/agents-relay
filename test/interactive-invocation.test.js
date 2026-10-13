import test, { managedReconciler } from './test-runtime.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteRelayStore } from '../dist/relay-store.js';
import { InMemoryStore } from '../dist/store.js';
import { ProjectedDurableStore } from '../dist/projected-store.js';
import {
  interactiveDecisionFingerprint,
  normalizeInteractiveDecision,
} from '../dist/interactive-invocation.js';

const timestamp = () => new Date().toISOString();
const makeTask = () => ({
  jobId: 'job-interactive', id: 'task-interactive', parentTaskId: null, dependencies: [],
  capabilities: [], adapter: 'orchestrator', input: 'work', state: 'RUNNING',
  attempt: 1, maxAttempts: 3, leaseOwner: 'owner', leaseExpiresAt: timestamp(),
  executionId: 'exec-1', threadId: null, result: null, error: null,
  timeoutMs: 60_000, createdAt: timestamp(), updatedAt: timestamp(),
  continuation: null, continuationDeliveredAt: null,
});
const makeJob = (task = makeTask()) => ({
  id: task.jobId, title: 'Interactive contract', executionMode: 'fixed', prNumber: 0,
  repository: 'local/job', state: 'ACTIVE', continuation: null,
  createdAt: timestamp(), updatedAt: timestamp(), tasks: [task],
});
const decisionEvent = (jobId, taskId, invocationId, revision, decision, feedback) => ({
  version: 1,
  event_id: `${invocationId}-${revision}-${decision}`,
  job_id: jobId,
  task_id: taskId,
  parent_task_id: null,
  type: 'task.interactive_decision',
  status: decision === 'approved' ? 'succeeded' : 'failed',
  timestamp: new Date().toISOString(),
  visibility: 'user',
  level: decision === 'approved' ? 'info' : 'warning',
  message: `${decision} ${revision}`,
  source: { id: `job/${jobId}/task/${taskId}/execution/exec-1` },
  data: { interactive: { jobId, taskId, executionId: 'exec-1', invocationId, revision, decision, feedback } },
});

async function temporaryStore() {
  const dir = await mkdtemp(join(tmpdir(), 'agents-relay-interactive-'));
  const store = new SQLiteRelayStore(join(dir, 'relay.db'));
  return { store, dbPath: join(dir, 'relay.db'), dispose: async () => { store.close(); await rm(dir, { recursive: true, force: true }); } };
}

test('interactive invocation persists, deduplicates, rejects stale revisions, and continues worker', async () => {
  const fixture = await temporaryStore();
  const store = fixture.store;
  const task = makeTask();
  const job = makeJob(task);
  await store.saveJob(job);

  const reconciler = managedReconciler(new ProjectedDurableStore(store, new InMemoryStore(job)), { owner: 'test', adapters: [] });
  const fresh = await store.loadJob(job.id);
  const runningTask = fresh.tasks.find(item => item.id === task.id);
  const firstInvocation = await reconciler.bindInteractiveInvocation(job.id, runningTask, 'exec-1', 'inv-v1', 'v1');
  await reconciler.applyEvent(decisionEvent(job.id, task.id, 'inv-v1', 'v1', 'changes_requested', 'make the ending shorter'));
  assert.equal((await firstInvocation.decision).decision, 'changes_requested');
  assert.equal((await store.loadJob(job.id)).tasks[0].interactiveInvocation.status, 'changes_requested');

  const beforeApproval = await reconciler.applyEvent({ ...decisionEvent(job.id, task.id, 'inv-v1', 'v1', 'approved'), type: 'task.completed', event_id: 'premature-completion' });
  assert.equal(beforeApproval.applied, false);
  assert.equal((await store.loadJob(job.id)).tasks[0].state, 'RUNNING');

  const duplicateDelivery = decisionEvent(job.id, task.id, 'inv-v1', 'v1', 'changes_requested', 'make the ending shorter');
  const duplicate = await reconciler.applyEvent(duplicateDelivery);
  assert.match(duplicate.reason, /duplicate/);
  const sameSemanticNewId = await reconciler.applyEvent({ ...duplicateDelivery, event_id: 'redelivered-other-transport' });
  assert.match(sameSemanticNewId.reason, /duplicate/);

  const staleDelivery = decisionEvent(job.id, task.id, 'inv-v1', 'v1', 'approved', 'late approval');
  const incompatible = await reconciler.applyEvent(staleDelivery);
  assert.match(incompatible.reason, /stale/);
  assert.equal((await store.loadJob(job.id)).tasks[0].state, 'RUNNING');

  const secondJob = await store.loadJob(job.id);
  const secondTask = secondJob.tasks.find(item => item.id === task.id);
  const secondInvocation = await reconciler.bindInteractiveInvocation(job.id, secondTask, 'exec-1', 'inv-v2', 'v2');
  await reconciler.applyEvent(decisionEvent(job.id, task.id, 'inv-v2', 'v2', 'changes_requested', 'adjust the audio mix'));
  assert.equal((await secondInvocation.decision).revision, 'v2');

  const thirdJob = await store.loadJob(job.id);
  const thirdTask = thirdJob.tasks.find(item => item.id === task.id);
  const thirdInvocation = await reconciler.bindInteractiveInvocation(job.id, thirdTask, 'exec-1', 'inv-v3', 'v3');
  await reconciler.applyEvent(decisionEvent(job.id, task.id, 'inv-v3', 'v3', 'approved', 'ship this revision'));
  const workerDecision = await thirdInvocation.decision;
  assert.equal(workerDecision.revision, 'v3');
  await reconciler.applyEvent({
    ...decisionEvent(job.id, task.id, 'inv-v3', 'v3', 'approved'),
    event_id: `complete-${workerDecision.invocationId}`,
    type: 'task.completed',
    status: 'succeeded',
    message: 'Worker continued after latest approval',
    data: { interactiveRevision: workerDecision.revision },
  });

  const latestJob = await store.loadJob(job.id);
  assert.equal(latestJob.tasks[0].state, 'SUCCEEDED');
  assert.equal(latestJob.tasks[0].result.data.interactiveRevision, 'v3');
  const lateV1 = await reconciler.applyEvent({
    ...staleDelivery,
    event_id: 'late-v1-approval',
    timestamp: new Date().toISOString(),
  });
  assert.equal(lateV1.applied, true);
  assert.match(lateV1.reason, /stale$/);
  const sql = new DatabaseSync(fixture.dbPath);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM host_invocation_decision').get().n, 3);
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM host_invocation_event WHERE outcome='accepted'").get().n, 3);
  assert.ok(sql.prepare("SELECT feedback FROM host_invocation_decision WHERE revision='v2'").get().feedback.includes('audio'));
  sql.close();
  await reconciler.close();
  await fixture.dispose();
});

test('interactive decision events are normalized and fingerprints bind decision facts', () => {
  const event = decisionEvent('job', 'task', 'invocation', 'revision-1', 'approved', 'good');
  const delivery = normalizeInteractiveDecision(event);
  assert.ok(delivery);
  assert.equal(delivery.decision, 'approved');
  assert.equal(interactiveDecisionFingerprint(delivery), interactiveDecisionFingerprint({ ...delivery, eventId: 'different', deliveredAt: 'later' }));
  assert.notEqual(interactiveDecisionFingerprint(delivery), interactiveDecisionFingerprint({ ...delivery, feedback: 'different' }));
});

test('external decision releases a BLOCKED interactive Task and requeues the same Task', async () => {
  const fixture = await temporaryStore();
  const job = makeJob();
  await fixture.store.saveJob(job);
  const reconciler = managedReconciler(new ProjectedDurableStore(fixture.store, new InMemoryStore(job)), {
    owner: 'test-interactive', adapters: [],
  });
  const task = (await fixture.store.loadJob(job.id)).tasks[0];
  await reconciler.bindInteractiveInvocation(job.id, task, 'exec-1', 'inv-1', 'sha256:v1');
  const blocked = {
    ...decisionEvent(job.id, task.id, 'inv-1', 'sha256:v1', 'changes_requested'),
    event_id: 'worker-review-wait',
    type: 'task.blocked',
    status: 'blocked',
    message: 'External review required',
    data: {},
  };
  assert.equal((await reconciler.applyEvent(blocked)).applied, true);
  assert.equal((await fixture.store.loadJob(job.id)).tasks[0].state, 'BLOCKED');
  const result = await reconciler.applyEvent(decisionEvent(job.id, task.id, 'inv-1', 'sha256:v1', 'changes_requested', 'revise narration'));
  assert.equal(result.reconcile, true);
  assert.equal(result.reason, 'task.interactive_decision.accepted');
  const resumed = (await fixture.store.loadJob(job.id)).tasks[0];
  assert.equal(resumed.state, 'QUEUED');
  assert.equal(resumed.executionId, null);
  assert.equal(resumed.interactiveInvocation.status, 'changes_requested');
  assert.equal(resumed.interactiveInvocation.feedback, 'revise narration');
  assert.equal((await fixture.store.loadJob(job.id)).tasks.length, 1);
  assert.ok(resumed.maxAttempts > task.maxAttempts);
  assert.equal((await reconciler.applyEvent(decisionEvent(job.id, task.id, 'inv-1', 'sha256:v1', 'approved'))).reconcile, false);
  await fixture.dispose();
});

test('SQLite decision recovers after event delivery loss and concurrent decisions are serialized', async () => {
  const fixture = await temporaryStore();
  const job = makeJob();
  await fixture.store.saveJob(job);
  const reconciler = managedReconciler(new ProjectedDurableStore(fixture.store, new InMemoryStore(job)), {
    owner: 'test-interactive', adapters: [],
  });
  const task = (await fixture.store.loadJob(job.id)).tasks[0];
  await reconciler.bindInteractiveInvocation(job.id, task, 'exec-1', 'inv-restart', 'immutable-revision');
  await reconciler.applyEvent({
    ...decisionEvent(job.id, task.id, 'inv-restart', 'immutable-revision', 'approved'),
    type: 'task.blocked', status: 'blocked', message: 'Waiting for approval', data: {},
  });
  const chosenEvent = decisionEvent(job.id, task.id, 'inv-restart', 'immutable-revision', 'approved', 'ready');
  const chosen = normalizeInteractiveDecision(chosenEvent);
  assert.ok(chosen);
  const receipt = await fixture.store.recordHostInvocationDecision(chosen, interactiveDecisionFingerprint(chosen));
  assert.equal(receipt.outcome, 'accepted');
  const { recoverInteractiveDecisions } = await import('../dist/interactive-resume.js');
  assert.equal(await recoverInteractiveDecisions(new ProjectedDurableStore(fixture.store, new InMemoryStore(job)), job.id), true);
  assert.equal(await recoverInteractiveDecisions(new ProjectedDurableStore(fixture.store, new InMemoryStore(job)), job.id), false);
  assert.equal((await fixture.store.loadJob(job.id)).tasks[0].state, 'QUEUED');
  const sql = new DatabaseSync(fixture.dbPath);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM host_invocation_decision').get().n, 1);
  sql.close();
  await fixture.dispose();
});

test('generic host adapter adds Relay identity outside the UI decision payload', async () => {
  const { hostInteractiveDecisionEvent } = await import('../dist/interactive-invocation.js');
  const generic = { eventId: 'review-1', invocationId: 'inv-1', revision: 'hash-v1',
    decision: 'changes_requested', feedback: 'shorten credits' };
  assert.equal('jobId' in generic, false);
  assert.equal('taskId' in generic, false);
  const bound = hostInteractiveDecisionEvent({
    jobId: 'job', taskId: 'task', executionId: 'exec',
  }, generic);
  const normalized = normalizeInteractiveDecision(bound);
  assert.equal(normalized.jobId, 'job');
  assert.equal(normalized.taskId, 'task');
  assert.equal(normalized.feedback, 'shorten credits');
});
