import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteRelayStore, mergeInboundJobSnapshot } from '../dist/relay-store.js';
import {
  recordTargetedRevisionRequest, submitTargetedRevisionRequest, targetedRequestsForReview, targetedRequestsCoverReview, dependencyRevisionVector,
  sameDependencyRevisionVector, dependencyValidity,
} from '../dist/review-revision-model.js';
import { decideRevisionLifecycle } from '../dist/workflow/revision-v2.js';

const at = () => new Date().toISOString();
const work = (id, state = 'SUCCEEDED', dependencies = []) => ({
  jobId: 'j', id, kind: 'work', agentName: 'implementation', parentTaskId: null,
  dependencies, capabilities: [], adapter: 'codex', input: 'make code change',
  state, attempt: 1, maxAttempts: 3, leaseOwner: null, leaseExpiresAt: null,
  executionId: null, threadId: null, result: { summary: 'immutable original' },
  error: null, timeoutMs: 1000, createdAt: at(), updatedAt: at(),
});
const reviewer = () => ({
  ...work('review', 'RUNNING', ['owner']), agentName: 'reviewer',
  reviewHeadSha: 'head-1', executionId: 'review-exec-1', result: null,
});
const job = () => ({
  id: 'j', title: 'revision', prNumber: 0, repository: 'test/revision',
  state: 'ACTIVE', continuation: null, headSha: 'head-1',
  review: { outcome: 'started', headSha: 'head-1', taskId: 'review', evidence: null, updatedAt: at() },
  createdAt: at(), updatedAt: at(), tasks: [work('owner'), reviewer()],
});
const input = (overrides = {}) => ({
  requestId: 'req-1', reviewTaskId: 'review', reviewExecutionId: 'review-exec-1',
  headSha: 'head-1', originalTaskId: 'owner',
  findings: [{ id: 'F1', summary: 'Fix dependency fence' }], ...overrides,
});

test('canonical revision Graph authorizes intake only for current reviewer/head/owner and gates queue', () => {
  const facts = { reviewerAuthorized: true, reviewHeadCurrent: true, originalTaskSucceeded: true };
  const allow = decideRevisionLifecycle('NONE', 'revision.submit', facts);
  assert.equal(allow.target, 'REQUESTED');
  assert.deepEqual(allow.actions.map(a => a.id), ['revision.recordRequest']);
  for (const key of Object.keys(facts)) {
    const denied = decideRevisionLifecycle('NONE', 'revision.submit', { ...facts, [key]: false });
    assert.equal(denied.target, 'NONE', key);
    assert.deepEqual(denied.actions, [], key);
  }
  assert.equal(decideRevisionLifecycle('REQUESTED', 'revision.queue', {}).target, 'REQUESTED');
  const queued = decideRevisionLifecycle('REQUESTED', 'revision.queue', { changesRequiredRecorded: true });
  assert.equal(queued.target, 'QUEUED');
  assert.deepEqual(queued.actions.map(a => a.id), ['revision.queueTask']);
  assert.equal(decideRevisionLifecycle('QUEUED', 'revision.started').target, 'RUNNING');
  assert.equal(decideRevisionLifecycle('RUNNING', 'revision.verified').target, 'VERIFIED');
  assert.deepEqual(decideRevisionLifecycle('RUNNING', 'revision.failed').actions.map(a => a.id), ['revision.recordFailed']);
  assert.equal(decideRevisionLifecycle('QUEUED', 'review.head_changed').target, 'STALE');
  assert.equal(decideRevisionLifecycle('FAILED', 'review.head_changed').target, 'STALE');
  assert.equal(decideRevisionLifecycle('REQUESTED', 'revision.submit').target, 'REQUESTED');
});

