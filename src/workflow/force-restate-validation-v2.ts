import { readFileSync } from 'node:fs';
import { GraphRuntime, type GraphDecision } from './graph-v2.js';
import { dispatchWorkflowGraphSync } from './dispatcher.js';

const source = readFileSync(new URL('../../workflow/force-restate-validation.mmd', import.meta.url), 'utf8');
export const forceRestateValidationV2 = new GraphRuntime(source, {
  states: new Set(['idle', 'check_history_mode', 'check_history', 'check_normal_history', 'check_forward', 'rejected', 'committed']),
  guards: {
    forceRestateRequested: facts => facts.durableFacts.forceRestateRequested === true,
    historyConsistencyValid: facts => facts.durableFacts.historyConsistencyValid === true,
    normalHistoryMutationAbsent: facts => facts.durableFacts.normalHistoryMutationAbsent === true,
    forwardConvergenceValid: facts => facts.durableFacts.forwardConvergenceValid === true,
  },
  actions: {
    'plan.apply.commit': { id: 'plan.apply.commit' },
    'plan.apply.rejectHistory': { id: 'plan.apply.rejectHistory' },
    'plan.apply.rejectForward': { id: 'plan.apply.rejectForward' },
  },
  events: { 'plan.apply': { id: 'plan.apply' } },
});

export function decideForceRestateValidation(facts: Readonly<Record<string, unknown>>): GraphDecision {
  return dispatchWorkflowGraphSync(forceRestateValidationV2, {
    initialState: 'idle', input: { transport: 'event', id: 'plan.apply', payload: {} }, durableFacts: facts,
    graphName: 'force-restate-validation',
    isTransientState: state => state.startsWith('check_'), maxSteps: 12,
  });
}
