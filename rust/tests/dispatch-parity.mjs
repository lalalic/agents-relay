import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { GraphRuntime, GraphDispatcher, parseGraphV2 } from '../../dist/workflow/graph-v2.js';

const root=resolve(import.meta.dirname,'../..');
const exe=resolve(root,'rust/target/debug/agents-relay-rust');
const folder=join(root,'workflow');
const files=readdirSync(folder).filter(x=>x.endsWith('.mmd')&&x!=='main.mmd');

function runtimeOf(graph,guardFacts) {
  const registries={states:new Set(),guards:new Map(),actions:new Map(),events:new Map()};
  for(const n of graph.nodes.values()) {
    if(n.kind==='state')registries.states.add(n.semanticId);
    if(n.kind==='guard')registries.guards.set(n.semanticId,()=>Boolean(guardFacts[n.semanticId]));
    if(n.kind==='action')registries.actions.set(n.semanticId,{id:n.semanticId});
    if(n.kind==='emit')registries.events.set(n.semanticId,{id:n.semanticId});
  }
  for(const e of graph.edges) {
    if(e.kind==='on'||e.kind==='emit')registries.events.set(e.semanticId,{id:e.semanticId});
    if(e.kind==='request')registries.actions.set(e.semanticId,{id:e.semanticId});
  }
  return new GraphRuntime(graph,registries);
}
function mockDispatch(runtime,facts,receipts) {
  const trace=[];
  const ports={
    persistTransition:({source,target})=>{trace.push({type:'persist',source,target});},
    executeAction:(id,{input})=>{trace.push({type:'execute',id,input});return receipts[id]??{};},
    publishEvent:({id,payload})=>{trace.push({type:'publish',id,payload});}
  };
  const result=new GraphDispatcher(runtime,ports).dispatchSync(facts);
  return {result,trace};
}
function rustDispatch(file,request) {
  const output=spawnSync(exe,['graph','simulate','--graph',join(folder,file),'--request',JSON.stringify(request)],{
    encoding:'utf8',maxBuffer:4*1024*1024,
  });
  assert.equal(output.status,0,`${file}: ${output.stderr}`);
  return JSON.parse(output.stdout);
}

test('Graph action receipt ordering and failure events match TS dispatcher',()=>{
  let compared=0, failures=0, graphs=0;
  for(const file of files) {
    const graph=parseGraphV2(readFileSync(join(folder,file),'utf8'));
    const guardFacts=Object.fromEntries([...graph.nodes.values()].filter(n=>n.kind==='guard').map(n=>[n.semanticId,true]));
    const runtime=runtimeOf(graph,guardFacts);
    let sample=null;
    for(const n of graph.nodes.values()) {
      if(n.kind!=='state')continue;
      for(const e of graph.edges.filter(e=>e.from===n.id&&(e.kind==='on'||e.kind==='request'))) {
        const facts={currentState:n.semanticId,input:{transport:e.kind==='on'?'event':'action',id:e.semanticId,payload:{tag:file}},durableFacts:{}};
        const decision=runtime.evaluateSync(facts);
        if(decision.accepted&&decision.actions.length) {sample=facts;break;}
      }
      if(sample)break;
    }
    if(!sample)continue;
    graphs++;
    const decision=runtime.evaluateSync(sample);
    const receipts=Object.fromEntries(decision.actions.map(a=>[a.id,{
      payloads:Object.fromEntries(a.emittedEvents.map(id=>[id,{source:file,receipt:a.id}])),
    }]));
    const request={currentState:sample.currentState,input:sample.input,guards:guardFacts,receipts};
    assert.deepEqual(rustDispatch(file,request),mockDispatch(runtime,sample,receipts),`${file}: success dispatch`);
    compared++;
    const failure=graph.edges.find(e=>e.kind==='on')?.semanticId;
    if(failure) {
      const failedReceipts={...receipts,[decision.actions[0].id]:{ok:false,failureEvent:{id:failure,payload:{reason:'simulated'}}}};
      const failedRequest={...request,receipts:failedReceipts};
      assert.deepEqual(rustDispatch(file,failedRequest),mockDispatch(runtime,sample,failedReceipts),`${file}: failure dispatch`);
      compared++;failures++;
    }
  }
  assert.ok(compared>=10,`Only ${compared} dispatches compared`);
  console.log(`Action dispatch parity: ${compared} successful/failure paths across ${graphs} graphs, ${failures} failure receipts`);
});
