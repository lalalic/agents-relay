import { readFileSync } from 'node:fs';
import { GraphRuntime, type GraphDecision } from './graph-v2.js';
import { dispatchWorkflowGraph } from './dispatcher.js';

export type EscalationStatus = 'resolved' | 'failed' | 'needs_user';
export type EscalationResult = {
  status: EscalationStatus;
  summary: string;
  reason?: string | null;
  user_action?: string | null;
  evidence?: string[];
  notification?: {
    attempted: boolean;
    delivered?: boolean | null;
    channel?: string | null;
    details?: string | null;
  } | null;
};

export type EscalationRequest = {
  intent: string;
  blockedOn: string;
  context?: string;
  onNeedsUser?: string;
  cwd?: string;
};

export type EscalationOutcome = {
  state: 'resolved' | 'technical_failure' | 'needs_user';
  result: EscalationResult;
  requestDecision: GraphDecision;
  resultDecision: GraphDecision;
};

const source = readFileSync(new URL('../../workflow/escalation.mmd', import.meta.url), 'utf8');
const statusGuard = (status: EscalationStatus) =>
  (facts: { readonly durableFacts: Readonly<Record<string, unknown>> }): boolean =>
    facts.durableFacts.escalationStatus === status;

export const escalationGraph = new GraphRuntime(source, {
  states: new Set(['suspected_human_blocker', 'invoking', 'resolved', 'technical_failure', 'needs_user']),
  guards: {
    escalationResolved: statusGuard('resolved'),
    escalationFailed: statusGuard('failed'),
    escalationNeedsUser: statusGuard('needs_user'),
  },
  actions: {
    'escalation.invoke': { id: 'escalation.invoke' },
    'escalation.resume_recovery': { id: 'escalation.resume_recovery' },
    'escalation.technical_failure': { id: 'escalation.technical_failure' },
    'escalation.block_for_user': { id: 'escalation.block_for_user' },
  },
  events: {
    'escalation.requested': { id: 'escalation.requested' },
    'escalation.result': { id: 'escalation.result' },
  },
});

export async function runEscalationGraph(
  request: EscalationRequest,
  effects: {
    invoke: (request: EscalationRequest) => Promise<EscalationResult>;
    resumeRecovery?: (result: EscalationResult) => void | Promise<void>;
    technicalFailure?: (result: EscalationResult) => void | Promise<void>;
    blockForUser?: (result: EscalationResult) => void | Promise<void>;
  },
): Promise<EscalationOutcome> {
  let result: EscalationResult | null = null;
  const requestDecision = await dispatchWorkflowGraph(escalationGraph, {
    initialState: 'suspected_human_blocker',
    input: { transport: 'event', id: 'escalation.requested', payload: {} },
    graphName: 'escalation',
    executeAction: async actionId => {
      if (actionId !== 'escalation.invoke') throw new Error(`Unexpected escalation request action ${actionId}`);
      result = await effects.invoke(request);
      return {};
    },
  });
  if (!requestDecision.accepted || requestDecision.target !== 'invoking' || !result) {
    throw new Error('Escalation graph did not invoke the escalation executor');
  }

  const escalationResult = result as EscalationResult;
  const resultDecision = await dispatchWorkflowGraph(escalationGraph, {
    initialState: 'invoking',
    input: { transport: 'event', id: 'escalation.result', payload: {} },
    durableFacts: { escalationStatus: escalationResult.status },
    graphName: 'escalation',
    executeAction: async actionId => {
      if (actionId === 'escalation.resume_recovery') await effects.resumeRecovery?.(escalationResult);
      else if (actionId === 'escalation.technical_failure') await effects.technicalFailure?.(escalationResult);
      else if (actionId === 'escalation.block_for_user') await effects.blockForUser?.(escalationResult);
      else throw new Error(`Unexpected escalation result action ${actionId}`);
      return {};
    },
  });
  if (!resultDecision.accepted) throw new Error(`Escalation graph rejected result ${escalationResult.status}`);
  if (!['resolved', 'technical_failure', 'needs_user'].includes(resultDecision.target)) {
    throw new Error(`Escalation graph returned unexpected state ${resultDecision.target}`);
  }
  return {
    state: resultDecision.target as EscalationOutcome['state'],
    result: escalationResult,
    requestDecision,
    resultDecision,
  };
}
