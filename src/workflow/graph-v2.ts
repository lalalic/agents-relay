/** Strict, executable Mermaid flowchart profile for the incremental v2 graph runtime. */

export type GraphTransport = 'event' | 'action';
export type SemanticKind = 'state' | 'guard' | 'action' | 'emit';
export type GraphInput<Payload = unknown> = { readonly transport: GraphTransport; readonly id: string; readonly payload: Payload };
export type GraphFacts<Payload = unknown> = { readonly currentState: string; readonly input: GraphInput<Payload>; readonly durableFacts: Readonly<Record<string, unknown>> };

export type GraphNode = { readonly id: string; readonly kind: SemanticKind; readonly semanticId: string; readonly line: number };
export type GraphEdgeKind = 'on' | 'request' | 'true' | 'false' | 'to' | 'emit' | 'unlabelled';
export type GraphEdge = { readonly from: string; readonly to: string; readonly kind: GraphEdgeKind; readonly semanticId: string | null; readonly line: number };
export type Graph = { readonly source: string; readonly direction: 'LR' | 'RL' | 'TD' | 'TB'; readonly nodes: ReadonlyMap<string, GraphNode>; readonly edges: readonly GraphEdge[]; readonly initial: string };

export type PayloadValidator<Payload = unknown> = (payload: unknown) => payload is Payload;
export type EventDefinition<Payload = unknown> = { readonly id: string; readonly validate?: PayloadValidator<Payload> };
export type ActionReceipt =
  | { readonly ok?: true; readonly payloads?: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly failureEvent: { readonly id: string; readonly payload: unknown } };
export type ActionContext<Payload = unknown> = { readonly facts: GraphFacts<Payload>; readonly actionId: string; readonly input: GraphInput<Payload> };
export type ActionDefinition<Payload = unknown> = { readonly id: string; readonly validate?: PayloadValidator<Payload>; readonly execute?: (context: ActionContext<Payload>) => ActionReceipt | Promise<ActionReceipt> };
export type Guard = (facts: GraphFacts) => boolean | Promise<boolean>;
export type GraphRegistries = {
  readonly states?: ReadonlySet<string>;
  readonly guards?: ReadonlyMap<string, Guard> | Readonly<Record<string, Guard>>;
  readonly actions?: ReadonlyMap<string, ActionDefinition> | Readonly<Record<string, ActionDefinition>>;
  readonly events?: ReadonlyMap<string, EventDefinition> | Readonly<Record<string, EventDefinition>>;
};

export type GraphActionDecision = { readonly id: string; readonly input: GraphInput; readonly emittedEvents: readonly string[] };
export type GraphDecision = {
  readonly accepted: true;
  readonly source: string;
  readonly target: string;
  readonly actions: readonly GraphActionDecision[];
} | { readonly accepted: false; readonly source: string; readonly reason: 'no_transition' | 'ambiguous' | 'invalid_input' };
export type GraphDispatchResult = { readonly decision: GraphDecision; readonly receipts: readonly ActionReceipt[] };
export type GraphTransition = { readonly source: string; readonly target: string };
export type GraphEvent = { readonly id: string; readonly payload: unknown };
export type GraphDispatcherPorts = {
  readonly persistTransition: (transition: GraphTransition) => void | Promise<void>;
  readonly executeAction?: (actionId: string, context: ActionContext) => ActionReceipt | Promise<ActionReceipt>;
  readonly publishEvent: (event: GraphEvent) => void | Promise<void>;
};

const IDENTIFIER = '[A-Za-z_][A-Za-z0-9_.-]*';
const NODE = new RegExp(`^(${IDENTIFIER})\\["(state|guard|action|emit):\\s*([^|\\]"]+?)(?:\\s*\\|[^\\]"]*)?"\\]$`);
const EDGE = new RegExp(`^(${IDENTIFIER})\\s+-->\\s*(?:\\|\\s*([^|]+?)\\s*\\|\\s*)?(${IDENTIFIER})$`);
const HEADER = /^flowchart (LR|RL|TD|TB)$/;
const NAME = new RegExp(`^${IDENTIFIER}$`);

