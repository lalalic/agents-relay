import { readFileSync } from 'node:fs';
import { GraphRuntime, type GraphDecision } from './graph-v2.js';
import { dispatchWorkflowGraphSync } from './dispatcher.js';

export type PlannerTriggerGraphState = 'idle' | 'check_unblock' | 'check_schedule' | 'check_initial' | 'manual' | 'unblock' | 'schedule' | 'initial' | 'continuation';

const source = readFileSync(new URL('../../workflow/planner-trigger.mmd', import.meta.url), 'utf8');
const boolGuard = (name: string) => (facts: { readonly durableFacts: Readonly<Record<string, unknown>> }) => facts.durableFacts[name] === true;

export const plannerTriggerV2 = new GraphRuntime(source, {
  states: new Set<PlannerTriggerGraphState>(['idle','check_unblock','check_schedule','check_initial','manual','unblock','schedule','initial','continuation']),
  guards: {
    manualPlan: boolGuard('manualPlan'),
    hasUnblock: boolGuard('hasUnblock'),
    scheduledRun: boolGuard('scheduledRun'),
    initialPlan: boolGuard('initialPlan'),
  },
  actions: {},
  events: { 'plan.requested': { id: 'plan.requested' } },
});

export function dispatchPlannerTrigger(facts: Readonly<Record<string, unknown>>): GraphDecision {
  return dispatchWorkflowGraphSync(plannerTriggerV2, {
    initialState: 'idle', input: { transport: 'event', id: 'plan.requested', payload: {} }, durableFacts: facts,
    isTransientState: state => state.startsWith('check_'), maxSteps: 4,
  });
}

/** Compatibility/testing alias. Production callers use dispatchPlannerTrigger. */
export const decidePlannerTrigger = dispatchPlannerTrigger;
