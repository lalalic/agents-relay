import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Reconciler, executionEventSource } from '../dist/reconciler.js';
import { InMemoryStore } from '../dist/store.js';
import { SQLiteRelayStore } from '../dist/relay-store.js';
import { LocalAuthorityDurableStore } from '../dist/local-authority-store.js';
import { MemoryEventBus, eventFor } from '../dist/events.js';

const now = () => new Date().toISOString();
const adapters = [
  { name: 'chatgpt', id: 'chat-worker', capabilities: ['model'], launch() { throw Error('unexpected launch'); } },
  { name: 'z', id: 'z-worker', capabilities: ['model'], launch() { throw Error('unexpected launch'); } },
  { name: 'codex', id: 'codex-worker', capabilities: ['model', 'coding'], launch() { throw Error('unexpected launch'); } },
];
const task = (adapter, overrides = {}) => ({
  jobId: 'j', id: 'task-1', kind: 'work', parentTaskId: null,
  dependencies: [], capabilities: [], workerRequirements: { capabilities: ['model'] },
  adapter, input: 'task', output: { kind: 'task_pr' },
  routing: { provider: adapter, model: 'old-model', decidedBy: 'test', decidedAt: now() },
  workerSelection: { workerId: adapter + '-worker', adapter, capabilities: ['model'], selectedBy: 'test', selectedAt: now() },
  state: 'QUEUED', attempt: 1, maxAttempts: 3,
  leaseOwner: 'test', leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
  executionId: 'execution-1', executionHistory: [{ id: 'execution-1', attempt: 1, startedAt: now() }],
  threadId: null, result: null, error: null, timeoutMs: 5000,
  createdAt: now(), updatedAt: now(), ...overrides,
});
const job = t => ({
  id: 'j', title: 'test', repository: 'owner/repo', prNumber: 1,
  state: 'ACTIVE', tasks: [t], plans: [], createdAt: now(), updatedAt: now(),
});

class Harness extends Reconciler {
  fail(t, phase, evidence = 'adapter failed', executionId = t.executionId) {
    return this.failLaunch('j', t.id, executionId, new Error(evidence), phase);
  }
  route(j, t) { return this.routeTaskForExecution(j, t); }
  async process(t) { return this.runtimeSettled('j', t.id, t.executionId, null, 'failed process'); }
  terminal(t) {
    return this.applyTerminalEvent(eventFor('j', t.id, null, 'task.failed', 'failed',
      'worker error without start', 'user', { reason: 'adapter_error' },
      { id: executionEventSource('j', t.id, t.executionId), agent: t.adapter }));
  }
  timeout(t) { return this.timeoutTask('j', t.id, t.executionId); }
  started(event) { return this.markWorkerStarted(event); }
  waitForTerminal(t) { return this.terminalWait(t.id, t.executionId, 0); }
  hasTerminalWaiter(id) { return this.terminalWaiters.has(id); }
}

async function withConfig(fn, { config = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'relay-no-start-'));
  const oldHome = process.env.CODEX_HOME;
  const oldPolicy = process.env.AGENTS_RELAY_ROUTING_POLICY;
  try {
    process.env.CODEX_HOME = dir;
    process.env.AGENTS_RELAY_ROUTING_POLICY = join(dir, 'policy.json');
    if (config) await writeFile(join(dir, 'config.toml'),
      'model = "fallback-model-42"\nmodel_provider = "openai"\nmodel_reasoning_effort = "medium"\n');
    await writeFile(join(dir, 'policy.json'), '{}');
    await fn();
  } finally {
    if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome;
    if (oldPolicy === undefined) delete process.env.AGENTS_RELAY_ROUTING_POLICY; else process.env.AGENTS_RELAY_ROUTING_POLICY = oldPolicy;
    await rm(dir, { recursive: true, force: true });
  }
}

async function runFailure(adapter, phase, overrides = {}) {
  const t = task(adapter, overrides);
  const store = new InMemoryStore(job(t));
  const bus = new MemoryEventBus();
  const events = [];
  const stop = await bus.subscribe('j', async evt => events.push(evt));
  const runtime = new Harness(store, { owner: 'test', adapters, eventBus: bus, maxConcurrent: 0 });
  try {
    if (phase === 'process') await runtime.process(t);
    else if (phase === 'terminal') await runtime.terminal(t);
    else if (phase === 'watchdog') await runtime.timeout(t);
    else await runtime.fail(t, phase);
    const updated = (await store.load('j')).tasks[0];
    return { updated, store, runtime, events, stop };
  } catch (error) {
    await runtime.close();
    await stop();
    throw error;
  }
}

