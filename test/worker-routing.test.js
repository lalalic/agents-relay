import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePlannerResult } from '../dist/planner.js';
import { discoverAgents } from '../dist/registry.js';
import { readUsageSnapshot, UsageRegistry } from '../dist/usage.js';

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