test('review request records append-only original Task comment without changing result; retries dedupe', () => {
  const j = job(), original = structuredClone(j.tasks[0]);
  const first = recordTargetedRevisionRequest(j, input());
  assert.equal(first.created, true);
  assert.equal(first.request.status, 'requested');
  assert.equal(first.request.feedbackOrigin, 'final-review');
  assert.deepEqual(j.tasks[0].result, original.result);
  assert.equal(j.tasks[0].state, 'SUCCEEDED');
  assert.equal(j.tasks.length, 3, 'identified feedback creates exactly one separate revision Task');
  assert.equal(j.tasks[2].state, 'DRAFT', 'must not dispatch before changes-required verdict');
  assert.equal(j.tasks[2].parentTaskId, 'owner');
  assert.equal(j.tasks[2].revision.kind, 'targeted');
  assert.equal(j.tasks[2].revision.originalTaskId, 'owner');
  assert.equal(j.tasks[2].comments[0].kind, 'review.feedback');
  assert.equal(j.tasks[0].comments.length, 1);
  assert.equal(j.tasks[0].comments[0].kind, 'review.feedback');
  assert.deepEqual(targetedRequestsForReview(j, j.tasks[1], 'head-1').map(r => r.requestId), ['req-1']);
  assert.equal(targetedRequestsCoverReview(j, j.tasks[1], 'head-1', ['Fix dependency fence']),true);
  assert.equal(targetedRequestsCoverReview(j, j.tasks[1], 'head-1', ['Fix dependency fence','unowned finding']),false);
  assert.equal(targetedRequestsCoverReview(j, j.tasks[1], 'head-1', ['[unparseable blocking finding]']),false);
  assert.equal(targetedRequestsCoverReview(j, j.tasks[1], 'head-1', []),false);
  assert.equal(targetedRequestsCoverReview(j, j.tasks[1], 'head-1', ['F1']),true);
  assert.equal(recordTargetedRevisionRequest(j, input()).created, false);
  assert.equal(j.tasks[0].comments.length, 1);
  assert.throws(() => recordTargetedRevisionRequest(j, input({ findings: [{ id: 'F1', summary: 'Different payload' }] })), /reused/);
  recordTargetedRevisionRequest(j, input({ requestId: 'req-2', findings: [{ id: 'F2', summary: 'Second finding, same owner' }] }));
  assert.deepEqual(j.reviewRevisionRequests.map(r => r.requestId), ['req-1', 'req-2']);
  assert.equal(j.tasks[0].comments.length, 2);
  assert.equal(j.tasks.length, 3, 'same owner and Review round reuses semantic child');
  assert.deepEqual(j.tasks[2].revision.requestIds, ['req-1','req-2']);
});

test('targeted revision intake rejects stale head, stale execution, unowned and duplicate/empty findings', () => {
  for (const changed of [
    { headSha: 'head-old' }, { reviewExecutionId: 'prior-generation' },
    { originalTaskId: 'no-owner' }, { findings: [] },
    { findings: [{ id: 'a', summary: 'a' }, { id: 'a', summary: 'b' }] },
  ]) assert.throws(() => recordTargetedRevisionRequest(job(), input(changed)));
  const stopped = job();
  stopped.tasks[1].state = 'SUCCEEDED';
  assert.throws(() => recordTargetedRevisionRequest(stopped, input()));
  const failed = job();
  failed.tasks[0].state = 'FAILED';
  assert.throws(() => recordTargetedRevisionRequest(failed, input()));
  const headed = job();
  headed.headSha = 'head-new';
  assert.throws(() => recordTargetedRevisionRequest(headed, input()));
});

