// New direct Node/Rust differential oracle for src/workflow/mermaid.ts parse and Graph Engine semantics.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseExecutableMermaid,WorkflowEngine} from '../../dist/workflow/mermaid.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const binary=resolve(root,'rust/target/debug/relay-rust2-parity');
const sourceGraph=(graph)=>({source:graph.source,states:[...graph.states],initial:graph.initial,finals:[...graph.finals],transitions:graph.transitions});
const requests=[];
const graphs=[
 '', '\n \t', 'stateDiagram-v2', 'flowchart LR\nA-->B: event',
 'stateDiagram-v2\n[*] --> Idle\nIdle --> Work : start\nWork --> [*]',
 'stateDiagram-v2\n[*] --> Idle\nIdle --> Work : start [ready] / mark, persist\nWork --> [*]',
 'stateDiagram-v2\n[*] --> A\nA --> B: next / one, two, three\nB --> [*]',
 'stateDiagram-v2\n[*] --> A\nA --> B: next [ready]\nB --> [*]',
 'stateDiagram-v2\n[*] --> A\nA --> B: next / x//y\nB --> [*]',
 'stateDiagram-v2\n[*] --> A\nA --> B: next / $invalid\nB --> [*]',
 'stateDiagram-v2\n[*] --> A\nA --> B: invalid event\nB --> [*]',
 'stateDiagram-v2\n[*] --> A\nA --> B: go\nA --> B: go',
 'stateDiagram-v2\n[*] --> A\nA --> B: go\nA --> C: go',
 'stateDiagram-v2\n[*] --> A\n[*] --> B\nA --> B: go',
 'stateDiagram-v2\n[*] --> [*]',
 'stateDiagram-v2\n[*] --> A: go\nA --> B: go',
 'stateDiagram-v2\n[*] --> A\nA --> [*]: done\nA --> B: go',
 'stateDiagram-v2\n[*] --> A\nA --> [*]',
 'stateDiagram-v2\n[*] --> A\nA --> B: go\nA --> C: go [guard]',
 '%% comment\nstateDiagram-v2\n%% another\n[*] --> A\nA --> B: go / done\nB --> [*]',
 'stateDiagram-v2\r\n[*] --> A\r\nA --> B : go [guard] / execute\r\nB --> [*]\r\n',
 'stateDiagram-v2\n[*] --> A\nA --> B: go \u00A0[guard] / execute',
 'stateDiagram-v2\n[*] --> A\nA --> B: go \uFEFF[guard]',
 'stateDiagram-v2\n[*] --> A\nA --> B: go\u2028wrong',
];
let seed=0x1234f5ac;
const pick=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed % n;};
const names=['Idle','Queued','Active','Failed','Done'];
const events=['dispatch','start','retry','pass','fail','go'];
const guards=['valid','ready','accepted'];
const actions=['launch','persist','notify'];
for(let i=0;i<900;i++){
 let src=(pick(9)===0?'not-a-header':'stateDiagram-v2')+(pick(4)===0?'\r\n':'\n');
 if(pick(7)===0)src+=' %% comment\n';
 const initial=names[pick(names.length)];src+='[*] --> '+initial+'\n';
 const count=1+pick(7);
 for(let j=0;j<count;j++){
  let from=names[pick(names.length)],to=names[pick(names.length)],event=events[pick(events.length)];
  src+=from+' --> '+to+(pick(5)===0?'':' : '+event+(pick(4)===0?` [${guards[pick(guards.length)]}]`:'')+(pick(4)===0?' / '+actions[pick(actions.length)]:''))+'\n';
 }
 if(pick(3)===0)src+='Done --> [*]\n';
 graphs.push(src);
}
for(const source of graphs)requests.push({op:'parseExecutableMermaid',source});

