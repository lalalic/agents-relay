import { readFileSync } from 'node:fs';
import { parseExecutableMermaid, WorkflowEngine, WorkflowGuard, type WorkflowActionBinding } from './mermaid.js';
import { WORKFLOW_EFFECT_NAMES, WORKFLOW_EVENT_NAMES, WORKFLOW_FACT_NAMES, WORKFLOW_MUTATION_NAMES, classifyWorkflowActions } from './contracts.js';

function declarativeActions(): Readonly<Record<string, WorkflowActionBinding>> {
  return Object.fromEntries(
    [...WORKFLOW_MUTATION_NAMES, ...WORKFLOW_EFFECT_NAMES].map(name => [name, { declarative: true }]),
  );
}

export function validateCanonicalWorkflowGraph(graph: ReturnType<typeof parseExecutableMermaid>): void {
  const canonicalEvents = new Set<string>(WORKFLOW_EVENT_NAMES);
  const canonicalFacts = new Set<string>(WORKFLOW_FACT_NAMES);
  for (const transition of graph.transitions) {
    if (!canonicalEvents.has(transition.event)) {
      throw new Error(`Unknown canonical workflow event ${transition.event} referenced at line ${transition.line}`);
    }
    if (transition.guard && !canonicalFacts.has(transition.guard)) {
      throw new Error(`Unknown canonical workflow fact ${transition.guard} referenced at line ${transition.line}`);
    }
    classifyWorkflowActions(transition.actions);
  }
}

function load(name: string, guards: Readonly<Record<string, WorkflowGuard>> = {}): WorkflowEngine {
  const url = new URL(`../../workflow/${name}.mmd`, import.meta.url);
  const graph = parseExecutableMermaid(readFileSync(url, 'utf8'));
  validateCanonicalWorkflowGraph(graph);
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
    explicitRecovery: booleanGuard('explicitRecovery'),
    dependenciesSatisfied: booleanGuard('dependenciesSatisfied'),
    dependenciesUnsatisfied: booleanGuard('dependenciesUnsatisfied'),
    runnable: booleanGuard('runnable'),
    dispatchable: booleanGuard('dispatchable'),
    recoverableExecution: booleanGuard('recoverableExecution'),
  },
);
