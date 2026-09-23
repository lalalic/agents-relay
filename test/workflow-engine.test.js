import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExecutableMermaid, WorkflowEngine } from '../dist/workflow/mermaid.js';
import { jobLifecycleWorkflow, taskLifecycleWorkflow } from '../dist/workflow/definitions.js';
import { assertJobLifecycleTransition, assertTaskTransition } from '../dist/types.js';

test('canonical Mermaid workflow graphs load as executable profile', () => {
  assert.equal(jobLifecycleWorkflow.graph.initial, 'DRAFT');
  assert.deepEqual([...jobLifecycleWorkflow.graph.states].sort(), ['ACTIVE','CANCELLED','COMPLETED','DRAFT']);
  assert.equal(taskLifecycleWorkflow.graph.initial, 'DRAFT');
  assert.deepEqual([...taskLifecycleWorkflow.graph.finals].sort(), ['CANCELLED','SUCCEEDED']);
});

test('existing Job and Task lifecycle legality is driven by Mermaid graphs', () => {
  assert.doesNotThrow(() => assertJobLifecycleTransition('DRAFT','ACTIVE'));
  assert.doesNotThrow(() => assertJobLifecycleTransition('CANCELLED','COMPLETED'));
  assert.throws(() => assertJobLifecycleTransition('COMPLETED','ACTIVE'), /Invalid job transition/);
  assert.doesNotThrow(() => assertTaskTransition('RUNNING','QUEUED'));
  assert.doesNotThrow(() => assertTaskTransition('FAILED','RUNNING'));
  assert.throws(() => assertTaskTransition('SUCCEEDED','QUEUED'), /Invalid task transition/);
});

test('minimal profile supports named guard and action references', async () => {
  const graph=parseExecutableMermaid(`stateDiagram-v2\n[*] --> A\nA --> B: go [allowed] / audit\nB --> [*]\n`);
  const calls=[];
  const engine=new WorkflowEngine(graph,{allowed:ctx=>ctx.ok===true},{audit:(_ctx,t)=>calls.push(`${t.from}->${t.to}`)});
  assert.equal((await engine.enabled('A','go',{ok:false})).length,0);
  assert.equal(await engine.transition('A','go',{ok:true}),'B');
  assert.deepEqual(calls,['A->B']);
});

test('minimal executable Mermaid profile fails fast on unsupported syntax', () => {
  assert.throws(() => parseExecutableMermaid('stateDiagram-v2\nstate A\n[*] --> A'), /Unsupported executable Mermaid syntax/);
  assert.throws(() => parseExecutableMermaid('flowchart TD\nA-->B'), /stateDiagram-v2/);
  assert.throws(() => parseExecutableMermaid('stateDiagram-v2\n[*] --> A\nA --> B'), /requires an event label/);
});
