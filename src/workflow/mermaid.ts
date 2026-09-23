export type WorkflowTransition = {
  from: string;
  to: string;
  event: string;
  guard: string | null;
  actions: string[];
  line: number;
};

export type WorkflowGraph = {
  source: string;
  states: ReadonlySet<string>;
  initial: string;
  finals: ReadonlySet<string>;
  transitions: readonly WorkflowTransition[];
};

export type WorkflowContext = Record<string, unknown>;
export type WorkflowGuard = (context: WorkflowContext) => boolean | Promise<boolean>;
export type WorkflowAction = (context: WorkflowContext, transition: WorkflowTransition) => void | Promise<void>;

const STATE = String.raw`(?:[A-Za-z_][A-Za-z0-9_.-]*|\[\*\])`;
const TRANSITION = new RegExp(`^(${STATE})\\s*-->\\s*(${STATE})(?:\\s*:\\s*(.+))?$`);
const NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

function parseLabel(label: string | undefined, line: number, terminal: boolean): Pick<WorkflowTransition, 'event' | 'guard' | 'actions'> {
  if (!label?.trim()) {
    if (terminal) return { event: '', guard: null, actions: [] };
    throw new Error(`Executable Mermaid transition at line ${line} requires an event label`);
  }
  const pieces = label.split('/');
  if (pieces.length > 2) throw new Error(`Executable Mermaid label at line ${line} may contain at most one '/' action separator`);
  const left = pieces[0].trim();
  const guardMatch = left.match(/^(.*?)(?:\s+\[([A-Za-z_][A-Za-z0-9_.-]*)\])?$/);
  if (!guardMatch) throw new Error(`Invalid executable Mermaid label at line ${line}`);
  const event = guardMatch[1].trim();
  const guard = guardMatch[2] ?? null;
  if (!event || !NAME.test(event)) throw new Error(`Invalid event '${event}' at line ${line}`);
  const actions = pieces[1]?.split(',').map(value => value.trim()).filter(Boolean) ?? [];
  for (const action of actions) if (!NAME.test(action)) throw new Error(`Invalid action '${action}' at line ${line}`);
  return { event, guard, actions };
}

export function parseExecutableMermaid(source: string): WorkflowGraph {
  const lines = source.split(/\r?\n/);
  let headerSeen = false;
  const states = new Set<string>();
  const finals = new Set<string>();
  const transitions: WorkflowTransition[] = [];
  const initials: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index].trim();
    if (!line || line.startsWith('%%')) continue;
    if (!headerSeen) {
      if (line !== 'stateDiagram-v2') throw new Error(`Executable Mermaid must start with stateDiagram-v2 (line ${lineNumber})`);
      headerSeen = true;
      continue;
    }
    const match = line.match(TRANSITION);
    if (!match) throw new Error(`Unsupported executable Mermaid syntax at line ${lineNumber}: ${line}`);
    const [, from, to, label] = match;
    const fromTerminal = from === '[*]';
    const toTerminal = to === '[*]';
    if (fromTerminal && toTerminal) throw new Error(`Invalid [*] -> [*] transition at line ${lineNumber}`);
    if (!fromTerminal) states.add(from);
    if (!toTerminal) states.add(to);
    if (fromTerminal) {
      if (label?.trim()) throw new Error(`Initial transition at line ${lineNumber} must not have an event label`);
      initials.push(to);
      continue;
    }
    if (toTerminal) {
      if (label?.trim()) throw new Error(`Final transition at line ${lineNumber} must not have an event label`);
      finals.add(from);
      continue;
    }
    transitions.push({ from, to, ...parseLabel(label, lineNumber, false), line: lineNumber });
  }

  if (!headerSeen) throw new Error('Executable Mermaid is empty');
  if (initials.length !== 1) throw new Error(`Executable Mermaid requires exactly one [*] initial transition; found ${initials.length}`);
  if (transitions.length === 0) throw new Error('Executable Mermaid requires at least one executable transition');
  const seen = new Set<string>();
  const deterministicKeys = new Set<string>();
  for (const transition of transitions) {
    const key = `${transition.from}\u0000${transition.event}\u0000${transition.guard ?? ''}\u0000${transition.to}`;
    if (seen.has(key)) throw new Error(`Duplicate executable transition at line ${transition.line}: ${transition.from} --${transition.event}--> ${transition.to}`);
    seen.add(key);
    const deterministicKey = `${transition.from}\u0000${transition.event}\u0000${transition.guard ?? ''}`;
    if (deterministicKeys.has(deterministicKey)) throw new Error(`Ambiguous executable transition at line ${transition.line}: duplicate source/event/guard ${transition.from} --${transition.event} [${transition.guard ?? 'unguarded'}]`);
    deterministicKeys.add(deterministicKey);
  }
  return { source, states, initial: initials[0], finals, transitions };
}

