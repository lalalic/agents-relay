import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { codexFallbackCompatible, codexFallbackRouting } from '../dist/chatgpt-platform-fallback.js';
import { routeExecution } from '../dist/execution-routing.js';
import { eligibleWorkerCandidates, workerCandidates } from '../dist/worker-routing.js';

const adapters = [
  { name: 'chatgpt', id: 'chatgpt-test', capabilities: ['model', 'chatgpt'] },
  { name: 'codex', id: 'codex-test', capabilities: ['model', 'coding', 'cli'] },
];
const task = workerRequirements => ({
  id: 'fallback-task', adapter: 'chatgpt', workerRequirements,
  input: 'implement the code', parentTaskId: null, dependencies: [], capabilities: [],
  state: 'QUEUED', attempt: 1, maxAttempts: 2,
});

test('fallback requires strict task capabilities and an executable Codex model route', async () => {
  const home = await mkdtemp(join(tmpdir(), 'relay-codex-route-'));
  const policy = join(home, 'routing-policy.json');
  const previousHome = process.env.CODEX_HOME;
  const previousPolicy = process.env.AGENTS_RELAY_ROUTING_POLICY;
  try {
    process.env.CODEX_HOME = home;
    process.env.AGENTS_RELAY_ROUTING_POLICY = policy;
    await writeFile(join(home, 'config.toml'), 'model = "gpt-test"\nmodel_provider = "openai"\n');
    await writeFile(policy, '{}');
    assert.equal(await codexFallbackCompatible(task({ capabilities: ['model', 'coding'] }), adapters, []), true);
    assert.equal(await codexFallbackCompatible(task({ capabilities: ['model', 'filesystem'] }), adapters, []), false);
    await writeFile(policy, JSON.stringify({ disabledProviders: ['openai'] }));
    assert.equal(await codexFallbackCompatible(task({ capabilities: ['model'] }), adapters, []), false);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    if (previousPolicy === undefined) delete process.env.AGENTS_RELAY_ROUTING_POLICY; else process.env.AGENTS_RELAY_ROUTING_POLICY = previousPolicy;
    await rm(home, { recursive: true, force: true });
  }
});

test('fallback preflight and dispatch share strict Codex candidates and persisted exclusions', async () => {
  const home = await mkdtemp(join(tmpdir(), 'relay-codex-routes-'));
  const policy = join(home, 'routing-policy.json');
  const previousHome = process.env.CODEX_HOME;
  const previousPolicy = process.env.AGENTS_RELAY_ROUTING_POLICY;
  const multiCodex = [
    ...adapters.filter(adapter => adapter.name !== 'codex'),
    { name: 'codex', id: 'codex-capable', capabilities: ['model', 'coding'] },
    { name: 'codex', id: 'codex-limited', capabilities: ['model'] },
  ];
  try {
    process.env.CODEX_HOME = home;
    process.env.AGENTS_RELAY_ROUTING_POLICY = policy;
    await writeFile(join(home, 'config.toml'), 'model = "gpt-test"\nmodel_provider = "openai"\n');
    await writeFile(policy, '{}');

    const capableTask = task({ capabilities: ['model', 'coding'] });
    const shared = codexFallbackRouting(capableTask, multiCodex, []);
    assert.deepEqual(shared.candidates.map(candidate => candidate.workerId), ['codex-capable']);
    assert.equal(await codexFallbackCompatible(capableTask, multiCodex, []), true);
    const dispatch = await routeExecution(shared.candidates, capableTask.workerRequirements, { excludedRoutes: shared.excludedRoutes });
    assert.equal(dispatch.candidate.workerId, 'codex-capable');

    const excludedTask = { ...capableTask, routingExclusions: [
      { provider: 'openai', model: 'gpt-test', reason: 'failed', at: new Date().toISOString() },
    ] };
    assert.equal(await codexFallbackCompatible(excludedTask, multiCodex, []), false);

    const allExcludedTask = { ...capableTask, routingExclusions: [
      { provider: 'other', model: 'other', workerId: 'codex-capable', reason: 'failed', at: new Date().toISOString() },
      { provider: 'other', model: 'other', workerId: 'codex-limited', reason: 'failed', at: new Date().toISOString() },
    ] };
    assert.equal(await codexFallbackCompatible(allExcludedTask, multiCodex, []), false);

    const softCandidates = workerCandidates(multiCodex, []);
    assert.ok(eligibleWorkerCandidates(softCandidates, { capabilities: ['coding'] }).some(candidate => candidate.workerId === 'codex-limited'));
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    if (previousPolicy === undefined) delete process.env.AGENTS_RELAY_ROUTING_POLICY; else process.env.AGENTS_RELAY_ROUTING_POLICY = previousPolicy;
    await rm(home, { recursive: true, force: true });
  }
});
