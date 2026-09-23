import { readFileSync } from 'node:fs';
import { parseExecutableMermaid, WorkflowAction, WorkflowEngine, WorkflowGuard } from './mermaid.js';

function load(name: string, guards: Readonly<Record<string, WorkflowGuard>> = {}, actions: Readonly<Record<string, WorkflowAction>> = {}): WorkflowEngine {
  const url = new URL(`../../workflow/${name}.mmd`, import.meta.url);
  return new WorkflowEngine(parseExecutableMermaid(readFileSync(url, 'utf8')), guards, actions);
}

const booleanGuard = (name: string): WorkflowGuard => context => context[name] === true;
const lifecycleAction: WorkflowAction = () => {};

export const jobLifecycleWorkflow = load(
  'job-lifecycle',
  { notMerged: booleanGuard('notMerged') },
  { cancelJob: lifecycleAction },
);
export const taskLifecycleWorkflow = load(
  'task-lifecycle',
  {
    dependenciesSatisfied: booleanGuard('dependenciesSatisfied'),
    dependenciesUnsatisfied: booleanGuard('dependenciesUnsatisfied'),
    runnable: booleanGuard('runnable'),
  },
  { release: lifecycleAction, hold: lifecycleAction },
);