function reference(req){
 try{return {ok:true,value:sourceGraph(parseExecutableMermaid(req.source))};}
 catch(error){return {ok:false,error:error.message};}
}
test('parseExecutableMermaid exactly matches Node on 923 fixture diagrams',()=>{
 const build=spawnSync('cargo',['build','--offline','--manifest-path','rust/Cargo.toml'],{cwd:root,encoding:'utf8',timeout:90000});
 assert.equal(build.status,0,`cargo build failed: ${build.stderr}`);
 const output=spawnSync(binary,[],{input:requests.map(JSON.stringify).join('\n')+'\n',encoding:'utf8',maxBuffer:14*1024*1024});
 assert.equal(output.status,0,output.stderr);
 const rows=output.stdout.trim().split('\n').map(JSON.parse);
 assert.equal(rows.length,requests.length);
 for(let i=0;i<requests.length;i++)assert.deepStrictEqual(rows[i],reference(requests[i]),`Mermaid mismatch ${i}: ${JSON.stringify(requests[i])}`);
 console.log(`Verified ${requests.length} Mermaid parser head-to-head cases`);
});

const fixtureGraph = `stateDiagram-v2
[*] --> Idle
Idle --> Active: go [ready] / write, notify
Idle --> Failed: go [denied] / alert
Active --> Done: finish / persist
Done --> [*]
Failed --> [*]`;
const guardAndActionGraphs=[fixtureGraph,
 `stateDiagram-v2\n[*] --> Idle\nIdle --> Active: go [ready] / write\nActive --> [*]`,
 `stateDiagram-v2\n[*] --> Idle\nIdle --> Active: go / write\nActive --> [*]`,
 `stateDiagram-v2\n[*] --> Idle\nIdle --> Active: go [missing] / write\nActive --> [*]`,
 `stateDiagram-v2\n[*] --> Idle\nIdle --> Active: go [ready] / missing\nActive --> [*]`,
];
const engineRequests=[];
const basicGuards={ready:{field:'ready'},denied:{field:'denied'},missing:{result:true}};
const basicActions={write:{async:false},notify:{async:true},alert:{declarative:true},persist:{async:false},missing:{async:false}};
for(const source of guardAndActionGraphs) for(const method of ['transitionsFrom','assertStateTransition','enabledSync','transitionSync','enabled','transition']) {
 for(const from of ['Idle','Active','Unknown']) for(const [event,context] of [
 ['go',{ready:true,denied:false}], ['go',{ready:false,denied:true}],
 ['go',{ready:false,denied:false}], ['go',{ready:true,denied:true}],
 ['finish',{ready:true}], ['nonexistent',{}],
 ]){
  engineRequests.push({op:'workflowEngineScenario',method,source,from,to:'Active',event,context,guards:basicGuards,actions:basicActions});
 }
}
for(const source of guardAndActionGraphs) for(const method of ['transitionSync','transition','enabledSync','enabled']) {
 for(const [guards,actions] of [
 [{ready:{async:true,result:true},denied:{result:false},missing:{result:true}},basicActions],
 [basicGuards,{...basicActions,write:{async:true}}],
 [{ready:{result:true},denied:{result:true}},basicActions],
 [basicGuards,{}],
 [{},basicActions],
 ]){
  engineRequests.push({op:'workflowEngineScenario',method,source,from:'Idle',to:'Active',event:'go',context:{ready:true},guards,actions});
 }
}
// A throwing or rejected Guard/Action must abort the transition instead of
// being misclassified as a disabled edge or successful effect.
for (const method of ['enabledSync','enabled','transitionSync','transition']) {
 for(const [guards,actions] of [
  [{ready:{error:'guard failed'},denied:{result:false}},basicActions],
  [{ready:{field:'ready'},denied:{result:false}},{...basicActions,write:{error:'sync action failed'}}],
  [{ready:{field:'ready'},denied:{result:false}},{...basicActions,notify:{async:true,error:'async action failed'}}],
  [{ready:{async:true,result:true},denied:{result:false}},basicActions],
 ]) {
  // Node transitionSync throws after an async Action returns its Promise; if
  // that Promise is rejected the Node test process itself gets an unrelated
  // unhandledRejection. Exercise the rejection only through awaitable paths.
  if (method==='transitionSync' && actions.notify?.error) continue;
  engineRequests.push({op:'workflowEngineScenario',method,source:fixtureGraph,from:'Idle',to:'Active',event:'go',context:{ready:true,denied:false},guards,actions});
 }
}
for(const method of ['enabled','transition']) {
 engineRequests.push({op:'workflowEngineScenario',method,source:fixtureGraph,from:'Idle',to:'Active',event:'go',context:{ready:true,denied:false},guards:{ready:{async:true,error:'rejected guard'},denied:{result:false}},actions:basicActions});
}
for(const method of ['assertStateTransition']) for(const [from,to,kind] of [
 ['Idle','Idle','workflow'],['Idle','Active','workflow'],['Unknown','Unknown','workflow'],
 ['Unknown','Active','task'],['Idle','Unknown','Task'],['Idle','Done','workflow'],
 ])engineRequests.push({op:'workflowEngineScenario',method,source:fixtureGraph,from,to,kind,guards:basicGuards,actions:basicActions});

