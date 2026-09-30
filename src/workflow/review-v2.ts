import { readFileSync } from 'node:fs';
import { GraphRuntime, type GraphDecision, type ActionReceipt } from './graph-v2.js';
import { dispatchWorkflowGraph, dispatchWorkflowGraphSync } from './dispatcher.js';
import type { ReviewOutcome } from '../types.js';

export type ReviewGraphState = 'NONE' | 'PENDING' | 'STARTED' | 'APPROVED' | 'CHANGES_REQUIRED' | 'BLOCKED' | 'STALE';
export type ReviewGraphAction = 'review.create' | 'review.cancelStale' | 'review.createFix' | 'review.requestMerge';

const source = readFileSync(new URL('../../workflow/review-lifecycle-v2.mmd', import.meta.url), 'utf8');
const boolGuard = (name: string) => (facts: { readonly durableFacts: Readonly<Record<string, unknown>> }) => facts.durableFacts[name] === true;

export const reviewLifecycleV2 = new GraphRuntime(source, {
  states: new Set<ReviewGraphState>(['NONE','PENDING','STARTED','APPROVED','CHANGES_REQUIRED','BLOCKED','STALE']),
  guards: {
    unscheduled: boolGuard('unscheduled'),
    reviewEnabled: boolGuard('reviewEnabled'),
    prOpen: boolGuard('prOpen'),
    jobActive: boolGuard('jobActive'),
    implementationComplete: boolGuard('implementationComplete'),
    headAvailable: boolGuard('headAvailable'),
    completionGateSatisfied: boolGuard('completionGateSatisfied'),
    noActiveReviewTask: boolGuard('noActiveReviewTask'),
    currentReviewCancelled: boolGuard('currentReviewCancelled'),
    noApprovedCurrentReview: boolGuard('noApprovedCurrentReview'),
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

export async function dispatchReviewLifecycle(
  outcome: ReviewOutcome | undefined,
  event: string,
  facts: Readonly<Record<string, unknown>> = {},
  executeAction?: (actionId:string)=>ActionReceipt|Promise<ActionReceipt>,
): Promise<GraphDecision> {
  return dispatchWorkflowGraph(reviewLifecycleV2,{initialState:reviewGraphState(outcome),input:{transport:'event',id:event,payload:{}},durableFacts:facts,executeAction});
}
export function decideReviewLifecycle(outcome: ReviewOutcome | undefined,event:string,facts:Readonly<Record<string,unknown>>={}):GraphDecision{
  return dispatchWorkflowGraphSync(reviewLifecycleV2,{initialState:reviewGraphState(outcome),input:{transport:'event',id:event,payload:{}},durableFacts:facts});
}