function fail(line: number, message: string): never { throw new Error(`line ${line}: ${message}`); }
function lookup<T>(value: ReadonlyMap<string, T> | Readonly<Record<string, T>> | undefined, id: string): T | undefined {
  return value instanceof Map ? value.get(id) : (value as Readonly<Record<string, T>> | undefined)?.[id];
}
function entries<T>(value: ReadonlyMap<string, T> | Readonly<Record<string, T>> | undefined): Iterable<readonly [string, T]> {
  return value instanceof Map ? value.entries() : Object.entries(value ?? {});
}

function parseLabel(raw: string | undefined, line: number): { kind: GraphEdgeKind; semanticId: string | null } {
  if (raw === undefined) return { kind: 'unlabelled', semanticId: null };
  const label = raw.trim();
  if (label === 'true' || label === 'false') return { kind: label, semanticId: null };
  const match = label.match(/^(on|request|to|emit):\s*(.*)$/);
  if (!match || !NAME.test(match[2])) fail(line, `unsupported edge label '${label}'`);
  return { kind: match[1] as GraphEdgeKind, semanticId: match[2] };
}

export function parseGraphV2(source: string): Graph {
  const lines = source.split(/\r?\n/);
  let direction: Graph['direction'] | null = null;
  let initial: string | null = null;
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index].trim();
    if (!line) continue;
    if (line.startsWith('%%')) {
      const directive = line.match(/^%%\s*relay:\s*initial\s+(.+)$/);
      if (directive) { if (initial) fail(lineNumber, 'duplicate initial declaration'); initial = directive[1].trim(); if (!NAME.test(initial)) fail(lineNumber, `invalid initial state '${initial}'`); }
      continue;
    }
    if (!direction) { const header = line.match(HEADER); if (!header) fail(lineNumber, 'expected flowchart LR, RL, TD, or TB'); direction = header[1] as Graph['direction']; continue; }
    const node = line.match(NODE);
    if (node) {
      if (nodes.has(node[1])) fail(lineNumber, `duplicate node '${node[1]}'`);
      const semanticId = node[3].trim();
      if (!NAME.test(semanticId)) fail(lineNumber, `invalid ${node[2]} identifier '${semanticId}'`);
      if (node[2] === 'state' && [...nodes.values()].some(candidate => candidate.kind === 'state' && candidate.semanticId === semanticId)) fail(lineNumber, `duplicate semantic declaration 'state: ${semanticId}'`);
      nodes.set(node[1], { id: node[1], kind: node[2] as SemanticKind, semanticId, line: lineNumber });
      continue;
    }
    const edge = line.match(EDGE);
    if (edge) { const label = parseLabel(edge[2], lineNumber); edges.push({ from: edge[1], to: edge[3], ...label, line: lineNumber }); continue; }
    const unsupportedShape = line.match(/[({<]/)?.[0];
    if (unsupportedShape) {
      const shape = unsupportedShape === '{' ? '{...}' : `${unsupportedShape}...`;
      fail(lineNumber, `unsupported node shape '${shape}'; expected '[\"...\"]'`);
    }
    fail(lineNumber, `unsupported syntax '${line}'`);
  }
  if (!direction) throw new Error('line 1: executable graph is empty; expected flowchart header');
  if (!initial) throw new Error('graph requires exactly one %% relay: initial STATE declaration');
  if (!nodes.has(initial) || nodes.get(initial)?.kind !== 'state') throw new Error(`initial state '${initial}' is not a declared state node`);
  if (![...nodes.values()].some(node => node.kind === 'state')) throw new Error('graph requires at least one state node');
  if (!edges.length) throw new Error('graph requires at least one executable edge');
  for (const edge of edges) {
    if (!nodes.has(edge.from)) fail(edge.line, `edge source '${edge.from}' is not declared`);
    if (!nodes.has(edge.to)) fail(edge.line, `edge target '${edge.to}' is not declared`);
  }
  validateTopology(nodes, edges, initial);
  return { source, direction, nodes, edges, initial };
}

