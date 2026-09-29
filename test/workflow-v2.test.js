import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { GraphDispatcher, GraphRuntime, parseGraphV2 } from '../dist/workflow/graph-v2.js';

const source = `flowchart LR
%% relay: initial failed
failed["state: FAILED"]
retryable["guard: task.retryable"]
retry["action: task.retry"]
queued["state: QUEUED"]
blocked["state: BLOCKED"]
retried["emit: task.retried"]
failed -->|on: task.retry| retryable
retryable -->|true| retry
retryable -->|false| blocked
retry -->|to: QUEUED| queued
retry -->|emit: task.retried| retried`;

const registries = {
  states: new Set(['FAILED', 'QUEUED', 'BLOCKED']),
  guards: { 'task.retryable': facts => facts.durableFacts.retryable === true },
  actions: { 'task.retry': { id: 'task.retry', validate: () => true } },
  events: { 'task.retry': { id: 'task.retry', validate: () => true }, 'task.retried': { id: 'task.retried' } },
};

test('v2 parser accepts strict flowchart topology and evaluates deterministically', () => {
  const runtime = new GraphRuntime(source, registries);
  const input = { transport: 'event', id: 'task.retry', payload: {} };
  const decision = runtime.evaluateSync({ currentState: 'FAILED', input, durableFacts: { retryable: true } });
  assert.deepEqual(decision, { accepted: true, source: 'FAILED', target: 'QUEUED', actions: [{ id: 'task.retry', input, emittedEvents: ['task.retried'] }] });
  assert.equal(runtime.evaluateSync({ currentState: 'FAILED', input, durableFacts: { retryable: false } }).target, 'BLOCKED');
});

test('v2 parser reports stable line diagnostics and rejects unsupported syntax', () => {
  assert.throws(() => parseGraphV2('flowchart TD\n%% relay: initial A\nA{"state: A"}'), /line 3: unsupported node shape '\{\.\.\.\}'/);
  assert.throws(() => parseGraphV2('flowchart TD\n%% relay: initial A\nA["state: A"]\nA -->|on: go| missing'), /line 4: edge target 'missing' is not declared/);
  assert.throws(() => parseGraphV2('flowchart TD\n%% relay: initial A\nA["state: A"]\nB["state: B"]\nA -->|on: go| A'), /state 'B' is unreachable/);
});

test('v2 registry binding rejects unknown semantic names and invalid payloads', () => {
  assert.throws(() => new GraphRuntime(source, { ...registries, states: new Set() }), /unknown state 'FAILED'/);
  assert.throws(() => new GraphRuntime(source, { ...registries, states: new Set(['FAILED', 'QUEUED']) }), /unknown state 'BLOCKED'/);
  assert.throws(() => new GraphRuntime(source, { ...registries, guards: {} }), /unknown guard 'task.retryable'/);
  const runtime = new GraphRuntime(source, { ...registries, events: { ...registries.events, 'task.retry': { id: 'task.retry', validate: () => false } } });
  assert.throws(() => runtime.evaluateSync({ currentState: 'FAILED', input: { transport: 'event', id: 'task.retry', payload: {} }, durableFacts: {} }), /invalid payload/);
});

test('v2 parser rejects duplicate input paths and malformed guard exits', () => {
  const duplicate = source.replace('retryable["guard: task.retryable"]', 'retryable["guard: task.retryable"]\nother["state: OTHER"]\nfailed -->|on: task.retry| other');
  assert.throws(() => parseGraphV2(duplicate), /ambiguous input path/);
  const malformed = source.replace('retryable -->|false| blocked', 'retryable -->|maybe| blocked');
  assert.throws(() => parseGraphV2(malformed), /unsupported edge label/);
});


