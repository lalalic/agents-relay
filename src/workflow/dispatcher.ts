import { GraphDispatcher, type ActionReceipt, type GraphDecision, type GraphInput, type GraphRuntime } from './graph-v2.js';
import { observability } from '../observability.js';
import { WorkflowActionLedger, type ActionIdentity } from './action-ledger.js';
import { ConditionRegistry, type ConditionFacts } from './conditions.js';

export type WorkflowDispatchOptions = {
  initialState: string;
  input: GraphInput;
  durableFacts?: Readonly<Record<string, unknown>>;
  graphName?: string;
  isTransientState?: (state: string) => boolean;
  executeAction?: (actionId: string) => ActionReceipt | Promise<ActionReceipt>;
  persistTransition?: (source: string, target: string) => void | Promise<void>;
  publishEvent?: (id: string, payload: unknown) => void | Promise<void>;
  maxSteps?: number;
  observe?: boolean;
  actionVerification?: {
    ledger: WorkflowActionLedger;
    conditions: ConditionRegistry;
    identity: (actionId: string) => ActionIdentity;
    conditionId: (actionId: string) => string;
    observedFacts: (actionId: string) => ConditionFacts | Promise<ConditionFacts>;
  };
};

/**
 * Record graph/decision identity and selected transition/action.
 *
 * `no_transition` is emitted at debug so normal idle watchdog cycles stay quiet;
 * accepted transitions and ambiguous paths are visible at info/warn.
 */
function observeDecision(graphName: string | undefined, input: GraphInput, decision: GraphDecision): void {
  if (decision.accepted) {
    const noOp = decision.source === decision.target && decision.actions.length === 0;
    observability().record({
      stage: 'graph',
      event: input.id,
      level: noOp ? 'debug' : undefined,
      outcome: noOp ? 'noop' : 'succeeded',
      message: noOp
        ? `Graph ${graphName ?? 'workflow'} accepted no-op ${decision.source} -> ${decision.target}`
        : `Graph ${graphName ?? 'workflow'} accepted ${decision.source} -> ${decision.target}`,
      transition: {
        graph: graphName ?? null,
        from: decision.source,
        to: decision.target,
        actions: decision.actions.map(action => action.id),
      },
      data: { transport: input.transport },
    });
    return;
  }
  if (decision.reason === 'ambiguous') {
    observability().record({
      stage: 'graph',
      event: input.id,
      level: 'warn',
      outcome: 'failed',
      message: `Graph ${graphName ?? 'workflow'} found ambiguous path from ${decision.source}`,
      transition: { graph: graphName ?? null, from: decision.source, to: null },
      data: { transport: input.transport, reason: decision.reason },
    });
    return;
  }
  observability().record({
    stage: 'graph',
    event: input.id,
    level: 'debug',
    outcome: 'noop',
    message: `Graph ${graphName ?? 'workflow'} has no transition from ${decision.source} on ${input.id}`,
    transition: { graph: graphName ?? null, from: decision.source, to: null },
    data: { transport: input.transport, reason: decision.reason },
  });
}

/**
 * The single production graph execution boundary.
 * Ingress adapters normalize input/facts, while GraphDispatcher alone evaluates,
 * persists graph transitions, executes graph-selected actions, and emits events.
 */
export async function dispatchWorkflowGraph(runtime: GraphRuntime, options: WorkflowDispatchOptions): Promise<GraphDecision> {
  let current = options.initialState;
  const maxSteps = options.maxSteps ?? 1;
  for (let step = 0; step < maxSteps; step += 1) {
    const dispatcher = new GraphDispatcher(runtime, {
      persistTransition: async transition => { await options.persistTransition?.(transition.source, transition.target); },
      executeAction: options.executeAction ? async actionId => {
        const verification = options.actionVerification;
        if (verification) {
          const identity = verification.identity(actionId);
          const decision = runtime.evaluateSync({ currentState: current, input: options.input, durableFacts: options.durableFacts ?? {} });
          if (!verification.ledger.reserve(identity, decision, verification.conditionId(actionId))) {
            throw new Error('action attempt already reserved: reconcile outcome; never repeat side effect');
          }
        }
        const receipt = await options.executeAction!(actionId);
        if (verification) {
          const identity = verification.identity(actionId);
          const trace = verification.ledger.verify(identity.attemptKey, verification.conditions, await verification.observedFacts(actionId));
          if (trace.outcome !== 'Verified') throw new Error('action postcondition '+trace.outcome+': reconciliation required');
        }
        return receipt;
      } : undefined,
      publishEvent: async event => { await options.publishEvent?.(event.id, event.payload); },
    });
    const result = await dispatcher.dispatch({
      currentState: current,
      input: options.input,
      durableFacts: options.durableFacts ?? {},
    });
    if (options.observe !== false) observeDecision(options.graphName, options.input, result.decision);
    if (!result.decision.accepted) return result.decision;
    current = result.decision.target;
    if (!options.isTransientState?.(current)) return result.decision;
  }
  return { accepted: false, source: current, reason: 'no_transition' };
}


export function dispatchWorkflowGraphSync(runtime: GraphRuntime, options: WorkflowDispatchOptions): GraphDecision {
  let current = options.initialState;
  const maxSteps = options.maxSteps ?? 1;
  for (let step = 0; step < maxSteps; step += 1) {
    const dispatcher = new GraphDispatcher(runtime, {
      persistTransition: transition => { const result = options.persistTransition?.(transition.source, transition.target); if (result instanceof Promise) throw new Error('sync workflow persistTransition returned Promise'); },
      executeAction: options.executeAction ? actionId => { const result = options.executeAction!(actionId); if (result instanceof Promise) throw new Error('sync workflow executeAction returned Promise'); return result; } : undefined,
      publishEvent: event => { const result = options.publishEvent?.(event.id, event.payload); if (result instanceof Promise) throw new Error('sync workflow publishEvent returned Promise'); },
    });
    const result = dispatcher.dispatchSync({ currentState: current, input: options.input, durableFacts: options.durableFacts ?? {} });
    if (options.observe !== false) observeDecision(options.graphName, options.input, result.decision);
    if (!result.decision.accepted) return result.decision;
    current = result.decision.target;
    if (!options.isTransientState?.(current)) return result.decision;
  }
  return { accepted: false, source: current, reason: 'no_transition' };
}

export async function dispatchWorkflowTargetOverride(
  runtime: GraphRuntime,
  options: {
    currentState: string;
    targetState: string;
    kind: string;
    persistTransition: (source: string, target: string) => void | Promise<void>;
  },
): Promise<void> {
  // Administrative correction still derives legality from the canonical Mermaid graph.
  // It intentionally executes no workflow actions/effects: this is a state repair, not an event replay.
  const { assertV2StateTransition } = await import('./definitions-v2.js');
  assertV2StateTransition(runtime.graph, options.currentState, options.targetState, options.kind);
  observability().record({
    stage: 'graph',
    event: 'target.override',
    outcome: 'succeeded',
    message: `Administrative ${options.kind} state repair ${options.currentState} -> ${options.targetState}`,
    transition: { graph: `${options.kind}.override`, from: options.currentState, to: options.targetState, actions: [] },
  });
  await options.persistTransition(options.currentState, options.targetState);
}