function validateTopology(nodes: ReadonlyMap<string, GraphNode>, edges: readonly GraphEdge[], initial: string): void {
  const outgoing = new Map<string, GraphEdge[]>();
  for (const edge of edges) outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
  for (const node of nodes.values()) {
    const exits = outgoing.get(node.id) ?? [];
    if (node.kind === 'state') {
      for (const edge of exits) {
        if (edge.kind !== 'on' && edge.kind !== 'request') fail(edge.line, `state '${node.semanticId}' may only have on:/request: exits`);
        const target = nodes.get(edge.to)!;
        if (target.kind !== 'state' && target.kind !== 'guard' && target.kind !== 'action') fail(edge.line, `${edge.kind} edge must lead to a state, guard, or action`);
      }
      const groups = new Map<string, GraphEdge[]>();
      for (const edge of exits) {
        const key = `${edge.kind}\\0${edge.semanticId}`;
        groups.set(key, [...(groups.get(key) ?? []), edge]);
      }
      for (const group of groups.values()) {
        if (group.length < 2) continue;
        if (group.some(edge => nodes.get(edge.to)!.kind !== 'guard') || new Set(group.map(edge => edge.to)).size !== group.length) {
          const edge = group[1];
          fail(edge.line, `ambiguous input path for ${edge.kind} '${edge.semanticId}' from state '${node.semanticId}'`);
        }
      }
    } else if (node.kind === 'guard') {
      if (exits.length < 1 || exits.length > 2 || exits.some(edge => edge.kind !== 'true' && edge.kind !== 'false') || new Set(exits.map(edge => edge.kind)).size !== exits.length) fail(node.line, `guard '${node.semanticId}' requires one or two unique true/false exits`);
      for (const edge of exits) if (!['state','guard','action'].includes(nodes.get(edge.to)!.kind)) fail(edge.line, `guard edge '${edge.kind}' must lead to a state, guard, or action`);
    } else if (node.kind === 'action') {
      const continuations = exits.filter(edge => edge.kind === 'to' || edge.kind === 'unlabelled');
      if (continuations.length > 1) fail(node.line, `action '${node.semanticId}' has multiple continuations`);
      for (const edge of continuations) {
        const target = nodes.get(edge.to)!;
        if (edge.kind === 'to') {
          if (target.kind !== 'state') fail(edge.line, 'to: action continuation must target a state');
          if (edge.semanticId !== target.semanticId) fail(edge.line, `to edge names state '${edge.semanticId}' but targets state '${target.semanticId}'`);
        } else if (target.kind !== 'state' && target.kind !== 'action') fail(edge.line, 'unlabelled action continuation must lead to an action or state');
      }
      for (const edge of exits.filter(edge => edge.kind === 'emit')) {
        const target = nodes.get(edge.to)!;
        if (target.kind !== 'emit') fail(edge.line, 'emit edge must lead to an emit node');
        if (edge.semanticId !== target.semanticId) fail(edge.line, `emit edge names event '${edge.semanticId}' but targets emit '${target.semanticId}'`);
      }
      if (!continuations.length) fail(node.line, `action '${node.semanticId}' must have one continuation`);
    } else if (exits.length) fail(node.line, `emit node '${node.semanticId}' must not have outgoing edges`);
  }
  const reachable = new Set<string>([initial]);
  let changed = true;
  while (changed) { changed = false; for (const edge of edges) if (reachable.has(edge.from) && !reachable.has(edge.to)) { reachable.add(edge.to); changed = true; } }
  for (const node of nodes.values()) if (node.kind === 'state' && !reachable.has(node.id)) fail(node.line, `state '${node.semanticId}' is unreachable from initial state '${initial}'`);
}

