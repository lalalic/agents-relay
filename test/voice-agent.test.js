import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVoiceAgentUrl, createVoiceAgentToken, verifyVoiceAgentToken, VoiceAgentGateway } from '../dist/voice-agent.js';
import { serveDashboard } from '../dist/dashboard.js';
import { InMemoryStore } from '../dist/store.js';

test('voice agent session tokens are long-lived, signed, and project-scoped', () => {
  const secret = 'test-secret';
  const now = 1_700_000_000_000;
  const token = createVoiceAgentToken(secret, ['agents-relay', 'neo'], 7200, now);
  assert.deepEqual(verifyVoiceAgentToken(token, secret, 'agents-relay', now), {
    exp: Math.floor(now / 1000) + 7200,
    projects: ['agents-relay', 'neo'],
  });
  assert.throws(() => verifyVoiceAgentToken(token, 'wrong-secret', 'agents-relay', now), /Invalid voice agent token/);
  assert.throws(() => verifyVoiceAgentToken(token, secret, 'other', now), /Project is not allowed/);
  assert.throws(() => verifyVoiceAgentToken(token, secret, 'agents-relay', now + 7201_000), /Expired voice agent token/);
  const url = new URL(buildVoiceAgentUrl('https://agents.example.test', secret, ['agents-relay'], 7200, now));
  assert.equal(url.pathname, '/voice/agent/v1/message');
  assert.ok(url.searchParams.get('token'));
  assert.equal(url.searchParams.has('request'), false);
});

test('voice agent gateway accepts immediately and continues one server-side agent session', async () => {
  const calls = [];
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const worker = {
    async run(input) {
      calls.push(input);
      if (calls.length === 1) await firstGate;
      return { summary: `done-${calls.length}`, conversationId: input.conversationId ?? 'conversation-1' };
    },
  };
  const secret = 'secret';
  const token = createVoiceAgentToken(secret, ['agents-relay'], 7200);
  const gateway = new VoiceAgentGateway(worker, secret, '/workspace', new Set(['agents-relay']));

  const first = gateway.submit({ token, request: 'create a job', project: 'agents-relay', clientId: 'client' });
  assert.equal(first.status, 202);
  assert.equal(first.body.accepted, true);
  const sessionId = first.body.session_id;
  const firstRequestId = first.body.request_id;

  const second = gateway.submit({ token, request: 'continue it', project: 'agents-relay', sessionId, clientId: 'client' });
  assert.equal(second.status, 202);
  assert.equal(second.body.session_id, sessionId);
  assert.equal(calls.length, 0);

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(gateway.status(token, firstRequestId, 'agents-relay').body.state, 'RUNNING');
  releaseFirst();
  for (let index = 0; index < 20 && calls.length < 2; index += 1) await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].conversationId, 'conversation-1');
  const secondState = gateway.status(token, second.body.request_id, 'agents-relay');
  for (let index = 0; index < 20 && secondState.body.state !== 'SUCCEEDED'; index += 1) {
    await new Promise(resolve => setImmediate(resolve));
    Object.assign(secondState, gateway.status(token, second.body.request_id, 'agents-relay'));
  }
  assert.equal(secondState.body.state, 'SUCCEEDED');
});

test('voice agent gateway enforces configured project scope', () => {
  const secret = 'secret';
  const token = createVoiceAgentToken(secret, ['agents-relay', 'neo'], 7200);
  const gateway = new VoiceAgentGateway({ run: async () => ({ summary: 'done' }) }, secret, '/workspace', new Set(['agents-relay']));
  assert.equal(gateway.submit({ token, request: 'x', project: 'neo', clientId: 'client' }).status, 401);
  assert.equal(gateway.submit({ token, request: 'x', clientId: 'client' }).status, 202);
});


test('voice agent gateway supports explicit tokenless connectivity-test mode', async () => {
  const calls = [];
  const gateway = new VoiceAgentGateway(
    { run: async input => { calls.push(input); return { summary: 'ok' }; } },
    '',
    '/workspace',
    new Set(['agents-relay']),
    'none',
  );
  const accepted = gateway.submit({ token: '', request: 'check status', project: 'agents-relay', clientId: 'voice' });
  assert.equal(accepted.status, 202);
  assert.equal(accepted.body.accepted, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].project, 'agents-relay');
  assert.equal(gateway.submit({ token: '', request: 'x', project: 'neo', clientId: 'voice2' }).status, 401);
  assert.equal(gateway.status('', accepted.body.request_id, 'agents-relay').status, 200);
});


test('simple GET /voice accepts only q and infers the single allowed project', async () => {
  const calls = [];
  const job = {
    id: 'j', title: 'J', prNumber: 1, repository: 'lalalic/agents-relay', state: 'OPEN',
    continuation: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tasks: [],
  };
  const gateway = new VoiceAgentGateway(
    { run: async input => { calls.push(input); return { summary: 'done' }; } },
    '',
    '/workspace',
    new Set(['agents-relay']),
    'none',
  );
  const server = serveDashboard(new InMemoryStore(job), 0, undefined, 10000, 'j', undefined, undefined, undefined, undefined, undefined, gateway);
  await new Promise(resolve => server.once('listening', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const response = await fetch('http://127.0.0.1:' + port + '/voice?q=' + encodeURIComponent('check repo status'));
  assert.equal(response.status, 202);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(body.accepted, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].request, 'check repo status');
  assert.equal(calls[0].project, 'agents-relay');
  await new Promise(resolve => server.close(resolve));
});

test('dashboard exposes only the general voice agent API and disables caching', async () => {
  const job = {
    id: 'j', title: 'J', prNumber: 1, repository: 'lalalic/agents-relay', state: 'OPEN',
    continuation: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tasks: [],
  };
  const store = new InMemoryStore(job);
  const calls = [];
  const gateway = {
    submit(input) {
      calls.push(input);
      return { status: 202, body: { ok: true, accepted: true, session_id: 's', request_id: 'r', state: 'QUEUED' } };
    },
    status() {
      return { status: 200, body: { ok: true, request_id: 'r', session_id: 's', state: 'SUCCEEDED' } };
    },
  };
  const server = serveDashboard(store, 0, undefined, 10000, 'j', undefined, undefined, undefined, undefined, undefined, gateway);
  await new Promise(resolve => server.once('listening', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  const response = await fetch(`http://127.0.0.1:${port}/voice/agent/v1/message?token=t&request=do%20it&project=agents-relay`);
  assert.equal(response.status, 202);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].request, 'do it');

  const old = await fetch(`http://127.0.0.1:${port}/voice/actions/v1/execute?exp=1&payload=x&sig=y`);
  assert.equal(old.status, 404);
  await new Promise(resolve => server.close(resolve));
});
