import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  RelayObservability,
  classifyFailure,
  collectObservations,
  currentObservabilityCorrelation,
  sanitizeObservationData,
  setObservability,
  withObservabilityCorrelation,
} from '../dist/observability.js';
import { decideTaskLifecycle } from '../dist/workflow/lifecycle.js';
import { dispatchWorkflowGraph, dispatchWorkflowGraphSync } from '../dist/workflow/dispatcher.js';
import { jobLifecycleV2, taskLifecycleV2 } from '../dist/workflow/definitions-v2.js';
import { SQLiteRelayStore } from '../dist/relay-store.js';
import { GitHubProjectionWriter, ProjectedDurableStore, isTerminalProjectionFailure } from '../dist/projected-store.js';
import { InMemoryStore } from '../dist/store.js';

const now = () => new Date().toISOString();

function collecting(minimumLevel = 'debug') {
  const records = [];
  const previous = RelayObservability.silent();
  setObservability(new RelayObservability(collectObservations(records), minimumLevel));
  return { records, restore: () => setObservability(previous) };
}

test('observability redacts secrets/prompts and bounds large payloads', () => {
  const sanitized = sanitizeObservationData({
    authorization: 'Bearer super-secret-token',
    apiKey: 'sk-live-123',
    nested: { password: 'hunter2', prompt: 'do the secret thing', keep: 'visible' },
    input: 'x'.repeat(2000),
    roles: ['a', 'b'],
  });
  assert.equal(sanitized.authorization, '[redacted]');
  assert.equal(sanitized.apiKey, '[redacted]');
  assert.equal(sanitized.nested.password, '[redacted]');
  assert.equal(sanitized.nested.prompt, '[redacted]');
  assert.equal(sanitized.nested.keep, 'visible');
  assert.match(String(sanitized.input), /^\[omitted \d+ chars\]$/);
  assert.deepEqual(sanitized.roles, ['a', 'b']);
});

test('classifyFailure separates deterministic conflicts from transient retries', () => {
  assert.equal(classifyFailure(new Error('Task t1 already exists with a different definition')).classification, 'conflict');
  assert.equal(classifyFailure(Object.assign(new Error('conflict'), { status: 409 })).classification, 'conflict');
  assert.equal(classifyFailure(Object.assign(new Error('rate limited'), { status: 429 })).classification, 'transient');
  assert.equal(classifyFailure(Object.assign(new Error('server error'), { status: 503 })).classification, 'transient');
  assert.equal(classifyFailure(new Error('fetch failed: ECONNRESET')).classification, 'transient');
  const withRetry = classifyFailure(Object.assign(new Error('deferred'), { retryAfter: 5 }));
  assert.equal(withRetry.classification, 'transient');
  assert.equal(withRetry.retryAfterMs, 5000);
  assert.equal(classifyFailure(new Error('unexpected shape')).classification, 'terminal');
});

test('graph dispatcher records decision identity and stays quiet on no_transition at info', () => {
  const noisy = collecting('info');
  try {
    dispatchWorkflowGraphSync(taskLifecycleV2, {
      initialState: 'SUCCEEDED',
      input: { transport: 'event', id: 'dispatch', payload: {} },
      durableFacts: { dispatchable: false },
      graphName: 'task-lifecycle',
    });
    assert.deepEqual(noisy.records, [], 'no_transition must not emit at info level');
  } finally { noisy.restore(); }

  const verbose = collecting('debug');
  try {
    const decision = dispatchWorkflowGraphSync(taskLifecycleV2, {
      initialState: 'QUEUED',
      input: { transport: 'event', id: 'task.started', payload: {} },
      durableFacts: {},
      graphName: 'task-lifecycle',
    });
    assert.equal(decision.accepted, true);
    const graphRecord = verbose.records.find(record => record.stage === 'graph');
    assert.ok(graphRecord, 'accepted graph decision is recorded');
    assert.equal(graphRecord.transition.graph, 'task-lifecycle');
    assert.equal(graphRecord.transition.from, 'QUEUED');
    assert.equal(graphRecord.transition.to, 'RUNNING');
  } finally { verbose.restore(); }
});

test('same-state actionless graph decisions are debug no-ops, not info transitions', () => {
  const capture = collecting('info');
  try {
    const decision = dispatchWorkflowGraphSync(jobLifecycleV2, {
      initialState: 'ACTIVE',
      input: { transport: 'event', id: 'reconcile', payload: {} },
      durableFacts: { prOpen: false },
      graphName: 'job-lifecycle',
    });
    assert.equal(decision.accepted, true);
    assert.equal(decision.source, 'ACTIVE');
    assert.equal(decision.target, 'ACTIVE');
    assert.deepEqual(decision.actions, []);
    assert.deepEqual(capture.records, []);
  } finally { capture.restore(); }
});