async function runNodeEngine(request){
 try{
  const graph=parseExecutableMermaid(request.source);
  const guards={};
  for(const [key,description] of Object.entries(request.guards??{})){
   const decide=ctx=> {if(description?.error)throw Error(description.error);
     return description?.field!==undefined?Boolean(ctx[description.field]):
       typeof description==='boolean'?description:Boolean(description?.result)};
   guards[key]=description?.async?async ctx=>decide(ctx):ctx=>decide(ctx);
  }
  const trace=[];
  const actions={};
  for(const [key,description] of Object.entries(request.actions??{})){
   actions[key]=description?.declarative?{declarative:true}:
     description?.async?async()=>{trace.push(key);if(description.error)throw Error(description.error)}:
       ()=>{trace.push(key);if(description?.error)throw Error(description.error)};
  }
  const engine=new WorkflowEngine(graph,guards,actions);
  const {method,from,to,event,context,kind}=request;
  let result;
  switch(method){
   case 'transitionsFrom':result=engine.transitionsFrom(from);break;
   case 'assertStateTransition':result=engine.assertStateTransition(from,to,kind);break;
   case 'enabledSync':result=engine.enabledSync(from,event,context);break;
   case 'transitionSync':result=engine.transitionSync(from,event,context);break;
   case 'enabled':result=await engine.enabled(from,event,context);break;
   case 'transition':result=await engine.transition(from,event,context);break;
   default:throw Error('unsupported fixture');
  }
  return {ok:true,value:{result:result===undefined?null:result,trace}};
 }catch(error){return {ok:false,error:error.message};}
}

test('WorkflowEngine sync/async guard, transition, action, and validation parity',async()=>{
 const build=spawnSync('cargo',['build','--offline','--manifest-path','rust/Cargo.toml'],{cwd:root,encoding:'utf8',timeout:90000});
 assert.equal(build.status,0,build.stderr);
 const actual=spawnSync(binary,[],{input:engineRequests.map(JSON.stringify).join('\n')+'\n',encoding:'utf8',maxBuffer:16*1024*1024});
 assert.equal(actual.status,0,actual.stderr);
 const values=actual.stdout.trim().split('\n').map(JSON.parse);
 assert.equal(values.length,engineRequests.length);
 for(let i=0;i<engineRequests.length;i++) {
  const expected=await runNodeEngine(engineRequests[i]);
  assert.deepStrictEqual(values[i],expected,`Graph runtime mismatch ${i}: ${JSON.stringify(engineRequests[i])}`);
 }
 console.log(`Verified ${engineRequests.length} WorkflowEngine runtime head-to-head cases`);
});
