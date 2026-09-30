import { readFileSync } from 'node:fs';
import { GraphRuntime, type GraphDecision } from './graph-v2.js';
import { dispatchWorkflowGraphSync } from './dispatcher.js';

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

export function dispatchScheduleCycle(facts: Readonly<Record<string, unknown>>, onFinish:()=>void): GraphDecision {
  return dispatchWorkflowGraphSync(scheduleCycleV2, {
    initialState:'idle', input:{transport:'event',id:'schedule.reconcile',payload:{}}, durableFacts:facts,
    isTransientState:state=>state.startsWith('check_'), maxSteps:2,
    executeAction:actionId=>{ if(actionId==='schedule.finishSlot') onFinish(); else throw new Error('Unsupported schedule cycle action '+actionId); return {}; },
  });
}
export function decideScheduleCycle(facts: Readonly<Record<string, unknown>>): GraphDecision { return dispatchScheduleCycle(facts,()=>{}); }
