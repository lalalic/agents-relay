import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { GraphRuntime, parseGraphV2 } from '../dist/workflow/graph-v2.js';

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
  assert.deepEqual(decision, { accepted: true, source: 'FAILED', target: 'QUEUED', action: { id: 'task.retry', input }, emittedEvents: ['task.retried'] });
  assert.equal(runtime.evaluateSync({ currentState: 'FAILED', input, durableFacts: { retryable: false } }).target, 'BLOCKED');
});

test('v2 parser reports stable line diagnostics and rejects unsupported syntax', () => {
  assert.throws(() => parseGraphV2('flowchart TD\n%% relay: initial A\nA{"state: A"}'), /line 3: unsupported syntax/);
  assert.throws(() => parseGraphV2('flowchart TD\n%% relay: initial A\nA["state: A"]\nA -->|on: go| missing'), /line 4: edge target 'missing' is not declared/);
  assert.throws(() => parseGraphV2('flowchart TD\n%% relay: initial A\nA["state: A"]\nB["state: B"]\nA -->|on: go| A'), /state 'B' is unreachable/);
});

test('v2 registry binding rejects unknown semantic names and invalid payloads', () => {
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

test('v2 dispatcher executes the registered action and validates emitted payloads in edge order', async () => {
  const order = [];
  const runtime = new GraphRuntime(source, {
    ...registries,
    actions: { 'task.retry': { id: 'task.retry', execute: () => ({ payloads: { 'task.retried': { ok: true } } }) } },
    events: { ...registries.events, 'task.retried': { id: 'task.retried', validate: payload => (order.push('validated'), payload?.ok === true) } },
  });
  const result = await runtime.dispatch({ currentState: 'FAILED', input: { transport: 'event', id: 'task.retry', payload: {} }, durableFacts: { retryable: true } });
  assert.equal(result.receipt?.payloads?.['task.retried']?.ok, true);
  assert.deepEqual(order, ['validated']);
});
