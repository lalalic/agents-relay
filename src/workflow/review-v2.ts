import { readFileSync } from 'node:fs';
import { GraphRuntime, type GraphDecision } from './graph-v2.js';
import type { ReviewOutcome } from '../types.js';

export type ReviewGraphState = 'NONE' | 'PENDING' | 'STARTED' | 'APPROVED' | 'CHANGES_REQUIRED' | 'BLOCKED' | 'STALE';
export type ReviewGraphAction = 'review.create' | 'review.cancelStale' | 'review.createFix' | 'review.requestMerge';

const source = readFileSync(new URL('../../workflow/review-lifecycle-v2.mmd', import.meta.url), 'utf8');
const boolGuard = (name: string) => (facts: { readonly durableFacts: Readonly<Record<string, unknown>> }) => facts.durableFacts[name] === true;

export const reviewLifecycleV2 = new GraphRuntime(source, {
  states: new Set<ReviewGraphState>(['NONE','PENDING','STARTED','APPROVED','CHANGES_REQUIRED','BLOCKED','STALE']),
  guards: {
    reviewEligible: boolGuard('reviewEligible'),
    autoMerge: boolGuard('autoMerge'),
  },
  actions: Object.fromEntries((['review.create','review.cancelStale','review.createFix','review.requestMerge'] as ReviewGraphAction[]).map(id => [id,{id}])),
  events: Object.fromEntries(['reconcile','review.started','review.approved','review.changes_required','review.blocked','head.changed'].map(id => [id,{id}])),
});

export function reviewGraphState(outcome: ReviewOutcome | undefined): ReviewGraphState {
  if (!outcome) return 'NONE';
  return outcome.toUpperCase() as ReviewGraphState;
}

export function reviewOutcome(state: string): ReviewOutcome | undefined {
  if (state === 'NONE') return undefined;
  if (!['PENDING','STARTED','APPROVED','CHANGES_REQUIRED','BLOCKED','STALE'].includes(state)) {
    throw new Error('Unknown review graph state ' + state);
  }
  return state.toLowerCase() as ReviewOutcome;
}

export function decideReviewLifecycle(
  outcome: ReviewOutcome | undefined,
  event: string,
  facts: Readonly<Record<string, unknown>> = {},
): GraphDecision {
  return reviewLifecycleV2.evaluateSync({
    currentState: reviewGraphState(outcome),
    input: { transport: 'event', id: event, payload: {} },
    durableFacts: facts,
  });
}
