import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { GraphRuntime, GraphDispatcher, parseGraphV2 } from '../../dist/workflow/graph-v2.js';
const rust = resolve(import.meta.dirname, '../target/debug/agents-relay-rust');
const example = `flowchart LR
%% relay: initial start
start["state: START"]
end["state: END"]
a["action: mutation.do"]
x["emit: one"]
y["emit: two"]
start -->|on: go| a
a -->|emit: one| x
a -->|emit: two| y
a --> end`;
function runtime(source) {
  const graph = parseGraphV2(source);
  const states = new Set(), events = new Map(), actions = new Map(), guards = new Map();
  for (const n of graph.nodes.values()) {
    if (n.kind === 'state') states.add(n.semanticId);
    if (n.kind === 'guard') guards.set(n.semanticId, () => true);
    if (n.kind === 'action') actions.set(n.semanticId, { id: n.semanticId });
    if (n.kind === 'emit') events.set(n.semanticId, { id: n.semanticId });
  }
  for (const e of graph.edges) {
    if (e.kind === 'on' || e.kind === 'emit') events.set(e.semanticId, { id: e.semanticId });
    if (e.kind === 'request') actions.set(e.semanticId, { id: e.semanticId });
  }
  return new GraphRuntime(graph, {states, events, actions, guards});
}
function invoke(source,request,command='simulate') {
  const directory=mkdtempSync(join(tmpdir(),'relay-rust-review-'));
  try {
    const file=join(directory,'graph.mmd');writeFileSync(file,source);
    const args=['graph',command,'--graph',file,'--request',JSON.stringify(request)];
    const result=spawnSync(rust,args,{encoding:'utf8'});
    return {status:result.status,stdout:result.stdout,stderr:result.stderr,parsed:result.status===0?JSON.parse(result.stdout):null};
  } finally {rmSync(directory,{recursive:true,force:true});}
}
const input=id=>({transport:'event',id,payload:{}});
const state=id=>({currentState:'START',input:input(id),durableFacts:{}});
test('unknown input rejected by both runtimes',()=>{
  const rt=runtime(example);
  assert.throws(()=>rt.evaluateSync(state('unknown')),/unknown event/);
  const result=invoke(example,{currentState:'START',input:input('unknown'),guards:{}},'decide');
  assert.notEqual(result.status,0,`Rust accepted unregistered event: ${result.stdout}`);
});
test('missing second emitted payload does not partially publish',()=>{
  const rt=runtime(example);
  const trace=[];
  const receipt={payloads:{one:{foo:1}}};
  assert.throws(()=>new GraphDispatcher(rt,{
    persistTransition:()=>trace.push('persist'),executeAction:()=>receipt,
    publishEvent:({id})=>trace.push(id),
  }).dispatchSync(state('go')),/did not supply payload/);
  assert.deepEqual(trace,['persist']);
  const result=invoke(example,{currentState:'START',input:input('go'),guards:{},receipts:{'mutation.do':receipt}});
  assert.notEqual(result.status,0);
  // Need a trace-based Rust test to prove the first event was not published.
});
test('failure receipt may publish a declared but unconnected emit event',()=>{
  const source=`flowchart LR
%% relay: initial start
start["state: START"]
end["state: END"]
a["action: mutation.do"]
unused["emit: isolated.failure"]
start -->|on: go| a
a --> end`;
  const rt=runtime(source);
  const events=[];
  const receipt={ok:false,failureEvent:{id:'isolated.failure',payload:{reason:'x'}}};
  const result=new GraphDispatcher(rt,{
    persistTransition:()=>{},executeAction:()=>receipt,
    publishEvent:({id,payload})=>events.push({id,payload}),
  }).dispatchSync(state('go'));
  assert.equal(result.receipts.length,1);
  assert.deepEqual(events,[{id:'isolated.failure',payload:{reason:'x'}}]);
  const rustResult=invoke(source,{
    currentState:'START',input:input('go'),guards:{},receipts:{'mutation.do':receipt},
  });
  assert.equal(rustResult.status,0,`Rust rejected declared failure event: ${rustResult.stderr}`);
  assert.deepEqual(rustResult.parsed.trace.at(-1),{type:'publish',id:'isolated.failure',payload:{reason:'x'}});
});
test('null ActionReceipt cannot silently count as a successful action',()=>{
  const source=`flowchart LR
%% relay: initial start
start["state: START"]
end["state: END"]
a["action: mutation.do"]
start -->|on: go| a
a --> end`;
  const rt=runtime(source);
  assert.throws(()=>new GraphDispatcher(rt,{
    persistTransition:()=>{},executeAction:()=>null,publishEvent:()=>{},
  }).dispatchSync(state('go')), /Cannot read properties of null/);
  const rustResult=invoke(source,{
    currentState:'START',input:input('go'),guards:{},receipts:{'mutation.do':null},
  });
  assert.notEqual(rustResult.status,0,`Rust accepted null ActionReceipt: ${rustResult.stdout}`);
});
test('registered Action without a request edge differs from unregistered Action',()=>{
  const rt=runtime(example);
  const build=(id)=>({currentState:'START',input:{transport:'action',id,payload:{}},durableFacts:{}});
  assert.throws(()=>rt.evaluateSync(build('unregistered.action')),/unknown action/);
  const unknown=invoke(example,{...build('unregistered.action'),guards:{}},'decide');
  assert.notEqual(unknown.status,0);
  const expected=rt.evaluateSync(build('mutation.do'));
  assert.deepEqual(expected,{accepted:false,source:'START',reason:'no_transition'});
  const known=invoke(example,{...build('mutation.do'),guards:{}},'decide');
  assert.equal(known.status,0,known.stderr);
  assert.deepEqual(known.parsed,expected);
});
