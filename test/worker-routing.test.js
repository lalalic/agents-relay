import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePlannerResult } from '../dist/planner.js';
import { discoverAgents } from '../dist/registry.js';
import { readUsageSnapshot, UsageRegistry } from '../dist/usage.js';
import { selectReviewer } from '../dist/reviewer-routing.js';
import { selectWorker, usageForProvider } from '../dist/worker-routing.js';

const generatedAt = '2026-09-21T16:00:00.000Z';

function usage(usedPercent) {
  return {
    available: true,
    generatedAt,
    fiveHour: { usedPercent, windowMinutes: 300, resetsAt: null },
    weekly: { usedPercent, windowMinutes: 10080, resetsAt: null },
    reason: null,
  };
}

function worker(id, overrides = {}) {
  return {
    id,
    name: id,
    responsibility: 'test worker',
    role: 'worker',
    capabilities: ['model'],
    boundaries: [],
    endpoint: { kind: 'adapter', target: id },
    runtime: { adapter: id, provider: id, model: `${id}-model` },
    availability: 'available',
    routing: { labels: { region: 'ca' }, trustDomains: ['test'] },
    evidence: {
      evaluations: [{ taskKind: 'implementation', outcome: 'success', observedAt: generatedAt }],
      outcomes: { succeeded: 1, failed: 0, timedOut: 0 },
      lastObservedAt: generatedAt,
    },
    registeredAt: generatedAt,
    updatedAt: generatedAt,
    ...overrides,
  };
}

test('worker discovery applies capability and availability hard gates before ranking', () => {
  const candidates = discoverAgents([
    worker('codex'),
    worker('browser-only', { capabilities: ['model', 'browser-harness'] }),
    worker('degraded', { availability: 'degraded' }),
    worker('wrong-region', { routing: { labels: { region: 'us' }, trustDomains: ['test'] } }),
  ], {
    capabilities: ['model', 'browser-harness'],
    availability: ['available'],
    labels: { region: 'ca' },
    trustDomain: 'test',
  });

  assert.deepEqual(candidates.map(candidate => candidate.agent.id), ['browser-only']);
});

test('usage-aware routing receives a fresh shared snapshot without duplicating provider probes', async () => {
  let openaiReads = 0;
  let zaiReads = 0;
  const registry = new UsageRegistry(
    { read: async () => { openaiReads += 1; return usage(18); } },
    { read: async () => { zaiReads += 1; return usage(42); } },
  );

  const first = await readUsageSnapshot(registry);
  const second = await readUsageSnapshot(registry);

  assert.equal(first.providers.find(provider => provider.id === 'openai').usage.fiveHour.usedPercent, 18);
  assert.equal(second.providers.find(provider => provider.id === 'zai').usage.fiveHour.usedPercent, 42);
  assert.equal(openaiReads, 2);
  assert.equal(zaiReads, 2);
});

test('planner declares worker requirements before model routing is selected', () => {
  const result = parsePlannerResult({
    objective_status: 'in_progress',
    assessment: 'select a capable worker',
    next_tasks: [{
      id: 'route-me',
      input: 'perform the task',
      workerRequirements: {
        capabilities: ['model', 'browser-harness'],
        runtime: 'hosted',
        taskKind: 'research',
        trustDomain: 'test',
        region: 'ca',
        labels: { tier: 'trusted' },
      },
      adapter: 'codex',
      routing: { provider: 'openai', model: 'gpt-test', decidedBy: 'model-router', decidedAt: generatedAt },
      output: { kind: 'task_pr' },
      storySize: 'M',
    }],
  });

  assert.deepEqual(result.next_tasks[0].workerRequirements, {
    capabilities: ['model', 'browser-harness'],
    runtime: 'hosted',
    taskKind: 'research',
    trustDomain: 'test',
    region: 'ca',
    labels: { tier: 'trusted' },
  });
  assert.equal(result.next_tasks[0].adapter, 'codex');
  assert.equal(result.next_tasks[0].routing.decidedBy, 'model-router');
});

test('fresh usage snapshots are not cached by the shared usage surface', async () => {
  let snapshots = 0;
  const source = {
    snapshot: async () => {
      snapshots += 1;
      return { generatedAt: String(snapshots), providers: [], credits: [] };
    },
  };

  assert.equal((await readUsageSnapshot(source)).generatedAt, '1');
  assert.equal((await readUsageSnapshot(source)).generatedAt, '2');
  assert.equal(snapshots, 2);
});

