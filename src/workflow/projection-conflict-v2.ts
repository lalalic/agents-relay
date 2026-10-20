import { readFileSync } from 'node:fs';
import { GraphRuntime, type GraphDecision } from './graph-v2.js';
import { dispatchWorkflowGraphSync } from './dispatcher.js';

export type ProjectionConflictState = 'classify' | 'repairing' | 'retry' | 'conflict' | 'escalated' | 'projected';

const source = readFileSync(new URL('../../workflow/projection-conflict.mmd', import.meta.url), 'utf8');
const boolGuard = (name: string) => (facts: { readonly durableFacts: Readonly<Record<string, unknown>> }) => facts.durableFacts[name] === true;
const guards = {
  deterministicDefinitionConflict: boolGuard('deterministicDefinitionConflict'),
  'projection.recoveryInProgress': boolGuard('recoveryInProgress'),
  'projection.recoveryEligible': (facts: { readonly durableFacts: Readonly<Record<string, unknown>> }) => {
    const values = facts.durableFacts;
    return values.jobState === 'COMPLETED' && values.mergeSucceeded === true
      && values.projectionStrategy === 'target_ref_push' && values.divergenceConfirmed === true
      && values.remoteShaAvailable === true
      && values.sameIdempotencyKey !== true && values.recoveryInProgress !== true
      && Number(values.attempts ?? 0) < Number(values.maxAttempts ?? 0);
  },
  'projection.recoveryExhausted': (facts: { readonly durableFacts: Readonly<Record<string, unknown>> }) => {
    const values = facts.durableFacts;
    return values.jobState === 'COMPLETED' && values.divergenceConfirmed === true && values.remoteShaAvailable === true
      && values.sameIdempotencyKey !== true && values.recoveryInProgress !== true
      && Number(values.attempts ?? 0) >= Number(values.maxAttempts ?? 0);
  },
  'projection.retryAvailable': (facts: { readonly durableFacts: Readonly<Record<string, unknown>> }) =>
    facts.durableFacts.taskRetryAvailable === true
      && Number(facts.durableFacts.attempts ?? 0) < Number(facts.durableFacts.maxAttempts ?? 0),
  'projection.repairReviewed': (facts: { readonly durableFacts: Readonly<Record<string, unknown>> }) =>
    facts.durableFacts.repairTaskState === 'SUCCEEDED' && facts.durableFacts.reviewOutcome === 'approved',
  'projection.repairFailed': (facts: { readonly durableFacts: Readonly<Record<string, unknown>> }) =>
    facts.durableFacts.repairTaskState === 'FAILED' || facts.durableFacts.repairTaskState === 'BLOCKED'
      || facts.durableFacts.reviewOutcome === 'blocked' || facts.durableFacts.reviewTaskState === 'FAILED',
};

export const projectionConflictV2 = new GraphRuntime(source, {
  states: new Set<ProjectionConflictState>(['classify', 'repairing', 'retry', 'conflict', 'escalated', 'projected']),
  guards,
  actions: Object.fromEntries(['projection.createRecoveryTask', 'effect.projectLocalMerge', 'projection.escalate'].map(id => [id, { id }])),
  events: Object.fromEntries(['projection.failed', 'projection.delivery_failed', 'projection.delivered', 'reconcile'].map(id => [id, { id }])),
});

/** The decision is graph-owned; callers supply SQLite and inspected Git facts. */
export function decideProjectionFailure(facts: Readonly<Record<string, unknown>>): GraphDecision {
  return dispatchWorkflowGraphSync(projectionConflictV2, {
    initialState: 'classify',
    input: { transport: 'event', id: 'projection.failed', payload: {} },
    durableFacts: facts,
    maxSteps: 1,
  });
}