export class GraphRegistry {
  readonly states: ReadonlySet<string>;
  readonly guards: ReadonlyMap<string, Guard>;
  readonly actions: ReadonlyMap<string, ActionDefinition>;
  readonly events: ReadonlyMap<string, EventDefinition>;
  constructor(registries: GraphRegistries = {}) {
    this.states = registries.states ?? new Set();
    this.guards = new Map(entries(registries.guards));
    this.actions = new Map(entries(registries.actions));
    this.events = new Map(entries(registries.events));
  }
}

export class GraphRuntime {
  readonly graph: Graph;
  readonly registry: GraphRegistry;
  constructor(graphOrSource: Graph | string, registries: GraphRegistries = {}) {
    this.graph = typeof graphOrSource === 'string' ? parseGraphV2(graphOrSource) : graphOrSource;
    this.registry = new GraphRegistry(registries);
    this.validateRegistries();
  }
  private validateRegistries(): void {
    for (const node of this.graph.nodes.values()) {
      if (node.kind === 'state' && !this.registry.states.has(node.semanticId)) throw new Error(`unknown state '${node.semanticId}'`);
      if (node.kind === 'guard' && !this.registry.guards.has(node.semanticId)) throw new Error(`unknown guard '${node.semanticId}'`);
      if (node.kind === 'action' && !this.registry.actions.has(node.semanticId)) throw new Error(`unknown action '${node.semanticId}'`);
      if (node.kind === 'emit' && !this.registry.events.has(node.semanticId)) throw new Error(`unknown emitted event '${node.semanticId}'`);
    }
    for (const edge of this.graph.edges) {
      if (edge.kind === 'on' || edge.kind === 'emit') {
        if (!this.registry.events.has(edge.semanticId!)) throw new Error(`unknown event '${edge.semanticId}'`);
      }
      if (edge.kind === 'request' && !this.registry.actions.has(edge.semanticId!)) throw new Error(`unknown action '${edge.semanticId}'`);
    }
  }
  private validateInput(input: GraphInput): void {
    const definition = input.transport === 'event' ? this.registry.events.get(input.id) : this.registry.actions.get(input.id);
    if (!definition) throw new Error(`unknown ${input.transport} '${input.id}'`);
    if (definition.validate && !definition.validate(input.payload)) throw new Error(`invalid payload for ${input.transport} '${input.id}'`);
  }
  private pathFromSync(current: string, facts: GraphFacts): { target: string; actions: { node: GraphNode; emittedEvents: string[] }[] } | null {
    const actions: { node: GraphNode; emittedEvents: string[] }[] = [];
    const visited = new Set<string>();
    while (true) {
      if (visited.has(current)) throw new Error(`cyclic graph path at '${current}'`); visited.add(current);
      const currentNode = this.graph.nodes.get(current)!;
      if (currentNode.kind === 'state') return { target: currentNode.semanticId, actions };
      if (currentNode.kind === 'guard') {
        const guard = this.registry.guards.get(currentNode.semanticId)!;
        const result = guard(facts);
        if (result instanceof Promise) throw new Error(`guard '${currentNode.semanticId}' is asynchronous; use evaluate()`);
        const branch = (result ? 'true' : 'false') as GraphEdgeKind;
        const branchEdge = this.graph.edges.find(edge => edge.from === currentNode.id && edge.kind === branch);
        if (!branchEdge) return null;
        current = branchEdge.to; continue;
      }
      if (currentNode.kind === 'action') { const emittedEvents = this.graph.edges.filter(edge => edge.from === currentNode.id && edge.kind === 'emit').map(edge => edge.semanticId!); actions.push({ node: currentNode, emittedEvents }); current = this.graph.edges.find(edge => edge.from === currentNode.id && (edge.kind === 'to' || edge.kind === 'unlabelled'))!.to; continue; }
      throw new Error(`invalid executable path through emit node '${currentNode.semanticId}'`);
    }
  }
  evaluateSync<Payload>(facts: GraphFacts<Payload>): GraphDecision {
    this.validateInput(facts.input);
    const stateNode = [...this.graph.nodes.values()].find(node => node.kind === 'state' && node.semanticId === facts.currentState);
    if (!stateNode) throw new Error(`unknown state '${facts.currentState}'`);
    const edges = this.graph.edges.filter(edge => edge.from === stateNode.id && edge.kind === (facts.input.transport === 'event' ? 'on' : 'request') && edge.semanticId === facts.input.id);
    const results = edges.map(edge => this.pathFromSync(edge.to, facts)).filter((result): result is { target: string; actions: { node: GraphNode; emittedEvents: string[] }[] } => result !== null);
    if (results.length === 0) return { accepted: false, source: facts.currentState, reason: 'no_transition' };
    if (results.length > 1) return { accepted: false, source: facts.currentState, reason: 'ambiguous' };
    const result = results[0];
    return { accepted: true, source: facts.currentState, target: result.target, actions: result.actions.map(step => ({ id: step.node.semanticId, input: facts.input, emittedEvents: step.emittedEvents })) };
  }
  async evaluate<Payload>(facts: GraphFacts<Payload>): Promise<GraphDecision> {
    this.validateInput(facts.input);
    const stateNode = [...this.graph.nodes.values()].find(node => node.kind === 'state' && node.semanticId === facts.currentState);
    if (!stateNode) throw new Error(`unknown state '${facts.currentState}'`);
    const edges = this.graph.edges.filter(candidate => candidate.from === stateNode.id && candidate.kind === (facts.input.transport === 'event' ? 'on' : 'request') && candidate.semanticId === facts.input.id);
    const evaluatePath = async (start: string): Promise<{ target: string; actions: { node: GraphNode; emittedEvents: string[] }[] } | null> => {
      let current = start; const actions: { node: GraphNode; emittedEvents: string[] }[] = [];
      while (true) {
        const node = this.graph.nodes.get(current)!;
        if (node.kind === 'state') return { target: node.semanticId, actions };
      if (node.kind === 'guard') {
        const result = await this.registry.guards.get(node.semanticId)!(facts);
        const branch = this.graph.edges.find(candidate => candidate.from === node.id && candidate.kind === (result ? 'true' : 'false'));
        if (!branch) return null;
        current = branch.to;
        continue;
      }
      if (node.kind === 'action') {
        const emittedEvents = this.graph.edges.filter(candidate => candidate.from === node.id && candidate.kind === 'emit').map(candidate => candidate.semanticId!);
        actions.push({ node, emittedEvents });
        current = this.graph.edges.find(candidate => candidate.from === node.id && (candidate.kind === 'to' || candidate.kind === 'unlabelled'))!.to;
        continue;
      }
        throw new Error(`invalid executable path through emit node '${node.semanticId}'`);
      }
    };
    const results = (await Promise.all(edges.map(edge => evaluatePath(edge.to)))).filter((result): result is { target: string; actions: { node: GraphNode; emittedEvents: string[] }[] } => result !== null);
    if (results.length === 0) return { accepted: false, source: facts.currentState, reason: 'no_transition' };
    if (results.length > 1) return { accepted: false, source: facts.currentState, reason: 'ambiguous' };
    const result = results[0];
    return { accepted: true, source: facts.currentState, target: result.target, actions: result.actions.map(step => ({ id: step.node.semanticId, input: facts.input, emittedEvents: step.emittedEvents })) };
  }
}

