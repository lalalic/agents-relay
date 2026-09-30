import { GraphDispatcher, type ActionReceipt, type GraphDecision, type GraphInput, type GraphRuntime } from './graph-v2.js';

export type WorkflowDispatchOptions = {
  initialState: string;
  input: GraphInput;
  durableFacts?: Readonly<Record<string, unknown>>;
  isTransientState?: (state: string) => boolean;
  executeAction?: (actionId: string) => ActionReceipt | Promise<ActionReceipt>;
  persistTransition?: (source: string, target: string) => void | Promise<void>;
  publishEvent?: (id: string, payload: unknown) => void | Promise<void>;
  maxSteps?: number;
};

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
      executeAction: options.executeAction ? async actionId => await options.executeAction!(actionId) : undefined,
      publishEvent: async event => { await options.publishEvent?.(event.id, event.payload); },
    });
    const result = await dispatcher.dispatch({
      currentState: current,
      input: options.input,
      durableFacts: options.durableFacts ?? {},
    });
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
  await options.persistTransition(options.currentState, options.targetState);
}
