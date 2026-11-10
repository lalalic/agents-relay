import { readFileSync } from 'node:fs';
import { GraphRuntime, type GraphDecision } from './graph-v2.js';
import { dispatchWorkflowGraphSync } from './dispatcher.js';

export type PlannerTriggerGraphState = 'idle' | 'check_unblock' | 'check_initial' | 'check_review' | 'manual' | 'unblock' | 'initial' | 'review' | 'continuation';

const source = readFileSync(new URL('../../workflow/planner-trigger.mmd', import.meta.url), 'utf8');
const boolGuard = (name: string) => (facts: { readonly durableFacts: Readonly<Record<string, unknown>> }) => facts.durableFacts[name] === true;

export const plannerTriggerV2 = new GraphRuntime(source, {
  states: new Set<PlannerTriggerGraphState>(['idle','check_unblock','check_initial','check_review','manual','unblock','initial','review','continuation']),
  guards: {
    manualPlan: boolGuard('manualPlan'),
    hasUnblock: boolGuard('hasUnblock'),
    initialPlan: boolGuard('initialPlan'),
    reviewRequired: boolGuard('reviewRequired'),
  },
  actions: {},
  events: { 'plan.requested': { id: 'plan.requested' } },
});

export function dispatchPlannerTrigger(facts: Readonly<Record<string, unknown>>): GraphDecision {
  return dispatchWorkflowGraphSync(plannerTriggerV2, {
    initialState: 'idle', input: { transport: 'event', id: 'plan.requested', payload: {} }, durableFacts: facts, graphName: 'planner-trigger',
    isTransientState: state => state.startsWith('check_'), maxSteps: 5,
  });
}

/** Compatibility/testing alias. Production callers use dispatchPlannerTrigger. */
export const decidePlannerTrigger = dispatchPlannerTrigger;