export class GraphDispatcher {
  constructor(readonly runtime: GraphRuntime, readonly ports: GraphDispatcherPorts) {}

  dispatchSync<Payload>(facts: GraphFacts<Payload>): GraphDispatchResult {
    const decision = this.runtime.evaluateSync(facts);
    if (!decision.accepted) return { decision, receipts: [] };
    const persisted = this.ports.persistTransition({ source: decision.source, target: decision.target });
    if (persisted instanceof Promise) throw new Error('GraphDispatcher.dispatchSync requires synchronous persistTransition');
    const receipts: ActionReceipt[] = [];
    for (const step of decision.actions) {
      const action = this.runtime.registry.actions.get(step.id)!;
      const context = { facts, actionId: step.id, input: step.input };
      const pending = this.ports.executeAction ? this.ports.executeAction(step.id, context) : action.execute ? action.execute(context) : {};
      if (pending instanceof Promise) throw new Error('GraphDispatcher.dispatchSync requires synchronous executeAction');
      const receipt = pending;
      receipts.push(receipt);
      if (receipt.ok === false) {
        const definition = this.runtime.registry.events.get(receipt.failureEvent.id);
        if (!definition) throw new Error(`unknown failure event '${receipt.failureEvent.id}'`);
        if (definition.validate && !definition.validate(receipt.failureEvent.payload)) throw new Error(`invalid payload for failure event '${receipt.failureEvent.id}'`);
        const published = this.ports.publishEvent(receipt.failureEvent);
        if (published instanceof Promise) throw new Error('GraphDispatcher.dispatchSync requires synchronous publishEvent');
        return { decision, receipts };
      }
      const payloads = receipt.payloads ?? {};
      for (const eventId of step.emittedEvents) {
        const definition = this.runtime.registry.events.get(eventId)!;
        if (!(eventId in payloads)) throw new Error(`action '${step.id}' did not supply payload for emitted event '${eventId}'`);
        if (definition.validate && !definition.validate(payloads[eventId])) throw new Error(`invalid payload for emitted event '${eventId}'`);
      }
      for (const eventId of step.emittedEvents) {
        const published = this.ports.publishEvent({ id: eventId, payload: payloads[eventId] });
        if (published instanceof Promise) throw new Error('GraphDispatcher.dispatchSync requires synchronous publishEvent');
      }
    }
    return { decision, receipts };
  }

