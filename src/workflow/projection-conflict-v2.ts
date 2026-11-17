import { readFileSync } from 'node:fs';
import { GraphRuntime, type GraphDecision } from './graph-v2.js';
import { dispatchWorkflowGraphSync } from './dispatcher.js';

export type ProjectionConflictState = 'classify' | 'inspect' | 'push' | 'waiting' | 'delivered' | 'skipped' | 'exhausted';

const source = readFileSync(new URL('../../workflow/projection-conflict.mmd', import.meta.url), 'utf8');
const boolGuard = (name: string) => (facts: { readonly durableFacts: Readonly<Record<string, unknown>> }) => facts.durableFacts[name] === true;
const guards = {
  'delivery.originUsable': boolGuard('originUsable'),
  'delivery.remoteContainsMain': boolGuard('remoteContainsMain'),
  'delivery.retryDue': boolGuard('retryDue'),
  'delivery.retryAvailable': (facts: { readonly durableFacts: Readonly<Record<string, unknown>> }) =>
    Number(facts.durableFacts.attempts ?? 0) < Number(facts.durableFacts.maxAttempts ?? 0),
};

export const projectionConflictV2 = new GraphRuntime(source, {
  states: new Set<ProjectionConflictState>(['classify', 'inspect', 'push', 'waiting', 'delivered', 'skipped', 'exhausted']),
  guards,
  actions: Object.fromEntries(['delivery.skip', 'delivery.pushMain', 'delivery.recordDelivered', 'delivery.scheduleRetry', 'delivery.recordExhausted'].map(id => [id, { id }])),
  events: Object.fromEntries(['job.completed', 'inspect.completed', 'delivery.pushed', 'delivery.failed', 'delivery.retry_due'].map(id => [id, { id }])),
});

/** The decision is graph-owned; callers supply SQLite and inspected Git facts. */
export function decideProjectionFailure(facts: Readonly<Record<string, unknown>>): GraphDecision {
  return dispatchWorkflowGraphSync(projectionConflictV2, {
    initialState: 'classify',
    input: { transport: 'event', id: 'job.completed', payload: {} },
    durableFacts: facts,
    maxSteps: 1,
  });
}