test('reviewer routing prefers an eligible worker not used by implementation', () => {
  const implementation = [{ adapter: 'codex', workerSelection: { workerId: 'codex', adapter: 'codex', capabilities: ['model'], selectedBy: 'worker-router', selectedAt: generatedAt }, routing: { provider: 'openai', model: 'gpt-5', decidedBy: 'model-router', decidedAt: generatedAt }, agentName: 'builder' }];
  const decision = selectReviewer([
    { workerId: 'codex', adapter: 'codex', capabilities: ['model'], routing: { provider: 'openai', model: 'gpt-5', decidedBy: 'model-router', decidedAt: generatedAt } },
    { workerId: 'chatgpt/browser-worker', adapter: 'chatgpt', capabilities: ['model', 'browser-harness'], routing: { provider: 'chatgpt', model: 'account-defaults', decidedBy: 'model-router', decidedAt: generatedAt } },
  ], implementation, { capabilities: ['model'] });
  assert.equal(decision.selection.workerId, 'chatgpt/browser-worker');
  assert.equal(decision.reason, 'worker-diversity');
  assert.match(decision.selection.selectedBy, /reviewer-diversity/);
});

test('reviewer diversity never bypasses hard availability and capability gates', () => {
  const decision = selectReviewer([
    { workerId: 'different-but-degraded', adapter: 'chatgpt', capabilities: ['model', 'review'], availability: 'degraded', routing: { provider: 'chatgpt', model: 'account-defaults', decidedBy: 'model-router', decidedAt: generatedAt } },
    { workerId: 'same-but-eligible', adapter: 'codex', capabilities: ['model'], availability: 'available', routing: { provider: 'openai', model: 'gpt-5', decidedBy: 'model-router', decidedAt: generatedAt } },
  ], [{ adapter: 'codex', workerSelection: { workerId: 'same-but-eligible', adapter: 'codex', capabilities: ['model'], selectedBy: 'worker-router', selectedAt: generatedAt }, agentName: 'builder', routing: { provider: 'openai', model: 'gpt-5', decidedBy: 'model-router', decidedAt: generatedAt } }], { capabilities: ['model'] });
  assert.equal(decision.selection.workerId, 'same-but-eligible');
  assert.equal(decision.reason, 'eligible-fallback');
});

test('worker routing avoids an otherwise eligible worker under resource pressure', () => {
  const candidates = [
    { workerId: 'busy', adapter: 'codex', capabilities: ['model'], resourceHealthy: false, resourceProvider: 'openai', resourceUsedPercent: 100, routing: { provider: 'openai', model: 'busy-model', decidedBy: 'model-router', decidedAt: generatedAt } },
    { workerId: 'healthy', adapter: 'chatgpt', capabilities: ['model'], resourceHealthy: true, resourceProvider: 'chatgpt', routing: { provider: 'chatgpt', model: 'healthy-model', decidedBy: 'model-router', decidedAt: generatedAt } },
  ];
  const decision = selectWorker(candidates, { capabilities: ['model'] });
  assert.equal(decision.selection.workerId, 'healthy');
  assert.equal(decision.selection.resourceHealthy, true);
});

test('planner accepts executable tasks without adapter or model routing', () => {
  const result = parsePlannerResult({
    objective_status: 'in_progress',
    assessment: 'work',
    next_tasks: [{ id: 'unrouted', input: 'do work', workerRequirements: { capabilities: ['model'] }, output: { kind: 'task_pr' }, storySize: 'S' }],
  });
  assert.equal(result.next_tasks[0].adapter, undefined);
  assert.equal(result.next_tasks[0].routing, undefined);
  assert.equal(result.next_tasks[0].workerRequirements?.capabilities[0], 'model');
});