test('pure lifecycle decisions do not emit phantom transition observations', () => {
  const capture = collecting('debug');
  try {
    const decision = decideTaskLifecycle({ id: 'task-predicate', state: 'RUNNING' }, 'cancel', {});
    assert.equal(decision.accepted, true);
    assert.equal(decision.target, 'CANCELLED');
    assert.deepEqual(capture.records, []);
  } finally { capture.restore(); }
});

test('representative wake -> graph -> store -> projection lifecycle is reconstructible', async () => {
  const capture = collecting('debug');
  const dir = await mkdtemp(join(tmpdir(), 'agents-relay-obs-'));
  const store = new SQLiteRelayStore(join(dir, 'relay.db'));
  try {
    const turn = dispatchWorkflowGraphSync(taskLifecycleV2, {
      initialState: 'QUEUED',
      input: { transport: 'event', id: 'task.started', payload: {} },
      durableFacts: {},
      graphName: 'task-lifecycle',
    });
    assert.equal(turn.accepted, true);
    assert.equal(turn.target, 'RUNNING');

    await withObservabilityCorrelation(
      { repository: 'lalalic/agents-relay', prNumber: 228, jobId: 'job-1', taskId: 'task-1' },
      async () => {
        const job = {
          id: 'job-1', title: 'job', executionMode: 'fixed', prNumber: 228, repository: 'lalalic/agents-relay',
          state: 'ACTIVE', continuation: null, createdAt: now(), updatedAt: now(),
          tasks: [{
            jobId: 'job-1', id: 'task-1', parentTaskId: null, dependencies: [], capabilities: [],
            adapter: 'orchestrator', input: 'work', state: 'RUNNING', attempt: 1, maxAttempts: 2,
            leaseOwner: 'relay', leaseExpiresAt: null, executionId: 'exec-1', threadId: null,
            result: null, error: null, timeoutMs: 1000, createdAt: now(), updatedAt: now(),
            continuation: null, continuationDeliveredAt: null,
          }],
        };
        await store.saveJobWithProjection(job, {
          idempotencyKey: 'save_task:job-1:task-1',
          coalesceKey: 'task:job-1:task-1',
          operation: 'save_task',
          payload: { operation: 'save_task', value: job.tasks[0] },
          priority: 50,
        });
      },
    );

    const enqueued = capture.records.find(record => record.event === 'projection.enqueued');
    assert.ok(enqueued, 'projection enqueue is recorded');
    assert.equal(enqueued.data.operation, 'save_task');
    assert.deepEqual(enqueued.correlation, { repository: 'lalalic/agents-relay', prNumber: 228, jobId: 'job-1', taskId: 'task-1' });

    const stages = new Set(capture.records.map(record => record.stage));
    assert.ok(stages.has('graph'), 'graph decision is part of the reconstructed chain');
    assert.ok(stages.has('projection'), 'projection enqueue is part of the reconstructed chain');
  } finally {
    capture.restore();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('ProjectedDurableStore records a store commit and projection enqueue for one task write', async () => {
  const capture = collecting('debug');
  const dir = await mkdtemp(join(tmpdir(), 'agents-relay-obs-store-'));
  const relay = new SQLiteRelayStore(join(dir, 'relay.db'));
  try {
    const projected = new ProjectedDurableStore(relay, new InMemoryStore());
    const job = {
      id: 'job-9', title: 'job', executionMode: 'fixed', prNumber: 228, repository: 'lalalic/agents-relay',
      state: 'ACTIVE', continuation: null, createdAt: now(), updatedAt: now(),
      tasks: [{
        jobId: 'job-9', id: 'task-9', parentTaskId: null, dependencies: [], capabilities: [],
        adapter: 'orchestrator', input: 'work', state: 'QUEUED', attempt: 1, maxAttempts: 2,
        leaseOwner: null, leaseExpiresAt: null, executionId: null, threadId: null,
        result: null, error: null, timeoutMs: 1000, createdAt: now(), updatedAt: now(),
        continuation: null, continuationDeliveredAt: null,
      }],
    };
    await projected.saveJob(job);
    await projected.saveTask(job.tasks[0]);
    const storeCommit = capture.records.find(record => record.stage === 'store' && record.data.operation === 'save_task');
    assert.ok(storeCommit, 'store commit is recorded for the task write');
    assert.equal(storeCommit.correlation.repository, 'lalalic/agents-relay');
    assert.equal(storeCommit.correlation.prNumber, 228);
    assert.equal(storeCommit.correlation.jobId, 'job-9');
    assert.equal(storeCommit.correlation.taskId, 'task-9');
    assert.ok(capture.records.some(record => record.stage === 'projection' && record.data.operation === 'save_task'));
  } finally {
    capture.restore();
    relay.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('emitted records never contain secret material', () => {
  const capture = collecting('debug');
  try {
    dispatchWorkflowGraphSync(taskLifecycleV2, {
      initialState: 'QUEUED',
      input: { transport: 'event', id: 'task.started', payload: {} },
      durableFacts: { authorization: 'Bearer top-secret', prompt: 'exfiltrate' },
      graphName: 'task-lifecycle',
    });
    const serialized = JSON.stringify(capture.records);
    assert.doesNotMatch(serialized, /top-secret/);
    assert.doesNotMatch(serialized, /exfiltrate/);
  } finally { capture.restore(); }
});

test('projection writer records terminal outcome and deterministic conflict classification', async () => {
  const capture = collecting('debug');
  try {
    const relay = {
      claimed: null,
      async claimDueProjections() { return this.claimed ? [this.claimed] : []; },
      async completeProjection() { throw new Error('should not complete'); },
      async deadLetterProjection() { this.deadLettered = true; },
      async retryProjection() { throw new Error('conflict must not be retried'); },
    };
    const github = { async saveJob() {}, async appendTask() { throw new Error('Task t1 already exists with a different definition'); } };
    const writer = new GitHubProjectionWriter(relay, github);
    relay.claimed = { id: 7, idempotencyKey: 'append_task:j:t1', coalesceKey: null, operation: 'append_task', payload: { operation: 'append_task', value: {} }, priority: 40, attempts: 0, nextAttemptAt: null, lastError: null, createdAt: now(), updatedAt: now() };
    const result = await writer.flushOnce();
    assert.equal(result.deferred, 0);
    assert.equal(relay.deadLettered, true);
    const deadLetter = capture.records.find(record => record.event === 'projection.dead_lettered');
    assert.ok(deadLetter, 'conflict is dead-lettered with a structured record');
    assert.equal(deadLetter.data.classification, 'conflict');
    assert.match(deadLetter.message, /already exists with a different definition/);
  } finally { capture.restore(); }
});

test('projection writer records transient retry with classification and retry schedule', async () => {
  const capture = collecting('debug');
  try {
    const relay = {
      claimed: null,
      retried: null,
      async claimDueProjections() { return this.claimed ? [this.claimed] : []; },
      async completeProjection() {},
      async deadLetterProjection() { throw new Error('transient must not be dead-lettered'); },
      async retryProjection(_id, error, nextAttemptAt) { this.retried = { error, nextAttemptAt }; },
    };
    const github = { async saveJob() { throw Object.assign(new Error('rate limited'), { status: 429 }); } };
    const writer = new GitHubProjectionWriter(relay, github);
    relay.claimed = { id: 8, idempotencyKey: 'save_job:j', coalesceKey: 'job:j', operation: 'save_job', payload: { operation: 'save_job', value: {} }, priority: 20, attempts: 1, nextAttemptAt: null, lastError: null, createdAt: now(), updatedAt: now() };
    const result = await writer.flushOnce();
    assert.equal(result.deferred, 1);
    assert.ok(relay.retried);
    const retry = capture.records.find(record => record.event === 'projection.retry_scheduled');
    assert.ok(retry, 'transient failure schedules a retry record');
    assert.equal(retry.data.classification, 'transient');
    assert.equal(retry.data.status, 429);
    assert.ok(typeof retry.data.retryAt === 'string');
  } finally { capture.restore(); }
});

test('isTerminalProjectionFailure keeps divergent-definition conflicts terminal', () => {
  assert.equal(isTerminalProjectionFailure({ operation: 'append_task' }, new Error('Task t1 already exists with a different definition')), true);
  assert.equal(isTerminalProjectionFailure({ operation: 'save_job' }, new Error('Task t1 already exists with a different definition')), false);
});

test('async correlation context is propagated to nested records', async () => {
  const capture = collecting('debug');
  try {
    await withObservabilityCorrelation({ jobId: 'j-correlated' }, async () => {
      assert.deepEqual(currentObservabilityCorrelation(), { jobId: 'j-correlated' });
      await dispatchWorkflowGraph(taskLifecycleV2, {
        initialState: 'QUEUED',
        input: { transport: 'event', id: 'task.started', payload: {} },
        durableFacts: {},
        graphName: 'task-lifecycle',
      });
    });
    const record = capture.records.find(item => item.stage === 'graph');
    assert.equal(record.correlation.jobId, 'j-correlated');
  } finally { capture.restore(); }
});
