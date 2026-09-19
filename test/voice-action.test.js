import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVoiceActionUrl, verifyVoiceActionUrl } from '../dist/voice-action.js';
import { serveDashboard } from '../dist/dashboard.js';
import { InMemoryStore } from '../dist/store.js';

test('voice action URLs are signed, short-lived, and repository-scoped', () => {
  const secret = 'test-secret';
  const now = 1_700_000_000_000;
  const payload = {
    action: 'job.create',
    repository: 'lalalic/agents-relay',
    head: 'voice-test',
    id: 'voice-test',
    title: 'Voice test',
  };
  const signed = buildVoiceActionUrl('https://agents.example.test', secret, payload, 300, now);
  const parsed = verifyVoiceActionUrl(new URL(signed), secret, new Set(['lalalic/agents-relay']), now);
  assert.deepEqual(parsed, payload);
  assert.throws(() => verifyVoiceActionUrl(new URL(signed), 'wrong-secret', new Set(['lalalic/agents-relay']), now), /Invalid signed action/);
  assert.throws(() => verifyVoiceActionUrl(new URL(signed), secret, new Set(['lalalic/neo']), now), /Repository is not allowed/);
  assert.throws(() => verifyVoiceActionUrl(new URL(signed), secret, new Set(['lalalic/agents-relay']), now + 301_000), /Expired signed action/);
});

test('dashboard exposes voice actions only when a gateway is configured and disables caching', async () => {
  const job = {
    id: 'j',
    title: 'J',
    prNumber: 1,
    repository: 'lalalic/agents-relay',
    state: 'OPEN',
    continuation: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tasks: [],
  };
  const store = new InMemoryStore(job);
  const calls = [];
  const gateway = {
    async execute(url, clientId) {
      calls.push({ url: url.toString(), clientId });
      return { status: 200, body: { ok: true, action: 'job.create' } };
    },
  };
  const server = serveDashboard(store, 0, undefined, 10000, 'j', undefined, undefined, undefined, undefined, undefined, gateway);
  await new Promise(resolve => server.once('listening', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const response = await fetch(`http://127.0.0.1:${port}/voice/actions/v1/execute?exp=1&payload=x&sig=y`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { ok: true, action: 'job.create' });
  assert.equal(calls.length, 1);
  await new Promise(resolve => server.close(resolve));
});
