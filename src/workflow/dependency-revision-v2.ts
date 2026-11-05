import { readFileSync } from 'node:fs';
import { GraphRuntime, type GraphDecision } from './graph-v2.js';
import { dispatchWorkflowGraphSync } from './dispatcher.js';

const boolGuard = (key: string) => (context: { readonly durableFacts: Readonly<Record<string, unknown>> }) => context.durableFacts[key] === true;
export const dependencyRevisionLifecycle = new GraphRuntime(readFileSync(new URL('../../workflow/dependency-revision.mmd', import.meta.url), 'utf8'), {
  states: new Set(['NONE', 'PROPOSED', 'VERIFIED', 'STALE']),
  guards: Object.fromEntries(['upstreamEvidenceChanged', 'explicitValidityPolicy', 'allInputsSettled', 'notAlreadyRecorded', 'rerunRequired'].map(key => [key, boolGuard(key)])),
  actions: { 'dependencyRevision.createRerun': { id: 'dependencyRevision.createRerun' }, 'dependencyRevision.createRevalidation': { id: 'dependencyRevision.createRevalidation' }, 'dependencyRevision.markStale': { id: 'dependencyRevision.markStale' } },
  events: { 'dependency.reconcile': { id: 'dependency.reconcile' }, 'dependency.verified': { id: 'dependency.verified' }, 'dependency.stale': { id: 'dependency.stale' } },
});

export function decideDependencyRevision(event: string, facts: Readonly<Record<string, unknown>> = {}, state: 'NONE' | 'PROPOSED' = 'NONE'): GraphDecision {
  return dispatchWorkflowGraphSync(dependencyRevisionLifecycle, {
    graphName: 'dependency-revision', initialState: state,
    input: { transport: 'event', id: event, payload: {} }, durableFacts: facts,
  });
}
