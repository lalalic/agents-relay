import test, { managedReconciler } from './test-runtime.js';
import assert from 'node:assert/strict';
import { InMemoryStore } from '../dist/store.js';
import { createTaskEntity } from '../dist/workflow/entity-creation.js';
import { prepareOrchestratorRepair } from '../dist/workflow/orchestrator-rescue.js';

const now = () => new Date().toISOString();
const task = (id, state = 'QUEUED', fields = {}) => ({
  jobId: 'j', id, kind: 'work', priority: 'P1', storySize: 'S', parentTaskId: null,
  dependencies: [], capabilities: ['implementation'], adapter: 'orchestrator',
  input: 'do the described work', output: { kind: 'task_pr' },
  continuation: null, continuationDeliveredAt: null, state, attempt: 0, maxAttempts: 3,
  leaseOwner: null, leaseExpiresAt: null, executionId: null, threadId: null,
  result: null, error: null, timeoutMs: 0, createdAt: now(), updatedAt: now(), ...fields,
});
const job = (tasks) => ({
  id: 'j', title: 'Ownership repair', executionMode: 'fixed', prNumber: 0,
  repository: 'owner/repo', state: 'ACTIVE', continuation: null,
  createdAt: now(), updatedAt: now(), tasks,
});

test('Task creation boundary rejects internal orchestration and accepts requirements', () => {
  const root = job([]);
  assert.throws(() => createTaskEntity(root, task('rejected')), /Execution Router select the route/);
  const declared = createTaskEntity(root, { ...task('accepted'), adapter: 'codex', workerRequirements: { capabilities: ['model'] } });
  assert.equal(declared.state, 'QUEUED');
  assert.deepEqual(declared.workerRequirements, { capabilities: ['model'] });
});

test('legacy repair clears orphan ownership once and external completion exactly once', () => {
  const queued = task('queued');
  const queuedFirst = prepareOrchestratorRepair(queued, Date.parse('2026-10-04T06:00:00.000Z'));
  assert.equal(queuedFirst.repaired, true);
  assert.equal(queuedFirst.externallyCompleted, false);
  assert.equal(queued.state, 'QUEUED');
  assert.equal(queued.adapter, 'codex');
  assert.deepEqual(queued.workerRequirements, { capabilities: ['implementation'] });
  assert.equal(queued.threadId, null);
  assert.equal(prepareOrchestratorRepair(queued, Date.parse('2026-10-04T06:00:01.000Z')).repaired, false);

  const running = task('running', 'RUNNING', { leaseOwner: 'gone', leaseExpiresAt: '2026-10-04T06:00:00.000Z', executionId: 'lost', threadId: 'lost' });
  prepareOrchestratorRepair(running, Date.parse('2026-10-04T06:00:00.000Z'));
  assert.equal(running.state, 'QUEUED');
  assert.equal(running.executionId, null);
  assert.equal(running.leaseOwner, null);
  assert.equal(running.threadId, null);

  const completed = task('externally-done', 'RUNNING', {
    result: { summary: 'Release was completed externally' },
    leaseOwner: 'gone', leaseExpiresAt: '2026-10-04T06:00:00.000Z', executionId: 'lost', threadId: 'lost',
  });
  const applied = prepareOrchestratorRepair(completed, Date.parse('2026-10-04T06:00:00.000Z'));
  assert.equal(applied.externallyCompleted, true);
  assert.equal(completed.state, 'SUCCEEDED');
  assert.equal(completed.result.summary, 'Release was completed externally');
  assert.equal(completed.executionId, null);
  assert.equal(prepareOrchestratorRepair(completed, Date.parse('2026-10-04T06:00:01.000Z')).repaired, false);
});

test('atomic repair serializes concurrent reconcilers and launches once', async () => {
  const authority = new InMemoryStore(job([task('orphan')]));
  let mutationQueue = Promise.resolve();
  const store = new Proxy(authority, {
    get(target, property) {
      if (property !== 'mutateJob') {
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async (jobId, mutation) => {
        const run = mutationQueue.then(async () => {
          await new Promise(resolve => setTimeout(resolve, 10));
          const next = mutation(await target.load(jobId));
          await target.saveJob(next);
          await Promise.all(next.tasks.map(item => target.saveTask(item)));
          return next;
        });
        mutationQueue = run.then(() => undefined, () => undefined);
        return run;
      };
    },
  });
  const events = [];
  const first = managedReconciler(store, {
    owner: 'first', adapters: [], emit: event => events.push(event),
  });
  const second = managedReconciler(store, {
    owner: 'second', adapters: [], emit: event => events.push(event),
  });
  await Promise.all([first.reconcile('j'), second.reconcile('j')]);
  const repaired = (await authority.load('j')).tasks[0];
  assert.equal(repaired.adapter, 'codex');
  assert.equal(repaired.executionId, null);
  assert.equal(events.filter(event => event.type === 'task.orchestrator_rescued').length, 1);
  assert.equal(repaired.leaseOwner, null);
});
