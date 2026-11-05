import { readFileSync } from 'node:fs';
import { GraphRuntime, type ActionReceipt, type GraphDecision } from './graph-v2.js';
import { dispatchWorkflowGraph, dispatchWorkflowGraphSync } from './dispatcher.js';

export type RevisionGraphState = 'NONE' | 'REQUESTED' | 'QUEUED' | 'RUNNING' | 'VERIFIED' | 'FAILED' | 'STALE';
export type RevisionGraphAction =
  | 'revision.recordRequest' | 'revision.queueTask' | 'revision.recordVerified'
  | 'revision.recordFailed' | 'revision.markStale';

const source = readFileSync(new URL('../../workflow/revision-lifecycle.mmd', import.meta.url), 'utf8');
const boolGuard = (name: string) => (context: { readonly durableFacts: Readonly<Record<string, unknown>> }) => context.durableFacts[name] === true;
export const revisionLifecycle = new GraphRuntime(source, {
  states: new Set<RevisionGraphState>(['NONE', 'REQUESTED', 'QUEUED', 'RUNNING', 'VERIFIED', 'FAILED', 'STALE']),
  guards: {
    reviewerAuthorized: boolGuard('reviewerAuthorized'),
    reviewHeadCurrent: boolGuard('reviewHeadCurrent'),
    originalTaskSucceeded: boolGuard('originalTaskSucceeded'),
    changesRequiredRecorded: boolGuard('changesRequiredRecorded'),
    taskRetryQueued: boolGuard('taskRetryQueued'),
  },
  actions: Object.fromEntries(([
    'revision.recordRequest', 'revision.queueTask', 'revision.recordVerified',
    'revision.recordFailed', 'revision.markStale',
  ] as RevisionGraphAction[]).map(id => [id, { id }])),
  events: Object.fromEntries([
    'revision.submit', 'revision.queue', 'revision.started', 'revision.verified',
    'revision.failed', 'revision.retry', 'review.head_changed',
  ].map(id => [id, { id }])),
});

function args(state: RevisionGraphState, event: string, facts: Readonly<Record<string, unknown>>) {
  return { initialState: state, input: { transport: 'event' as const, id: event, payload: {} }, durableFacts: facts, graphName: 'revision-lifecycle' };
}
export function decideRevisionLifecycle(state: RevisionGraphState, event: string, facts: Readonly<Record<string, unknown>> = {}): GraphDecision {
  return dispatchWorkflowGraphSync(revisionLifecycle, args(state, event, facts));
}
export async function dispatchRevisionLifecycle(
  state: RevisionGraphState, event: string, facts: Readonly<Record<string, unknown>> = {},
  executeAction?: (actionId: string) => ActionReceipt | Promise<ActionReceipt>,
): Promise<GraphDecision> {
  return dispatchWorkflowGraph(revisionLifecycle, { ...args(state, event, facts), executeAction });
}