for (const adapter of ['chatgpt', 'z']) {
  for (const phase of ['launch', 'start-ack', 'process', 'terminal']) {
    test(adapter + ' ' + phase + ' failure without task.started retries using configured Codex default', async () => {
      await withConfig(async () => {
        const { updated, runtime, store, events, stop } = await runFailure(adapter, phase);
        try {
          assert.equal(updated.state, 'QUEUED');
          assert.equal(updated.executionId, null);
          assert.equal(updated.routing, undefined);
          assert.equal(updated.noStartFallback.failedExecutionId, 'execution-1');
          assert.equal(updated.noStartFallback.failedAttempt, 1);
          assert.equal(updated.noStartFallback.previous.adapter, adapter);
          assert.equal(updated.executionHistory.length, 1);
          assert.ok(events.some(e => e.type === 'worker.no_start_fallback'));
          assert.equal((await store.load('j')).tasks.some(t => t.agentName === 'troubleshooter'), false);
          const j = await store.load('j');
          await runtime.route(j, j.tasks[0]);
          const chosen = (await store.load('j')).tasks[0];
          assert.equal(chosen.adapter, 'codex');
          assert.equal(chosen.routing.provider, 'openai');
          assert.equal(chosen.routing.model, 'fallback-model-42');
          assert.equal(chosen.routing.reasoning, 'medium');
        } finally {
          await runtime.close();
          await stop();
        }
      });
    });
  }
}

test('no-start watchdog with expired deadline takes same fallback path', async () => {
  await withConfig(async () => {
    const past = new Date(Date.now() - 10_000).toISOString();
    const { updated, runtime, stop } = await runFailure('z', 'watchdog', {
      timeoutMs: 1, executionHistory: [{ id: 'execution-1', attempt: 1, startedAt: past }],
    });
    try {
      assert.equal(updated.state, 'QUEUED');
      assert.equal(updated.noStartFallback.failedExecutionId, 'execution-1');
    } finally { await runtime.close(); await stop(); }
  });
});

test('already started and stale generation are not rerouted', async () => {
  await withConfig(async () => {
    for (const overrides of [
      { state: 'RUNNING' },
      { state: 'QUEUED', lastProgressEventAt: now() },
      { noStartFallback: { failedExecutionId: 'prior', failedAttempt: 0, reason: 'prior', previous: {}, at: now() } },
      { attempt: 3, maxAttempts: 3 },
      { workerRequirements: { capabilities: ['model'], runtime: 'chatgpt' } },
    ]) {
      const { updated, runtime, stop } = await runFailure('chatgpt', 'start-ack', overrides);
      try {
        assert.equal(updated.state, 'FAILED');
        assert.deepEqual(updated.noStartFallback, overrides.noStartFallback);
      } finally { await runtime.close(); await stop(); }
    }
    const t = task('z', { executionId: 'new-generation' });
    const store = new InMemoryStore(job(t));
    const runtime = new Harness(store, { owner: 'test', adapters, maxConcurrent: 0 });
    try {
      await runtime.fail({ ...t, executionId: 'old-generation' }, 'start-ack');
      const state = (await store.load('j')).tasks[0];
      assert.equal(state.executionId, 'new-generation');
      assert.equal(state.noStartFallback, undefined);
    } finally { await runtime.close(); }
  });
});

