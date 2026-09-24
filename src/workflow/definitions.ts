import { readFileSync } from 'node:fs';
import { parseExecutableMermaid, WorkflowEngine, WorkflowGuard, type WorkflowActionBinding } from './mermaid.js';
import { WORKFLOW_EFFECT_NAMES, WORKFLOW_EVENT_NAMES, WORKFLOW_MUTATION_NAMES } from './contracts.js';

function declarativeActions(): Readonly<Record<string, WorkflowActionBinding>> {
  return Object.fromEntries(
    [...WORKFLOW_MUTATION_NAMES, ...WORKFLOW_EFFECT_NAMES].map(name => [name, { declarative: true }]),
  );
}

function load(name: string, guards: Readonly<Record<string, WorkflowGuard>> = {}): WorkflowEngine {
  const url = new URL(`../../workflow/${name}.mmd`, import.meta.url);
  const graph = parseExecutableMermaid(readFileSync(url, 'utf8'));
  const canonicalEvents = new Set<string>(WORKFLOW_EVENT_NAMES);
  for (const transition of graph.transitions) {
    if (!canonicalEvents.has(transition.event)) {
      throw new Error(`Unknown canonical workflow event ${transition.event} referenced at line ${transition.line}`);
    }
  }
  return new WorkflowEngine(graph, guards, declarativeActions());
}

const booleanGuard = (name: string): WorkflowGuard => context => context[name] === true;

export const jobLifecycleWorkflow = load(
  'job-lifecycle',
  {
    notMerged: booleanGuard('notMerged'),
    autoMerge: booleanGuard('autoMerge'),
  },
);

export const taskLifecycleWorkflow = load(
  'task-lifecycle',
  {
    dependenciesSatisfied: booleanGuard('dependenciesSatisfied'),
    dependenciesUnsatisfied: booleanGuard('dependenciesUnsatisfied'),
    runnable: booleanGuard('runnable'),
    dispatchable: booleanGuard('dispatchable'),
  },
);
