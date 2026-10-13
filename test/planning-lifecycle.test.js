import assert from 'node:assert/strict';
import test, { managedReconciler } from './test-runtime.js';
import { InMemoryStore } from '../dist/store.js';
import { Reconciler, executionEventSource } from '../dist/reconciler.js';
import { MemoryEventBus, eventFor } from '../dist/events.js';

const now = () => new Date().toISOString();
const route = { provider: 'openai', model: 'gpt-test', decidedBy: 'test', decidedAt: now() };
const work = (id, parentTaskId = null) => ({ jobId: 'planning', id, kind: 'work', parentTaskId, dependencies: [], capabilities: [], adapter: 'codex', input: 'do work', output: { kind: 'task_pr' }, routing: route, state: 'QUEUED', attempt: 0, maxAttempts: 1, leaseOwner: null, leaseExpiresAt: null, executionId: null, threadId: null, result: null, plannerResult: null, error: null, timeoutMs: 1000, createdAt: now(), updatedAt: now(), continuation: null, continuationDeliveredAt: null });
const job = (tasks, executionMode = 'autonomous') => ({ id: 'planning', title: 'Planning', objective: 'finish', executionMode, prNumber: 1, repository: 'owner/repo', state: 'ACTIVE', continuation: null, createdAt: now(), updatedAt: now(), tasks });
const harness = bus => ({ name: 'codex', id: 'test-codex', capabilities: ['model', 'codex'], launch(task) { queueMicrotask(async () => { const source = { id: executionEventSource('planning', task.id, task.executionId) }; await bus.publish(eventFor('planning', task.id, task.parentTaskId, 'task.started', 'running', 'started', 'user', undefined, source)); await bus.publish(eventFor('planning', task.id, task.parentTaskId, 'task.completed', 'succeeded', 'done', 'orchestrator', undefined, source)); }); return { id: task.id, promise: Promise.resolve({ summary: 'runtime ended' }), cancel() {} }; } });
async function settle(reconciler) { for (let i = 0; i < 8; i += 1) { await reconciler.reconcile('planning'); await reconciler.idle(); await new Promise(resolve => setTimeout(resolve, 0)); } }

function plannedJob(mode = 'autonomous') {
  const initial = work('initial');
  return { job: job([initial], mode), child: initial };
}


test('orchestrator-supplied autonomous initial work runs before any model planner', async () => {
  const { job: initial } = plannedJob();
  const store = new InMemoryStore(initial);
  const bus = new MemoryEventBus();
  let plannerCalls = 0;
  const planner = { plan: async () => { plannerCalls += 1; return { objective_status: 'satisfied', assessment: 'done', next_tasks: [] }; } };
  const reconciler = managedReconciler(store, { owner: 'test', adapters: [harness(bus)], planner, eventBus: bus });
  const stop = await reconciler.watch('planning');
  await reconciler.reconcile('planning');
  assert.equal(plannerCalls, 0);
  const initialTask = (await store.load('planning')).tasks.find(task => task.id === 'initial');
  assert.equal(initialTask?.planningSource, undefined);
  assert.equal(initialTask?.parentTaskId, null);
  await stop();
});

test('zero-task autonomous jobs remain idle until the orchestrator creates the first batch', async () => {
  const store = new InMemoryStore(job([]));
  const bus = new MemoryEventBus();
  let plannerCalls = 0;
  const planner = { plan: async () => { plannerCalls += 1; return { objective_status: 'in_progress', assessment: 'unexpected', next_tasks: [] }; } };
  const reconciler = managedReconciler(store, { owner: 'test', adapters: [harness(bus)], planner, eventBus: bus });
  const stop = await reconciler.watch('planning');
  await settle(reconciler);
  const result = await store.load('planning');
  assert.equal(plannerCalls, 0);
  assert.equal(result.tasks.length, 0);
  assert.equal(result.state, 'ACTIVE');
  await stop();
});
test('reconcile preserves an existing durable task when a planner repeats its id with a changed definition', async () => {
  const existing = { ...work('planned'), input: 'original durable work' };
  const plannerTask = { ...work('planner-1'), kind: 'planner', state: 'SUCCEEDED', plannerResult: { objective_status: 'in_progress', assessment: 'repeat', next_tasks: [{title: 'Implement and verify durable task outputs',  id: 'planned', input: 'changed planner wording', adapter: 'codex', output: { kind: 'task_pr' } }] }, result: { summary: 'repeat' } };
  const store = new InMemoryStore(job([plannerTask, existing]));
  const bus = new MemoryEventBus();
  const reconciler = managedReconciler(store, { owner: 'test', adapters: [harness(bus)], planner: { plan: async () => ({ objective_status: 'satisfied', assessment: 'done', next_tasks: [] }) }, eventBus: bus });
  const stop = await reconciler.watch('planning');
  await reconciler.reconcile('planning');
  await reconciler.idle();
  const result = await store.load('planning');
  assert.equal(result.tasks.filter(task => task.id === 'planned').length, 1);
  assert.equal(result.tasks.find(task => task.id === 'planned')?.input, 'original durable work');
  await stop();
});

test('fixed jobs stop after the orchestrator-created task batch', async () => {
  const { job: initial } = plannedJob('fixed');
  const store = new InMemoryStore(initial);
  const bus = new MemoryEventBus();
  let plannerCalls = 0;
  const reconciler = managedReconciler(store, { owner: 'test', adapters: [harness(bus)], planner: { plan: async () => { plannerCalls += 1; return { objective_status: 'satisfied', assessment: 'done', next_tasks: [] }; } }, eventBus: bus });
  const stop = await reconciler.watch('planning');
  await settle(reconciler);
  assert.equal(plannerCalls, 0);
  assert.equal((await store.load('planning')).tasks.filter(task => task.kind === 'planner').length, 0);
  await stop();
});

test('cancelled planner history does not freeze an active autonomous job', async () => {
  const completed = { ...work('business-cycle'), state: 'SUCCEEDED', result: { summary: 'diagnosed' } };
  const cancelled = { ...work('planner-1'), kind: 'planner', state: 'CANCELLED', error: 'Cancelled by user' };
  const store = new InMemoryStore(job([completed, cancelled]));
  const bus = new MemoryEventBus();
  let plannerCalls = 0;
  const planner = { plan: async () => { plannerCalls += 1; return { objective_status: 'satisfied', assessment: 'done', next_tasks: [] }; } };
  const reconciler = managedReconciler(store, { owner: 'test', adapters: [harness(bus)], planner, eventBus: bus });
  const stop = await reconciler.watch('planning');
  await settle(reconciler);
  const result = await store.load('planning');
  assert.equal(plannerCalls, 1);
  assert.equal(result.tasks.some(task => task.id === 'plan-2'), false);
  assert.equal(result.plans?.find(plan => plan.id === 'plan-2')?.status, 'SUCCEEDED');
  await stop();
});

test('planner failure after an orchestrator-started batch does not invent executable tasks', async () => {
  const { job: initial } = plannedJob();
  const store = new InMemoryStore(initial);
  const bus = new MemoryEventBus();
  const reconciler = managedReconciler(store, { owner: 'test', adapters: [harness(bus)], planner: { plan: async () => { throw new Error('planner unavailable'); } }, eventBus: bus });
  const stop = await reconciler.watch('planning');
  await settle(reconciler);
  const result = await store.load('planning');
  assert.equal(result.tasks.filter(task => task.kind !== 'planner').length, 1);
  assert.equal(result.tasks.some(task => task.id === 'plan-1'), false);
  assert.equal(result.plans?.find(plan => plan.id === 'plan-1')?.status, 'FAILED');
  await stop();
});