test('v2 guards may reject by omitting a branch and semantic guard instances may repeat', () => {
  const guarded = `flowchart LR
%% relay: initial active
active["state: ACTIVE"]
done["state: DONE"]
g1["guard: allowed"]
g2["guard: allowed"]
active -->|on: finish| g1
g1 -->|true| done
done -->|on: reopen| g2
g2 -->|true| active`;
  const runtime = new GraphRuntime(guarded, {
    states: new Set(['ACTIVE','DONE']),
    guards: { allowed: facts => facts.durableFacts.allowed === true },
    events: { finish: { id: 'finish' }, reopen: { id: 'reopen' } },
  });
  const rejected = runtime.evaluateSync({ currentState: 'ACTIVE', input: { transport: 'event', id: 'finish', payload: {} }, durableFacts: { allowed: false } });
  assert.deepEqual(rejected, { accepted: false, source: 'ACTIVE', reason: 'no_transition' });
  const accepted = runtime.evaluateSync({ currentState: 'ACTIVE', input: { transport: 'event', id: 'finish', payload: {} }, durableFacts: { allowed: true } });
  assert.equal(accepted.target, 'DONE');
  assert.deepEqual(runtime.evaluateSync({ currentState: 'DONE', input: { transport: 'event', id: 'finish', payload: {} }, durableFacts: {} }), { accepted: false, source: 'DONE', reason: 'no_transition' });
});

test('v2 dispatcher persists the graph transition before action execution and publishes validated emits', async () => {
  const order = [];
  const runtime = new GraphRuntime(source, {
    ...registries,
    actions: {
      'task.retry': {
        id: 'task.retry',
        execute: () => {
          order.push('action');
          return { payloads: { 'task.retried': { ok: true } } };
        },
      },
    },
    events: {
      ...registries.events,
      'task.retried': { id: 'task.retried', validate: payload => (order.push('validated'), payload?.ok === true) },
    },
  });
  const dispatcher = new GraphDispatcher(runtime, {
    persistTransition: transition => {
      order.push(`persist:${transition.source}->${transition.target}`);
    },
    publishEvent: event => {
      order.push(`publish:${event.id}`);
    },
  });
  const result = await dispatcher.dispatch({ currentState: 'FAILED', input: { transport: 'event', id: 'task.retry', payload: {} }, durableFacts: { retryable: true } });
  assert.equal(result.receipts[0]?.ok, undefined);
  assert.equal(result.receipts[0]?.payloads?.['task.retried']?.ok, true);
  assert.deepEqual(order, ['persist:FAILED->QUEUED', 'action', 'validated', 'publish:task.retried']);
});

test('v2 dispatcher publishes only a registered failure event when an action reports failure', async () => {
  const published = [];
  const runtime = new GraphRuntime(source, {
    ...registries,
    actions: {
      'task.retry': {
        id: 'task.retry',
        execute: () => ({ ok: false, failureEvent: { id: 'task.retry_failed', payload: { reason: 'busy' } } }),
      },
    },
    events: {
      ...registries.events,
      'task.retry_failed': { id: 'task.retry_failed', validate: payload => payload?.reason === 'busy' },
    },
  });
  const dispatcher = new GraphDispatcher(runtime, {
    persistTransition: () => {},
    publishEvent: event => published.push(event),
  });
  const result = await dispatcher.dispatch({ currentState: 'FAILED', input: { transport: 'event', id: 'task.retry', payload: {} }, durableFacts: { retryable: true } });
  assert.equal(result.receipts[0]?.ok, false);
  assert.deepEqual(published, [{ id: 'task.retry_failed', payload: { reason: 'busy' } }]);
});

test('v2 parser rejects semantic labels that disagree with their target nodes', () => {
  assert.throws(
    () => parseGraphV2(source.replace('retry -->|to: QUEUED| queued', 'retry -->|to: BLOCKED| queued')),
    /to edge names state 'BLOCKED' but targets state 'QUEUED'/,
  );
  assert.throws(
    () => parseGraphV2(source.replace('retry -->|emit: task.retried| retried', 'retry -->|emit: task.other| retried')),
    /emit edge names event 'task.other' but targets emit 'task.retried'/,
  );
});
