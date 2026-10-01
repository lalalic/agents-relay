import { readFileSync } from 'node:fs';
import { GraphRuntime, type GraphDecision } from './graph-v2.js';
import { dispatchWorkflowGraphSync } from './dispatcher.js';

export type ProjectionConflictState = 'classify' | 'retry' | 'conflict';

const source = readFileSync(new URL('../../workflow/projection-conflict.mmd', import.meta.url), 'utf8');
const boolGuard = (name: string) => (facts: { readonly durableFacts: Readonly<Record<string, unknown>> }) => facts.durableFacts[name] === true;

export const projectionConflictV2 = new GraphRuntime(source, {
  states: new Set<ProjectionConflictState>(['classify', 'retry', 'conflict']),
  guards: { deterministicDefinitionConflict: boolGuard('deterministicDefinitionConflict') },
  actions: {},
  events: { 'projection.failed': { id: 'projection.failed' } },
});

/**
 * Core projection-failure disposition policy.
 *
 * A deterministic same-id/different-definition conflict stops consuming retry budget;
 * any other failure keeps the normal backoff/retry path. This branch is owned by the
 * canonical Mermaid graph, not by a procedural `if` in the projection writer.
 */
export function decideProjectionFailure(facts: Readonly<Record<string, unknown>>): GraphDecision {
  return dispatchWorkflowGraphSync(projectionConflictV2, {
    initialState: 'classify',
    input: { transport: 'event', id: 'projection.failed', payload: {} },
    durableFacts: facts,
    maxSteps: 1,
  });
}
