// Node/Rust direct emitted structured observability records: accepted, no-op,
// rejected, async-disabled and multi-step Graph decisions, with dynamic timestamps removed.
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {dirname,resolve,join} from 'node:path';import {fileURLToPath} from 'node:url';
import {parseGraphV2,GraphRuntime} from '../../dist/workflow/graph-v2.js';
import {dispatchWorkflowGraphSync} from '../../dist/workflow/dispatcher.js';
import {RelayObservability,setObservability,observability} from '../../dist/observability.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),bin=join(root,'rust/target/debug/relay-rust2-parity');let ready=false;
function rust(req){if(!ready){const b=spawnSync('cargo',['build','--offline','--manifest-path','rust/Cargo.toml'],{cwd:root,encoding:'utf8',timeout:90000});assert.equal(b.status,0,b.stderr);ready=true;}
 const r=spawnSync(bin,[],{input:JSON.stringify(req)+'\n',encoding:'utf8',timeout:13000});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout.trim());}
function node(req){
 const records=[],old=observability();setObservability(new RelayObservability(row=>records.push(Object.fromEntries(Object.entries(row).filter(([key])=>key!=='ts'))),'debug'));
 try{
  const graph=parseGraphV2(req.source),states=new Set(),guards={},actions={},events={};
  for(const node of graph.nodes.values()){
   if(node.kind==='state')states.add(node.semanticId);
   if(node.kind==='guard')guards[node.semanticId]=ctx=>ctx.durableFacts[node.semanticId]===true;
   if(node.kind==='action')actions[node.semanticId]={id:node.semanticId};
   if(node.kind==='emit')events[node.semanticId]={id:node.semanticId};
  }
  for(const edge of graph.edges){if(edge.kind==='on'||edge.kind==='emit')events[edge.semanticId]={id:edge.semanticId};if(edge.kind==='request')actions[edge.semanticId]={id:edge.semanticId};}
  const runtime=new GraphRuntime(graph,{states,guards,actions,events});
  const executed=[],transitions=[],emitted=[];
  const decision=dispatchWorkflowGraphSync(runtime,{initialState:req.initialState,input:req.input,durableFacts:req.facts,maxSteps:req.maxSteps,
    observe:req.observe,graphName:req.graphName,isTransientState:state=>req.transientPrefix?state.startsWith(req.transientPrefix):false,
    persistTransition:(source,target)=>transitions.push({source,target}),executeAction:id=>{executed.push(id);if(req.actionErrors?.[id])throw Error(req.actionErrors[id]);return req.receipts?.[id]??{};},
    publishEvent:(id,payload)=>emitted.push({id,payload})});
  return {ok:true,value:{result:{decision,executed,transitions,events:emitted},observations:records}};
 }catch(error){return {ok:false,error:error.message}}finally{setObservability(old);}
}
let seed=0x7618a3b2;const rand=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n};const pick=a=>a[rand(a.length)];
const sources=[
 'flowchart LR\n%% relay: initial a\na["state: active"]\nb["state: done"]\na -->|on: finish| b',
 'flowchart TD\n%% relay: initial a\na["state: active"]\nb["state: check"]\nc["state: done"]\na -->|on: finish| b\nb -->|on: finish| c',
 'flowchart LR\n%% relay: initial a\na["state: active"]\nact["action: effect.apply"]\nb["state: done"]\na -->|on: finish| act\nact -->|to: done| b',
];
const cases=[];
for(let i=0;i<230;i++)cases.push({op:'workflowObservationScenario',source:pick(sources),initialState:pick(['active','active','check','done']),
 input:{transport:'event',id:pick(['finish','not-found']),payload:{i}},facts:{},maxSteps:pick([1,2,3]),
 transientPrefix:pick(['check','active',undefined]),graphName:pick(['task-graph','job-lifecycle',undefined]),observe:pick([true,true,false]),
 receipts:{'effect.apply':pick([{}, {ok:true}, {ok:false,failureEvent:{id:'finish',payload:{failed:true}}}])},actionErrors:{}});
test('native dispatcher structured Graph observations match Node record level/outcome/transition identity',()=>{
 for(const [i,req] of cases.entries()){
  assert.deepEqual(rust(req),node(req),`observability fixture ${i}: ${JSON.stringify(req).slice(0,500)}`);
 }
 console.log(`Verified ${cases.length} exact Node/Rust Graph observation sequences and trace fields`);
});
