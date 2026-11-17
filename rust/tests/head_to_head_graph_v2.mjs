// Node/Rust strict executable Mermaid Graph-v2 parser/runtime/dispatcher differential. Graph remains the single transition authority.
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {dirname,resolve} from 'node:path';import {fileURLToPath} from 'node:url';
import {parseGraphV2,GraphRuntime,GraphDispatcher} from '../../dist/workflow/graph-v2.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),bin=resolve(root,'rust/target/debug/relay-rust2-parity');let ready=false;
function rust(req){if(!ready){const built=spawnSync('cargo',['build','--offline','--manifest-path','rust/Cargo.toml'],{cwd:root,encoding:'utf8',timeout:90000});assert.equal(built.status,0,built.stderr);ready=true;}
 const r=spawnSync(bin,[],{input:JSON.stringify(req)+'\n',encoding:'utf8',timeout:15000,maxBuffer:6*1024*1024});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout.trim());}
function node(req){try{
 const graph=parseGraphV2(req.source);
 if(req.op==='parseGraphV2')return {ok:true,value:{source:graph.source,direction:graph.direction,nodes:[...graph.nodes.values()],edges:graph.edges,initial:graph.initial}};
 const registry={states:new Set([...graph.nodes.values()].filter(node=>node.kind==='state').map(node=>node.semanticId)),guards:{},actions:{},events:{}};
 for(const entry of graph.nodes.values()){
  if(entry.kind==='guard')registry.guards[entry.semanticId]=()=>req.guards?.[entry.semanticId]??false;
  if(entry.kind==='action')registry.actions[entry.semanticId]={id:entry.semanticId,execute:()=>req.receipts?.[entry.semanticId]??{}};
  if(entry.kind==='emit')registry.events[entry.semanticId]={id:entry.semanticId};
 }
 for(const edge of graph.edges){
  if(edge.kind==='on'||edge.kind==='emit')registry.events[edge.semanticId]={id:edge.semanticId};
  if(edge.kind==='request')registry.actions[edge.semanticId]={id:edge.semanticId,execute:()=>req.receipts?.[edge.semanticId]??{}};
 }
 for(const id of req.rejectedPayloadIds??[]){
  if(registry.events[id])registry.events[id].validate=()=>false;
  if(registry.actions[id])registry.actions[id].validate=()=>false;
 }
 const runtime=new GraphRuntime(graph,registry);
 if(req.dispatch){const transitions=[],events=[];
  const result=new GraphDispatcher(runtime,{persistTransition:transition=>transitions.push(transition),publishEvent:event=>events.push(event)}).dispatchSync(req.facts);
  return {ok:true,value:{result,transitions,events}};
 }
 return {ok:true,value:runtime.evaluateSync(req.facts)};
 }catch(error){return {ok:false,error:error.message}}}
let seed=0x47ac1166;const rand=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;},pick=xs=>xs[rand(xs.length)];
const examples=[
`flowchart LR\n%% relay: initial a\na["state: ACTIVE"]\nb["state: COMPLETED"]\na -->|on: finished| b`,
`flowchart TD\n%% relay: initial start\nstart["state: QUEUED"]\nwait["guard: ready"]\ngo["action: effect.launch"]\ndone["state: RUNNING"]\nstart -->|on: dispatch| wait\nwait -->|true| go\nwait -->|false| start\ngo -->|to: RUNNING| done`,
`flowchart LR\n%% relay: initial st\nst["state: ACTIVE"]\na["action: effect.apply"]\ne["emit: terminal"]\nend["state: COMPLETED"]\nst -->|on: ready| a\na -->|emit: terminal| e\na -->|to: COMPLETED| end`,
`flowchart RL\n%% relay: initial st\nst["state: ACTIVE"]\na["action: effect.apply"]\nb["action: effect.persist"]\nend["state: COMPLETED"]\nst -->|request: effect.apply| a\na --> b\nb -->|to: COMPLETED| end`,
`flowchart TD\n%% relay: initial a\na["state: ACTIVE"]\ng1["guard: g1"]\ng2["guard: g2"]\nb["state: COMPLETED"]\na -->|on: ready| g1\na -->|on: ready| g2\ng1 -->|true| b\ng2 -->|true| b`,
];
const graphs=[];
for(let i=0;i<1100;i++){
 const original=pick(examples);
 const source=pick([original,original.replace('flowchart','flowchart  '),original.replace('%% relay: initial','%% relay: initial'),
   original.replace('flowchart','stateDiagram-v2'),original.replace(/\bstate:/g,'status:'),original.replace(/\bguard:/g,'guard:'),
   original.replace(/on: /g,'on: missing.'),original.replace('to: COMPLETED','to: RUNNING'),
   original+'\nmissing[agent:worker]',original.replace('%% relay: initial','%% relay: initial'),
   `---\ntitle: Executable Graph\n---\n${original}`,original.replace('a -->','a ---'),original.replace('ACTIVE','ACTIVE-2'),
   original.replace('state: ACTIVE','state: ACTIVE | label'),original.replace('flowchart LR','flowchart TB')]);
 graphs.push({op:'parseGraphV2',source});
}
test('strict Mermaid Graph-v2 source parsing and malformed topology errors match Node',()=>{
 for(const [i,req] of graphs.entries())assert.deepEqual(rust(req),node(req),`graph parser ${i}: ${req.source.slice(0,520)}`);
 console.log(`Verified ${graphs.length} Node/Rust strict Graph-v2 parse/topology cases`);
});
const runtimeFixtures=[];
for(let i=0;i<1300;i++){
 const source=pick(examples),graph=parseGraphV2(source);
 const allStates=graph.nodes.values().filter(node=>node.kind==='state').map(node=>node.semanticId).toArray();
 const events=graph.edges.filter(edge=>edge.kind==='on').map(edge=>edge.semanticId);
 const actions=graph.edges.filter(edge=>edge.kind==='request').map(edge=>edge.semanticId);
 const id=pick([...events,...actions,'unknown-event']);
 const transport=actions.includes(id)&&!events.includes(id)?'action':'event';
 const facts={currentState:pick([...allStates,'OTHER']),input:{transport,id,payload:{id:i}},durableFacts:{ready:pick([true,false])}};
 const guards=Object.fromEntries(graph.nodes.values().filter(node=>node.kind==='guard').map(node=>[node.semanticId,pick([true,false])]));
 const receipts=Object.fromEntries(graph.nodes.values().filter(node=>node.kind==='action').map(node=>[node.semanticId,pick([{}, {ok:true}, {payloads:{terminal:{done:true}}},{ok:false,failureEvent:{id:'terminal',payload:{failed:true}}}])]));
 runtimeFixtures.push({op:'graphV2Scenario',source,facts,guards,receipts,dispatch:rand(3)===0,rejectedPayloadIds:rand(13)===0?[id]:[]});
}
test('Graph-v2 state/guard/action decision and dispatched event receipts match Node',()=>{
 for(const [i,req] of runtimeFixtures.entries())assert.deepEqual(rust(req),node(req),`Graph runtime ${i}: ${JSON.stringify(req).slice(0,600)}`);
 console.log(`Verified ${runtimeFixtures.length} Node/Rust executable Graph-v2 transitions and side-effect orders`);
});
