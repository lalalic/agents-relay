import { readFileSync } from 'node:fs';
import { GraphRuntime, type GraphDecision } from './graph-v2.js';

export type ScheduleCycleState = 'idle' | 'check_satisfied' | 'waiting' | 'finished';

const source = readFileSync(new URL('../../workflow/schedule-cycle-v2.mmd', import.meta.url), 'utf8');
const boolGuard = (name: string) => (facts: { readonly durableFacts: Readonly<Record<string, unknown>> }) => facts.durableFacts[name] === true;

export const scheduleCycleV2 = new GraphRuntime(source, {
  states: new Set<ScheduleCycleState>(['idle','check_satisfied','waiting','finished']),
  guards: {
    hasCurrentSlot: boolGuard('hasCurrentSlot'),
    plannerSatisfied: boolGuard('plannerSatisfied'),
  },
  actions: { 'schedule.finishSlot': { id: 'schedule.finishSlot' } },
  events: { 'schedule.reconcile': { id: 'schedule.reconcile' } },
});

export function decideScheduleCycle(facts: Readonly<Record<string, unknown>>): GraphDecision {
  let current: ScheduleCycleState = 'idle';
  for (let step=0; step<2; step+=1) {
    const decision = scheduleCycleV2.evaluateSync({
      currentState: current,
      input: { transport: 'event', id: 'schedule.reconcile', payload: {} },
      durableFacts: facts,
    });
    if (!decision.accepted) return decision;
    const target = decision.target as ScheduleCycleState;
    if (!target.startsWith('check_')) return decision;
    current = target;
  }
  return { accepted:false, source:current, reason:'no_transition' };
}