test('reconciler materializes an unrouted planner child through worker-router before launch', async () => {
  const { InMemoryStore } = await import('../dist/store.js');
  const { Reconciler } = await import('../dist/reconciler.js');
  const { MemoryEventBus } = await import('../dist/events.js');
  const now = new Date().toISOString();
  const planner = {
    jobId: 'routing-job',
    id: 'planner-1',
    kind: 'planner',
    parentTaskId: null,
    dependencies: [],
    capabilities: ['planner'],
    adapter: 'orchestrator',
    input: 'plan',
    state: 'SUCCEEDED',
    attempt: 1,
    maxAttempts: 1,
    leaseOwner: null,
    leaseExpiresAt: null,
    executionId: null,
    threadId: null,
    result: { summary: 'planned' },
    plannerResult: {
      objective_status: 'in_progress',
      assessment: 'route next',
      next_tasks: [{
        id: 'planned-work',
        input: 'do work',
        workerRequirements: { capabilities: ['model'] },
        output: { kind: 'task_pr' },
        storySize: 'S',
      }],
    },
    error: null,
    timeoutMs: 0,
    createdAt: now,
    updatedAt: now,
    planningDecisionId: 'planner-1',
    planningSource: 'model-planner',
    planningRound: 1,
  };
  const job = {
    id: 'routing-job',
    title: 'Routing',
    objective: 'route work',
    executionMode: 'fixed',
    prNumber: 1,
    repository: 'owner/repo',
    state: 'ACTIVE',
    continuation: null,
    createdAt: now,
    updatedAt: now,
    tasks: [planner],
  };
  const store = new InMemoryStore(job);
  const bus = new MemoryEventBus();
  const adapter = {
    name: 'codex',
    id: 'codex',
    capabilities: ['model', 'codex'],
    launch() { throw new Error('maxConcurrent=0 should prevent launch'); },
  };
  const usageSnapshotProvider = async () => ({
    generatedAt: now,
    providers: [{ id: 'openai', label: 'OpenAI', usage: usage(10) }],
    credits: [],
  });
  const reconciler = new Reconciler(store, {
    owner: 'test',
    adapters: [adapter],
    eventBus: bus,
    maxConcurrent: 0,
    usageSnapshotProvider,
  });
  await reconciler.reconcile('routing-job');
  const routed = (await store.load('routing-job')).tasks.find(task => task.id === 'planned-work');
  assert.equal(routed?.adapter, 'codex');
  assert.equal(routed?.workerSelection?.workerId, 'codex');
  assert.equal(routed?.routing?.provider, 'openai');
  assert.equal(routed?.routing?.decidedBy, 'model-router');
});

test('known near-exhausted quota yields to an otherwise eligible worker with unknown quota', () => {
  const decision = selectWorker([
    { workerId: 'codex', adapter: 'codex', capabilities: ['model'], resourceHealthy: true, resourceProvider: 'openai', resourceUsedPercent: 95, routing: { provider: 'openai', model: 'gpt-5.6-luna', decidedBy: 'model-router', decidedAt: generatedAt } },
    { workerId: 'chatgpt', adapter: 'chatgpt', capabilities: ['model'], routing: { provider: 'chatgpt', model: 'account-defaults', decidedBy: 'model-router', decidedAt: generatedAt } },
  ], { capabilities: ['model'] });
  assert.equal(decision.selection.workerId, 'chatgpt');
});

test('usage facts expose remaining capacity and the nearest reset horizon for model routing', () => {
  const now = Date.parse('2026-09-21T16:00:00.000Z');
  const snapshot = {
    generatedAt,
    providers: [{ id: 'openai', label: 'OpenAI', usage: {
      available: true,
      generatedAt,
      fiveHour: { usedPercent: 20, windowMinutes: 300, resetsAt: Math.floor((now + 30 * 60_000) / 1000) },
      weekly: { usedPercent: 10, windowMinutes: 10080, resetsAt: Math.floor((now + 3 * 24 * 60 * 60_000) / 1000) },
      reason: null,
    }}],
    credits: [],
  };
  const resource = usageForProvider(snapshot, 'openai', now);
  assert.equal(resource.usedPercent, 20);
  assert.equal(resource.remainingPercent, 80);
  assert.equal(resource.resetInMinutes, 30);
  assert.equal(resource.resetAt, snapshot.providers[0].usage.fiveHour.resetsAt);
  assert.equal(resource.windows.fiveHour.remainingPercent, 80);
  assert.equal(resource.windows.fiveHour.resetInMinutes, 30);
  assert.equal(resource.windows.weekly.remainingPercent, 90);
  assert.equal(resource.windows.weekly.resetInMinutes, 3 * 24 * 60);
});
