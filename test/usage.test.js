import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CodexSessionUsageReader, UsageRegistry } from '../dist/usage.js';

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