test('SQLite BEGIN IMMEDIATE snapshots persist deduped feedback across restart and rollback conflicts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-review-revision-'));
  const path = join(dir, 'isolated.db');
  let store;
  try {
    store = new SQLiteRelayStore(path);
    await store.saveJob(job());
    const submit = value => submitTargetedRevisionRequest(store, 'j', value);
    const [first, duplicate] = await Promise.all([submit(input()), submit(input())]);
    assert.equal(first.created, true);
    assert.equal(duplicate.created, false);
    await assert.rejects(submit(input({ findings: [{ id: 'F1', summary: 'collision' }] })), /reused/);
    const round = { reviewTaskId:'review',reviewExecutionId:'review-exec-1',headSha:'head-1',
      requestIds:['req-1'],status:'changes_required',recordedAt:at() };
    await store.mutateJob('j', current => {
      current.reviewRevisionRounds = [...(current.reviewRevisionRounds ?? []),round];
      return current;
    });
    let saved = await store.loadJob('j');
    assert.equal(saved.reviewRevisionRequests.length, 1);
    assert.equal(saved.tasks[0].comments.length, 1);
    store.close(); store = null;
    store = new SQLiteRelayStore(path);
    saved = await store.loadJob('j');
    assert.equal(saved.reviewRevisionRequests[0].reviewExecutionId, 'review-exec-1');
    assert.deepEqual(saved.reviewRevisionRounds, [round], 'round lineage survives process restart');
    assert.equal(saved.tasks[0].state, 'SUCCEEDED');
    assert.equal(saved.tasks[0].result.summary, 'immutable original');
    const remote = { ...saved, reviewRevisionRequests: undefined, reviewRevisionRounds: undefined,
      updatedAt: new Date(Date.now() + 60000).toISOString() };
    const merged = mergeInboundJobSnapshot(saved, remote);
    assert.equal(merged.reviewRevisionRequests.length, 1, 'remote projection cannot erase SQLite review feedback');
    const forgedRemote = { ...remote,
      reviewRevisionRequests: [{...saved.reviewRevisionRequests[0],requestId:'forged-remote'}],
      reviewRevisionRounds:[{reviewTaskId:'unknown',reviewExecutionId:'fake',headSha:'wrong',requestIds:[],status:'approved',recordedAt:at()}] };
    const protectedJob = mergeInboundJobSnapshot(saved, forgedRemote);
    assert.deepEqual(protectedJob.reviewRevisionRequests, saved.reviewRevisionRequests, 'remote cannot inject authority');
    assert.deepEqual(protectedJob.reviewRevisionRounds, [round], 'remote cannot forge a newer approval over persisted round');

  } finally {
    store?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('transactional API refuses non-atomic stores before changing requests', async () => {
  await assert.rejects(submitTargetedRevisionRequest({}, 'j', input()), /authoritative atomic/);
});

test('dependency policy defaults to order-only; semantic fan-in vectors change only for explicit modes', () => {
  const j = job();
  const a = j.tasks[0];
  const b = work('B');
  const c = work('C');
  const d = work('D', 'SUCCEEDED', ['owner','B','C']);
  d.dependencyValidity = { owner: 'revalidate', B: 'rerun', C: 'order-only' };
  j.tasks.push(b,c,d);
  assert.equal(dependencyValidity(d,'C'),'order-only');
  assert.deepEqual(dependencyRevisionVector(j, d), { B: 'B:1', owner: 'owner:1' });
  const revisedA = { ...work('owner-revision'), revision: { kind: 'targeted', originalTaskId: a.id, requestIds: ['req-1'], reviewTaskId: 'review', basedOnHeadSha: 'head-1' } };
  j.tasks.push(revisedA);
  const afterA = dependencyRevisionVector(j, d);
  assert.deepEqual(afterA, { B: 'B:1', owner: 'owner-revision:1' });
  assert.equal(sameDependencyRevisionVector(afterA, { owner: 'owner-revision:1', B: 'B:1' }), true);
  assert.equal(sameDependencyRevisionVector(afterA, { owner: 'owner:1', B: 'B:1' }), false);
  const revision2 = { ...work('owner-revision-2'),
    createdAt: new Date(Date.now() + 60000).toISOString(),
    revision: { kind: 'targeted', originalTaskId: a.id, requestIds: ['req-2'], reviewTaskId: 'review', basedOnHeadSha: 'head-2' } };
  j.tasks.unshift(revision2);
  assert.deepEqual(dependencyRevisionVector(j, d), { B: 'B:1', owner: 'owner-revision-2:1' },
    'source-array order must not override newer durable provenance');

  j.tasks.push({ ...work('B-revision','FAILED'), revision: { kind: 'rerun', originalTaskId: 'B', requestIds: [], reviewTaskId: 'review', basedOnHeadSha: 'head-1' } });
  assert.equal(dependencyRevisionVector(j,d).owner, 'owner-revision-2:1', 'failed evidence cannot advance a vector');
  const legacy = work('legacy','SUCCEEDED',['owner']);
  assert.deepEqual(dependencyRevisionVector(j,legacy), {}, 'legacy dependencies are execution order only');
  assert.throws(() => dependencyValidity(legacy, 'missing'), /not declared/);
});
