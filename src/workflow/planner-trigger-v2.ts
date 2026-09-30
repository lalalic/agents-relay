import { readFileSync } from 'node:fs';
import { GraphRuntime, type GraphDecision } from './graph-v2.js';

export type PlannerTriggerGraphState = 'idle' | 'check_unblock' | 'check_schedule' | 'check_initial' | 'manual' | 'unblock' | 'schedule' | 'initial' | 'continuation';

const source = readFileSync(new URL('../../workflow/planner-trigger-v2.mmd', import.meta.url), 'utf8');
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

export function decidePlannerTrigger(facts: Readonly<Record<string, unknown>>): GraphDecision {
  let current: PlannerTriggerGraphState = 'idle';
  for (let step = 0; step < 4; step += 1) {
    const decision = plannerTriggerV2.evaluateSync({
      currentState: current,
      input: { transport: 'event', id: 'plan.requested', payload: {} },
      durableFacts: facts,
    });
    if (!decision.accepted) return decision;
    const target = decision.target as PlannerTriggerGraphState;
    if (!target.startsWith('check_')) return decision;
    current = target;
  }
  return { accepted: false, source: current, reason: 'no_transition' };
}