  async dispatch<Payload>(facts: GraphFacts<Payload>): Promise<GraphDispatchResult> {
    const decision = await this.runtime.evaluate(facts);
    if (!decision.accepted) return { decision, receipts: [] };
    await this.ports.persistTransition({ source: decision.source, target: decision.target });
    const receipts: ActionReceipt[] = [];
    for (const step of decision.actions) {
      const action = this.runtime.registry.actions.get(step.id)!;
      const context = { facts, actionId: step.id, input: step.input };
      const receipt = this.ports.executeAction ? await this.ports.executeAction(step.id, context) : action.execute ? await action.execute(context) : {};
      receipts.push(receipt);
      if (receipt.ok === false) {
        const definition = this.runtime.registry.events.get(receipt.failureEvent.id);
        if (!definition) throw new Error(`unknown failure event '${receipt.failureEvent.id}'`);
        if (definition.validate && !definition.validate(receipt.failureEvent.payload)) throw new Error(`invalid payload for failure event '${receipt.failureEvent.id}'`);
        await this.ports.publishEvent(receipt.failureEvent);
        return { decision, receipts };
      }
      const payloads = receipt.payloads ?? {};
      for (const eventId of step.emittedEvents) {
        const definition = this.runtime.registry.events.get(eventId)!;
        if (!(eventId in payloads)) throw new Error(`action '${step.id}' did not supply payload for emitted event '${eventId}'`);
        if (definition.validate && !definition.validate(payloads[eventId])) throw new Error(`invalid payload for emitted event '${eventId}'`);
      }
      for (const eventId of step.emittedEvents) await this.ports.publishEvent({ id: eventId, payload: payloads[eventId] });
    }
    return { decision, receipts };
  }
}

export const parseExecutableGraph = parseGraphV2;
export const loadGraphV2 = (source: string, registries: GraphRegistries = {}): GraphRuntime => new GraphRuntime(source, registries);
