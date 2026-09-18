import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { serveDashboard } from '../dist/dashboard.js';
import { InMemoryStore } from '../dist/store.js';
import { MemoryEventBus } from '../dist/events.js';
import { CodexSessionUsageReader, UsageRegistry } from '../dist/usage.js';

function jsonl(value) { return JSON.stringify(value) + '\n'; }

async function writeTelemetry(root, filename, model, tokens, sessionId) {
  const day = filename.split('-')[1] ?? '2026-09-18';
  const directory = join(root, 'sessions', ...day.split('-'));
  await mkdir(directory, { recursive: true });
  const path = join(directory, filename);
  await writeFile(path, [
    jsonl({ type: 'session_meta', timestamp: '2026-09-18T10:00:00Z', payload: { id: sessionId } }),
    jsonl({ type: 'turn_context', timestamp: '2026-09-18T10:00:01Z', payload: { model, effort: 'high' } }),
    jsonl({ type: 'token_usage_record', timestamp: '2026-09-18T10:00:02Z', payload: { session_id: sessionId, response_id: 'response-' + model, usage: tokens } }),
  ].join(''));
  await utimes(path, new Date('2026-09-18T10:00:03Z'), new Date('2026-09-18T10:00:03Z'));
}

test('Codex JSONL reader records actual tokens and classifies recorded GLM models as Z.ai', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-relay-usage-'));
  await writeTelemetry(root, 'rollout-2026-09-18T10-00-00-zai.jsonl', 'glm-5.3-flash', {
    input_tokens: 100, cached_input_tokens: 60, cache_write_input_tokens: 5, output_tokens: 20, reasoning_output_tokens: 8, total_tokens: 120,
  }, 'zai-session');
  await writeTelemetry(root, 'rollout-2026-09-18T10-01-00-codex.jsonl', 'gpt-5.6-luna', {
    input_tokens: 30, cached_input_tokens: 10, cache_write_input_tokens: 0, output_tokens: 6, reasoning_output_tokens: 2, total_tokens: 36,
  }, 'codex-session');
  const fixedNow = new Date('2026-09-18T10:05:00Z');
  const reader = new CodexSessionUsageReader(root, 1, 0, () => fixedNow);
  const telemetry = await reader.read();
  assert.equal(telemetry.records.length, 2);
  assert.deepEqual(telemetry.records.filter(record => record.sourceId === 'zai').map(record => [record.model, record.tokens.total]), [['glm-5.3-flash', 120]]);
  assert.equal(telemetry.records.find(record => record.sourceId === 'codex')?.tokens.cachedInput, 10);
});

test('usage registry aggregates provider/model accounting and current-job sessions without inventing balance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-relay-usage-'));
  await writeTelemetry(root, 'rollout-2026-09-18T10-00-00-zai.jsonl', 'glm-5.3-flash', {
    input_tokens: 100, cached_input_tokens: 60, cache_write_input_tokens: 5, output_tokens: 20, reasoning_output_tokens: 8, total_tokens: 120,
  }, 'current-thread');
  const reader = new CodexSessionUsageReader(root, 1, 0, () => new Date('2026-09-18T10:05:00Z'));
  const registry = new UsageRegistry(reader, [
    { id: 'codex', label: 'Codex local session telemetry' },
    { id: 'zai', label: 'Z.ai runtime usage via recorded GLM models' },
  ]);
  const snapshot = await registry.snapshot(undefined, ['current-thread']);
  assert.equal(snapshot.requestCount, 1);
  assert.equal(snapshot.tokens.total, 120);
  const zai = snapshot.sources.find(source => source.id === 'zai');
  assert.equal(zai.requestCount, 1);
  assert.deepEqual(zai.models, [{
    provider: 'zai', model: 'glm-5.3-flash', requestCount: 1,
    tokens: { input: 100, cachedInput: 60, cacheWriteInput: 5, output: 20, reasoning: 8, total: 120 },
  }]);
  assert.equal(zai.quotaBalance.available, false);
  assert.equal(zai.quotaBalance.state, 'unsupported');
  assert.match(zai.quotaBalance.reason, /quota\/balance/);
  assert.equal(snapshot.currentJob.available, true);
  assert.equal(snapshot.currentJob.requestCount, 1);
  assert.equal(snapshot.currentJob.tokens.total, 120);
});

test('malformed and non-telemetry JSONL lines never become usage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-relay-usage-'));
  const directory = join(root, 'sessions', '2026', '09', '18');
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'rollout.jsonl');
  await writeFile(path, '{broken\n' + jsonl({ type: 'token_usage_record', timestamp: '2026-09-18T10:00:02Z', payload: { usage: { input_tokens: -1 } } }));
  await utimes(path, new Date('2026-09-18T10:00:03Z'), new Date('2026-09-18T10:00:03Z'));
  const reader = new CodexSessionUsageReader(root, 1, 0, () => new Date('2026-09-18T10:05:00Z'));
  assert.equal((await reader.read()).records.length, 0);
});

test('dashboard serves bounded usage through the safe localhost API', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-relay-usage-api-'));
  await writeTelemetry(root, 'rollout-2026-09-18T10-00-00-zai.jsonl', 'glm-5.3-flash', {
    input_tokens: 10, cached_input_tokens: 4, cache_write_input_tokens: 1, output_tokens: 3, reasoning_output_tokens: 1, total_tokens: 13,
  }, 'thread-usage');
  const job = {
    id: 'usage-job', title: 'Usage', prNumber: 1, repository: 'owner/repo', state: 'RUNNING',
    continuation: null, createdAt: '2026-09-18T10:00:00Z', updatedAt: '2026-09-18T10:00:00Z',
    tasks: [],
  };
  const reader = new CodexSessionUsageReader(root, 1, 0, () => new Date('2026-09-18T10:05:00Z'));
  const registry = new UsageRegistry(reader, [{ id: 'zai', label: 'Z.ai runtime usage via recorded GLM models' }]);
  const store = new InMemoryStore(job);
  const server = serveDashboard(store, 0, new MemoryEventBus(), 10_000, 'usage-job', registry);
  await new Promise(resolve => server.once('listening', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/usage`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    const payload = await response.json();
    assert.equal(payload.sources[0].quotaBalance.available, false);
    assert.equal(payload.currentJob.available, false);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
