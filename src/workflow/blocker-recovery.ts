import { readFileSync } from 'node:fs';
import { GraphRuntime, type ActionReceipt, type GraphDecision } from './graph-v2.js';
import { dispatchWorkflowGraph } from './dispatcher.js';

const source = readFileSync(new URL('../../workflow/blocker-recovery.mmd', import.meta.url), 'utf8');

export const blockerRecoveryGraph = new GraphRuntime(source, {
  states: new Set(['entry', 'check_authorization', 'check_known_request', 'check_dependency', 'validate_adoption', 'validate_target', 'validate_trust_boundary', 'register', 'ready', 'rejected']),
  guards: {
    authorized: facts => facts.durableFacts.authorized === true,
    knownRequest: facts => facts.durableFacts.knownRequest === true,
    authoritativeDependency: facts => facts.durableFacts.authoritativeDependency === true,
    adoptionValid: facts => facts.durableFacts.adoptionValid === true,
    targetValid: facts => facts.durableFacts.targetValid === true,
    trustBoundaryValid: facts => facts.durableFacts.trustBoundaryValid === true,
  },
  actions: Object.fromEntries([
    'recovery.createBlocker',
    'recovery.adoptExistingBlocker',
    'recovery.registerDependency',
  ].map(id => [id, { id }])),
  events: { 'blocker.recovery.ensure': { id: 'blocker.recovery.ensure' } },
});

export async function dispatchBlockerRecovery(
  facts: Readonly<Record<string, boolean>>,
  executeAction: (actionId: string) => ActionReceipt | Promise<ActionReceipt>,
): Promise<GraphDecision> {
  return dispatchWorkflowGraph(blockerRecoveryGraph, {
    initialState: 'entry',
    input: { transport: 'event', id: 'blocker.recovery.ensure', payload: {} },
    durableFacts: facts,
    isTransientState: state => state.startsWith('check_') || state.startsWith('validate_') || state === 'register',
    graphName: 'blocker-recovery',
    maxSteps: 16,
    executeAction,
  });
}
