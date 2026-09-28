import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { ReconcileCoordinator } from '../dist/reconcile-coordinator.js';

function event(type, id) {
  return {
    version: 1,
    event_id: id,
    job_id: 'job-1',
    task_id: 'task-1',
    parent_task_id: null,
    type,
    status: 'running',
    timestamp: new Date().toISOString(),
    visibility: 'orchestrator',
    level: 'info',
    message: type,
  };
}

test('reconcile coordinator batches close signals without dropping lifecycle facts', async () => {
  const applied = [];
  let reconciles = 0;
  const coordinator = new ReconcileCoordinator(async (_jobId, signals) => {
    for (const signal of signals) if (signal.event) applied.push(signal.event.type);
    if (signals.some(signal => signal.reason !== 'event.task.started')) reconciles += 1;
  });

  await Promise.all([
    coordinator.accept({ jobId: 'job-1', reason: 'event.task.started', event: event('task.started', 'e1') }),
    coordinator.accept({ jobId: 'job-1', reason: 'event.task.completed', event: event('task.completed', 'e2') }),
  ]);

  assert.deepEqual(applied, ['task.started', 'task.completed']);
  assert.equal(reconciles, 1);
});

test('reconcile coordinator serializes later batches per job', async () => {
  let active = 0;
  let maxActive = 0;
  const batches = [];
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const coordinator = new ReconcileCoordinator(async (_jobId, signals) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    batches.push(signals.map(signal => signal.reason));
    if (batches.length === 1) await firstGate;
    active -= 1;
  });

  const first = coordinator.accept({ jobId: 'job-1', reason: 'job.wake' });
  await new Promise(resolve => setImmediate(resolve));
  const second = coordinator.accept({ jobId: 'job-1', reason: 'github.webhook:pull_request:edited' });
  releaseFirst();
  await Promise.all([first, second]);

  assert.equal(maxActive, 1);
  assert.deepEqual(batches, [['job.wake'], ['github.webhook:pull_request:edited']]);
});


test('transport acceptance cannot deadlock when reconcile publishes back into the same mailbox', async () => {
  const batches = [];
  let coordinator;
  coordinator = new ReconcileCoordinator(async (_jobId, signals) => {
    batches.push(signals.map(signal => signal.reason));
    if (signals.some(signal => signal.reason === 'job.wake')) {
      await coordinator.acceptTransport({ jobId: 'job-1', reason: 'event.task.process.launched' });
    }
  });

  await coordinator.accept({ jobId: 'job-1', reason: 'job.wake' });
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(batches, [
    ['job.wake'],
    ['event.task.process.launched'],
  ]);
});


test('settle waits until every queued mailbox batch has drained', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let completed = false;
  const coordinator = new ReconcileCoordinator(async () => {
    await gate;
    completed = true;
  });

  await coordinator.acceptTransport({ jobId: 'job-1', reason: 'event.task.completed' });
  const settled = coordinator.settle();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false);
  release();
  await settled;
  assert.equal(completed, true);
  assert.equal(coordinator.isIdle(), true);
});
