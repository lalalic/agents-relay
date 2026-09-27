import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from './test-runtime.js';
import { BrowserWorkspaceUsageReader, CodexApiUsageReader, CodexSessionUsageReader, DeepSeekCreditReader, OpenRouterCreditReader, readUsageSnapshot, UsageRegistry } from '../dist/usage.js';

function jsonl(value) { return JSON.stringify(value) + '\n'; }

async function writeRateLimitTelemetry(root, used5h, usedWeek) {
  const directory = join(root, 'sessions', '2026', '09', '18');
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'rollout.jsonl');
  await writeFile(path, jsonl({
    timestamp: '2026-09-18T10:37:47.161Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: { used_percent: used5h, window_minutes: 300, resets_at: 1789745000 },
        secondary: { used_percent: usedWeek, window_minutes: 10080, resets_at: 1789805365 }
      }
    }
  }));
  await utimes(path, new Date('2026-09-18T10:38:00Z'), new Date('2026-09-18T10:38:00Z'));
}

test('reader uses real account rate-limit percentages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-usage-'));
  await writeRateLimitTelemetry(root, 2, 85);
  const snapshot = await new CodexSessionUsageReader(root, 8, 0, () => new Date('2026-09-18T10:40:00Z')).read();
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.fiveHour?.usedPercent, 2);
  assert.equal(snapshot.weekly?.usedPercent, 85);
});

test('missing rate-limit telemetry stays unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-usage-'));
  const snapshot = await new CodexSessionUsageReader(root, 8, 0, () => new Date('2026-09-18T10:40:00Z')).read();
  assert.equal(snapshot.available, false);
  assert.equal(snapshot.fiveHour, null);
  assert.equal(snapshot.weekly, null);
});

test('usage registry exposes only account limit state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-usage-'));
  await writeRateLimitTelemetry(root, 31.5, 74);
  const overview = await new UsageRegistry(new CodexSessionUsageReader(root, 8, 0, () => new Date('2026-09-18T10:40:00Z'))).snapshot();
  const snapshot = overview.providers.find(provider => provider.id === 'openai').usage;
  const zai = overview.providers.find(provider => provider.id === 'zai').usage;
  assert.deepEqual(Object.keys(snapshot).sort(), ['available', 'fiveHour', 'generatedAt', 'reason', 'weekly']);
});


test('DeepSeek credit reader exposes configured account balances', async () => {
  const fetchImpl = async url => {
    assert.equal(url, 'https://api.deepseek.com/user/balance');
    return new Response(JSON.stringify({ is_available: true, balance_infos: [
      { currency: 'USD', total_balance: '12.34', granted_balance: '2.34', topped_up_balance: '10.00' },
      { currency: 'CNY', total_balance: '56.78', granted_balance: '0', topped_up_balance: '56.78' }
    ] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const snapshot = await new DeepSeekCreditReader('configured', undefined, fetchImpl, () => new Date('2026-09-18T10:40:00Z')).read();
  assert.equal(snapshot.available, true);
  assert.deepEqual(snapshot.balances.map(item => [item.currency, item.remaining]), [['USD', 12.34], ['CNY', 56.78]]);
});

test('OpenRouter credit reader exposes purchased, used, and remaining credits', async () => {
  const fetchImpl = async url => {
    assert.equal(url, 'https://openrouter.ai/api/v1/credits');
    return new Response(JSON.stringify({ data: { total_credits: 100.5, total_usage: 25.75 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const snapshot = await new OpenRouterCreditReader('configured', undefined, fetchImpl, () => new Date('2026-09-18T10:40:00Z')).read();
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.balances[0].currency, 'USD');
  assert.equal(snapshot.balances[0].total, 100.5);
  assert.equal(snapshot.balances[0].used, 25.75);
  assert.equal(snapshot.balances[0].remaining, 74.75);
});

test('usage registry includes credit providers only when readers are configured', async () => {
  const usage = { read: async () => ({ available: false, generatedAt: 'x', fiveHour: null, weekly: null, reason: 'none' }) };
  const credit = { read: async () => ({ available: true, generatedAt: 'x', balances: [{ currency: 'USD', total: 10, used: null, remaining: 10 }], reason: null }) };
  const withoutCredits = await new UsageRegistry(usage, usage).snapshot();
  assert.deepEqual(withoutCredits.credits, []);
  const withCredits = await new UsageRegistry(usage, usage, credit, credit).snapshot();
  assert.deepEqual(withCredits.credits.map(item => item.id), ['deepseek', 'openrouter']);
});

test('usage registry exposes Browser Workspace capacity as a shared resource fact', async () => {
  const capacity = { name: 'Harness', poolSize: 5, idle: 0, leased: 5, available: false, observedAt: '2026-09-27T16:00:00.000Z', reason: null };
  const overview = await new UsageRegistry(
    { read: async () => ({ available: false, generatedAt: 'x', fiveHour: null, weekly: null, reason: 'unused' }) },
    { read: async () => ({ available: false, generatedAt: 'x', fiveHour: null, weekly: null, reason: 'unused' }) },
    null,
    null,
    { read: async () => capacity },
  ).snapshot();
  assert.deepEqual(overview.browserWorkspace, capacity);
});

test('Browser Workspace probe failures remain unknown', async () => {
  const reader = new BrowserWorkspaceUsageReader('definitely-not-a-browser-harness-command', 50, () => new Date('2026-09-27T16:00:00.000Z'));
  const capacity = await reader.read();
  assert.equal(capacity.idle, null);
  assert.equal(capacity.available, null);
});

test('shared usage snapshot API reads on demand without caching the registry result', async () => {
  let reads = 0;
  const source = {
    snapshot: async () => ({ generatedAt: String(++reads), providers: [], credits: [] }),
  };
  assert.equal((await readUsageSnapshot(source)).generatedAt, '1');
  assert.equal((await readUsageSnapshot(source)).generatedAt, '2');
});