export class WorkflowEngine {
  constructor(
    readonly graph: WorkflowGraph,
    private readonly guards: Readonly<Record<string, WorkflowGuard>> = {},
    private readonly actions: Readonly<Record<string, WorkflowAction>> = {},
  ) {
    this.validateRegistryBindings();
  }

  private validateRegistryBindings(): void {
    for (const transition of this.graph.transitions) {
      if (transition.guard && !this.guards[transition.guard]) throw new Error(`Unknown workflow guard ${transition.guard} referenced at line ${transition.line}`);
      for (const action of transition.actions) if (!this.actions[action]) throw new Error(`Unknown workflow action ${action} referenced at line ${transition.line}`);
    }
  }

  transitionsFrom(state: string): readonly WorkflowTransition[] {
    if (!this.graph.states.has(state)) throw new Error(`Unknown workflow state ${state}`);
    return this.graph.transitions.filter(transition => transition.from === state);
  }

  assertStateTransition(from: string, to: string, kind = 'workflow'): void {
    if (from === to) return;
    if (!this.graph.states.has(from) || !this.graph.states.has(to)) throw new Error(`Unknown ${kind} state ${!this.graph.states.has(from) ? from : to}`);
    if (!this.graph.transitions.some(transition => transition.from === from && transition.to === to)) throw new Error(`Invalid ${kind} transition ${from} -> ${to}`);
  }

  enabledSync(state: string, event: string, context: WorkflowContext = {}): WorkflowTransition[] {
    const candidates = this.transitionsFrom(state).filter(transition => transition.event === event);
    const enabled: WorkflowTransition[] = [];
    for (const transition of candidates) {
      if (!transition.guard) { enabled.push(transition); continue; }
      const value = this.guards[transition.guard](context);
      if (value instanceof Promise) throw new Error(`Workflow guard ${transition.guard} is asynchronous and cannot be used in a synchronous transition`);
      if (value) enabled.push(transition);
    }
    return enabled;
  }

  transitionSync(state: string, event: string, context: WorkflowContext = {}): string {
    const enabled = this.enabledSync(state, event, context);
    if (enabled.length === 0) throw new Error(`No enabled workflow transition from ${state} on ${event}`);
    if (enabled.length > 1) throw new Error(`Ambiguous workflow transition from ${state} on ${event}`);
    const transition = enabled[0];
    for (const actionName of transition.actions) {
      const value = this.actions[actionName](context, transition);
      if (value instanceof Promise) throw new Error(`Workflow action ${actionName} is asynchronous and cannot be used in a synchronous transition`);
    }
    return transition.to;
  }

  async enabled(state: string, event: string, context: WorkflowContext = {}): Promise<WorkflowTransition[]> {
    const candidates = this.transitionsFrom(state).filter(transition => transition.event === event);
    const enabled: WorkflowTransition[] = [];
    for (const transition of candidates) {
      if (!transition.guard) { enabled.push(transition); continue; }
      const guard = this.guards[transition.guard];
      if (await guard(context)) enabled.push(transition);
    }
    return enabled;
  }

  async transition(state: string, event: string, context: WorkflowContext = {}): Promise<string> {
    const enabled = await this.enabled(state, event, context);
    if (enabled.length === 0) throw new Error(`No enabled workflow transition from ${state} on ${event}`);
    if (enabled.length > 1) throw new Error(`Ambiguous workflow transition from ${state} on ${event}`);
    const transition = enabled[0];
    for (const actionName of transition.actions) {
      const action = this.actions[actionName];
      await action(context, transition);
    }
    return transition.to;
  }
}
