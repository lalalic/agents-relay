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
  assert.throws(() => assertTaskTransition('RUNNING','QUEUED'), /Invalid task transition/);
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

test('engine validates named guard/action bindings when registry is bound', () => {
  const guarded=parseExecutableMermaid(`stateDiagram-v2\n[*] --> A\nA --> B: go [allowed] / audit\nB --> [*]\n`);
  assert.throws(() => new WorkflowEngine(guarded), /Unknown workflow guard allowed referenced at line 3/);
  assert.throws(() => new WorkflowEngine(guarded,{allowed:()=>true}), /Unknown workflow action audit referenced at line 3/);
  assert.doesNotThrow(() => new WorkflowEngine(guarded,{allowed:()=>true},{audit:()=>{}}));
});

test('profile rejects duplicate source/event/guard branches as ambiguous', () => {
  assert.throws(() => parseExecutableMermaid(`stateDiagram-v2
[*] --> A
A --> B: go
A --> C: go
`), /Ambiguous executable transition/);
  assert.doesNotThrow(() => parseExecutableMermaid(`stateDiagram-v2
[*] --> A
A --> B: go [left]
A --> C: go [right]
`));
});

test('engine exposes graph introspection without duplicating workflow policy', () => {
  const graph=parseExecutableMermaid(`stateDiagram-v2
[*] --> A
A --> B: go
A --> C: stop
`);
  const engine=new WorkflowEngine(graph);
  assert.deepEqual(engine.transitionsFrom('A').map(t=>[t.event,t.to]),[['go','B'],['stop','C']]);
  assert.throws(() => engine.transitionsFrom('MISSING'), /Unknown workflow state MISSING/);
});


test('canonical lifecycle graphs expose the integrated runtime event contract', async () => {
  const closed=jobLifecycleWorkflow.graph.transitions.find(t=>t.from==='ACTIVE' && t.event==='pr.closed');
  assert.deepEqual(closed && {to:closed.to,guard:closed.guard,actions:closed.actions},{to:'CANCELLED',guard:'notMerged',actions:['cancelJob']});
  assert.equal(await jobLifecycleWorkflow.transition('ACTIVE','pr.closed',{notMerged:true}),'CANCELLED');
  await assert.rejects(jobLifecycleWorkflow.transition('ACTIVE','pr.closed',{notMerged:false}),/No enabled workflow transition/);

  assert.equal(await taskLifecycleWorkflow.transition('QUEUED','task.started'),'RUNNING');
  assert.equal(await taskLifecycleWorkflow.transition('RUNNING','task.completed'),'SUCCEEDED');
  assert.equal(await taskLifecycleWorkflow.transition('FAILED','reconcile.completed'),'SUCCEEDED');
  assert.equal(await taskLifecycleWorkflow.transition('DRAFT','reconcile',{dependenciesSatisfied:true}),'QUEUED');
  assert.equal(await taskLifecycleWorkflow.transition('QUEUED','reconcile',{dependenciesUnsatisfied:true}),'DRAFT');
  assert.equal(await taskLifecycleWorkflow.transition('QUEUED','reconcile',{runnable:true}),'QUEUED');
});
