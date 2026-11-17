import { readFileSync } from 'node:fs';
import { GraphRuntime, type GraphDecision } from './graph-v2.js';
import { dispatchWorkflowGraphSync } from './dispatcher.js';

export type ProjectionConflictState = 'classify' | 'inspect' | 'push' | 'waiting' | 'delivered' | 'skipped' | 'exhausted';

const source = readFileSync(new URL('../../workflow/projection-conflict.mmd', import.meta.url), 'utf8');
const boolGuard = (name: string) => (facts: { readonly durableFacts: Readonly<Record<string, unknown>> }) => facts.durableFacts[name] === true;
const guards = {
  'delivery.originUsable': boolGuard('originUsable'),
  'delivery.claimAvailable': boolGuard('claimAvailable'),
  'delivery.remoteMainPresent': boolGuard('remoteMainPresent'),
  'delivery.remoteContainsMain': boolGuard('remoteContainsMain'),
  'delivery.retryDue': boolGuard('retryDue'),
  'delivery.retryAvailable': (facts: { readonly durableFacts: Readonly<Record<string, unknown>> }) =>
    Number(facts.durableFacts.attempts ?? 0) < Number(facts.durableFacts.maxAttempts ?? 0),
};

export const projectionConflictV2 = new GraphRuntime(source, {
  states: new Set<ProjectionConflictState>(['classify', 'inspect', 'push', 'waiting', 'delivered', 'skipped', 'exhausted']),
  guards,
  actions: Object.fromEntries(['delivery.claimInspection', 'delivery.skip', 'delivery.pushMain', 'delivery.recordDelivered', 'delivery.scheduleRetry', 'delivery.recordExhausted'].map(id => [id, { id }])),
  events: Object.fromEntries(['job.completed', 'inspect.completed', 'delivery.pushed', 'delivery.failed', 'delivery.retry_due'].map(id => [id, { id }])),
});

// A separate Graph preserves historical SQLite projection-outbox conflict
// classification without confusing it with optional post-COMPLETED Git delivery.
const outboxSource = readFileSync(new URL('../../workflow/projection-outbox-conflict.mmd', import.meta.url), 'utf8');
export const projectionOutboxConflictV2 = new GraphRuntime(outboxSource, {
  states: new Set(['classify', 'conflict', 'retry']),
  guards: { deterministicDefinitionConflict: boolGuard('deterministicDefinitionConflict') },
  actions: {},
  events: { 'projection.failed': { id: 'projection.failed' } },
});

/** Graph-owned historical outbox classification; no Job lifecycle mutation. */
export function decideProjectionFailure(facts: Readonly<Record<string, unknown>>): GraphDecision {
  return dispatchWorkflowGraphSync(projectionOutboxConflictV2, {
    initialState: 'classify',
    input: { transport: 'event', id: 'projection.failed', payload: {} },
    durableFacts: facts,
    graphName: 'projection-outbox-conflict',
    maxSteps: 1,
  });
}

export function decideProjectionDelivery(state: ProjectionConflictState, event: string, facts: Readonly<Record<string, unknown>>): GraphDecision {
  return dispatchWorkflowGraphSync(projectionConflictV2, {
    initialState: state,
    input: { transport: 'event', id: event, payload: {} },
    durableFacts: facts,
    graphName: 'projection-conflict',
    maxSteps: 1,
  });
}