test('unconfigured Codex default and incompatible capability fail closed', async () => {
  for (const overrides of [{}, { workerRequirements: { capabilities: ['filesystem'] } }]) {
    await withConfig(async () => {
      const { updated, runtime, stop } = await runFailure('chatgpt', 'start-ack', overrides);
      try {
        assert.equal(updated.noStartFallback, undefined);
        assert.equal(updated.state, 'FAILED');
      } finally { await runtime.close(); await stop(); }
    }, { config: !(!Object.keys(overrides).length) });
  }
});
test('SQLite restart preserves no-start fallback and fences stale started events', async () => {
  await withConfig(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'relay-nostart-sqlite-'));
    const filename = join(dir, 'relay.sqlite');
    let sql = new SQLiteRelayStore(filename, 'j');
    let store = new LocalAuthorityDurableStore(sql, new InMemoryStore(), undefined, true);
    const t = task('z');
    let runtime;
    try {
      await store.saveJob(job(t));
      runtime = new Harness(store, { owner: 'test', adapters, maxConcurrent: 0 });
      await runtime.fail(t, 'start-ack');
      const queued = (await store.load('j')).tasks[0];
      assert.equal(queued.noStartFallback.failedExecutionId, 'execution-1');
      await runtime.close();
      runtime = undefined;
      sql.close();
      sql = new SQLiteRelayStore(filename, 'j');
      store = new LocalAuthorityDurableStore(sql, new InMemoryStore(), undefined, true);
      runtime = new Harness(store, { owner: 'test', adapters, maxConcurrent: 0 });
      const restored = await store.load('j');
      assert.equal(restored.tasks[0].noStartFallback.failedAttempt, 1);
      await runtime.route(restored, restored.tasks[0]);
      const selected = (await store.load('j')).tasks[0];
      assert.equal(selected.adapter, 'codex');
      assert.equal(selected.routing.model, 'fallback-model-42');
      const lateStarted = eventFor('j', t.id, null, 'task.started', 'running', 'late worker started',
        'user', {}, { id: executionEventSource('j', t.id, 'execution-1') });
      const outcome = await runtime.started(lateStarted);
      assert.equal(outcome.applied, false);
      assert.equal((await store.load('j')).tasks[0].adapter, 'codex');
      assert.equal((await store.load('j')).tasks.some(item => item.agentName === 'troubleshooter'), false);
    } finally {
      await runtime?.close();
      sql.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
for (const sourceAdapter of ['chatgpt', 'z']) {
test('Reconciler dispatches Codex second attempt after ' + sourceAdapter + ' fails without start', async () => {
  await withConfig(async () => {
    const t = task(sourceAdapter, {
      state: 'QUEUED', attempt: 0, executionId: null, executionHistory: [],
      leaseOwner: null, leaseExpiresAt: null,
    });
    const j = job(t);
    j.plans = [{
      jobId: 'j', id: 'plan-1', round: 1, source: 'model-planner', previousPlanId: null,
      trigger: { source: 'initial' }, status: 'SUCCEEDED', objectiveStatus: 'satisfied',
      assessment: 'fixture', generatedTaskIds: [t.id], createdAt: now(), updatedAt: now(),
    }];
    const store = new InMemoryStore(j);
    const bus = new MemoryEventBus();
    const calls = [];
    const chat = {
      name: sourceAdapter, id: sourceAdapter + '-worker', capabilities: ['model'],
      launch(task) {
        calls.push([sourceAdapter, task.attempt, task.routing?.model]);
        return { id: 'chat-failed', launched: Promise.resolve(),
          promise: Promise.reject(new Error('adapter crashed before task.started')),
          cancel() {} };
      },
    };
    const codex = {
      name: 'codex', id: 'codex-worker', capabilities: ['model'],
      launch(task) {
        calls.push(['codex', task.attempt, task.routing?.model]);
        return { id: 'codex-running', launched: Promise.resolve(),
          promise: new Promise(() => {}), cancel() {} };
      },
    };
    const runtime = new Harness(store, {
      owner: 'test', adapters: [chat, codex], eventBus: bus,
      maxConcurrent: 1, startAckTimeoutMs: 1000, noGitHub: true,
    });
    const stop = await runtime.watch('j');
    try {
      await runtime.reconcile('j');
      for (let i = 0; i < 100 && !calls.some(([name]) => name === 'codex'); i++)
        await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(calls.filter(([name]) => name === sourceAdapter).length, 1);
      assert.deepEqual(calls.find(([name]) => name === 'codex'), ['codex', 2, 'fallback-model-42']);
      const updated = (await store.load('j')).tasks[0];
      assert.equal(updated.adapter, 'codex');
      assert.equal(updated.attempt, 2);
      assert.equal(updated.noStartFallback.failedAttempt, 1);
      assert.equal((await store.load('j')).tasks.some(task => task.agentName === 'troubleshooter'), false);
    } finally {
      await stop();
      await runtime.close();
    }
  });
});
}
test('no-start fallback releases after-terminal browser waiter before Codex dispatch', async () => {
  await withConfig(async () => {
    const t = task('chatgpt');
    const store = new InMemoryStore(job(t));
    const runtime = new Harness(store, { owner: 'test', adapters, maxConcurrent: 0 });
    try {
      const wait = runtime.waitForTerminal(t);
      await runtime.fail(t, 'start-ack');
      await wait.promise;
      assert.equal(runtime.hasTerminalWaiter(t.id), false);
      assert.equal((await store.load('j')).tasks[0].state, 'QUEUED');
    } finally { await runtime.close(); }
  });
});

test('Direct Shortcut mode never uses normal no-start Worker fallback', async () => {
  await withConfig(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'relay-nostart-direct-'));
    const sql = new SQLiteRelayStore(join(dir, 'relay.sqlite'), 'j');
    const store = new LocalAuthorityDurableStore(sql, new InMemoryStore(), undefined, true);
    const t = task('z');
    const runtime = new Harness(store, { owner: 'test', adapters, maxConcurrent: 0 });
    try {
      await store.saveJob({ ...job(t), executionMode: 'shortcut', contentOnly: true });
      assert.equal((await store.load('j')).executionMode, 'shortcut');
      await runtime.fail(t, 'start-ack');
      const actual = (await store.load('j')).tasks[0];
      assert.equal(actual.state, 'FAILED');
      assert.equal(actual.noStartFallback, undefined);
    } finally {
      await runtime.close();
      sql.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
