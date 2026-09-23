import { readFileSync } from 'node:fs';
import { parseExecutableMermaid, WorkflowEngine } from './mermaid.js';

function load(name: string): WorkflowEngine {
  const url = new URL(`../../workflow/${name}.mmd`, import.meta.url);
  return new WorkflowEngine(parseExecutableMermaid(readFileSync(url, 'utf8')));
}

export const jobLifecycleWorkflow = load('job-lifecycle');
export const taskLifecycleWorkflow = load('task-lifecycle');
