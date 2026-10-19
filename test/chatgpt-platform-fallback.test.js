import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { codexFallbackCompatible } from '../dist/chatgpt-platform-fallback.js';

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
