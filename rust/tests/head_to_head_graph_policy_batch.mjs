// Direct Node/Rust test for ten Node modules: Graph dispatcher + nine canonical workflow policy wrappers.
// No real Git, Relay services, cloud APIs, user Jobs or production SQLite access.
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {dirname,resolve,join} from 'node:path';import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import * as dep from '../../dist/workflow/dependency-revision-v2.js';
import * as unblock from '../../dist/workflow/authoritative-unblock-v2.js';
import * as restate from '../../dist/workflow/force-restate-validation-v2.js';
import * as planner from '../../dist/workflow/planner-trigger-v2.js';
import * as trouble from '../../dist/workflow/troubleshooter-v2.js';
import * as recovery from '../../dist/workflow/blocker-recovery.js';
import * as resolution from '../../dist/workflow/blocker-resolution-v2.js';
import * as revision from '../../dist/workflow/revision-v2.js';
import * as conflict from '../../dist/workflow/projection-conflict-v2.js';
import {parseGraphV2,GraphRuntime} from '../../dist/workflow/graph-v2.js';
import {dispatchWorkflowGraphSync,dispatchWorkflowGraph,dispatchWorkflowTargetOverride} from '../../dist/workflow/dispatcher.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const directory=join(root,'workflow');
const binary=join(root,'rust/target/debug/relay-rust2-parity');
let compiled=false;
function rust(req){if(!compiled){const b=spawnSync('cargo',['build','--offline','--manifest-path','rust/Cargo.toml'],{cwd:root,encoding:'utf8',timeout:90000});assert.equal(b.status,0,b.stderr);compiled=true;}
 const r=spawnSync(binary,[],{input:JSON.stringify(req)+'\n',encoding:'utf8',timeout:10000,maxBuffer:8*1024*1024});assert.equal(r.status,0,`${r.error}: ${r.stderr}`);return JSON.parse(r.stdout.trim());}
function reply(value){return {ok:true,value:JSON.parse(JSON.stringify(value))};}
const graphModules={
 'dependency-revision':dep.dependencyRevisionLifecycle,
 'authoritative-unblock':unblock.authoritativeUnblockV2,
 'force-restate-validation':restate.forceRestateValidationV2,
 'planner-trigger':planner.plannerTriggerV2,
 'troubleshooter':trouble.troubleshooterV2,
 'blocker-recovery':recovery.blockerRecoveryGraph,
 'blocker-resolution':resolution.blockerResolutionV2,
 'revision-lifecycle':revision.revisionLifecycle,
 'projection-conflict':conflict.projectionConflictV2,
 'projection-outbox-conflict':conflict.projectionOutboxConflictV2,
};
const eventsOf=g=>[...g.registry.events.keys()];
const statesOf=g=>[...g.graph.nodes.values()].filter(n=>n.kind==='state').map(n=>n.semanticId);
async function nodePolicy(req){
 const {policy,state,event,facts,dispatch,actionErrors,receipts}=req;
 const executed=[];
 const execute=id=>{executed.push(id);if(actionErrors?.[id])throw new Error(actionErrors[id]);return receipts?.[id]??{}};
 try{
  let decision;
  switch(policy){
   case 'dependency-revision':decision=dep.decideDependencyRevision(event,facts,state);break;
   case 'authoritative-unblock':decision=dispatch?await unblock.dispatchAuthoritativeUnblock(facts.blockedTroubleshooter===true,execute):unblock.decideAuthoritativeUnblock(facts.blockedTroubleshooter===true);break;
   case 'force-restate-validation':decision=restate.decideForceRestateValidation(facts);break;
   case 'planner-trigger':decision=planner.dispatchPlannerTrigger(facts);break;
   case 'troubleshooter':decision=trouble.dispatchTroubleshooter(facts,()=>{executed.push('troubleshooter.create');if(actionErrors?.['troubleshooter.create'])throw Error(actionErrors['troubleshooter.create']);});break;
   case 'blocker-recovery':decision=await recovery.dispatchBlockerRecovery(facts,execute);break;
   case 'blocker-resolution':decision=dispatch?await resolution.dispatchBlockerResolution(facts,execute):resolution.decideBlockerResolution(facts);break;
   case 'revision-lifecycle':decision=dispatch?await revision.dispatchRevisionLifecycle(state,event,facts,execute):revision.decideRevisionLifecycle(state,event,facts);break;
   case 'projection-conflict':decision=conflict.decideProjectionDelivery(state,event,facts);break;
   case 'projection-outbox-conflict':decision=conflict.decideProjectionFailure(facts);break;
   default:throw Error('invalid policy');
  }
  return reply({decision,executed});
 }catch(error){return {ok:false,error:error.message};}
}
function runtimeFromSource(source){
 const graph=parseGraphV2(source),states=new Set(),guards={},actions={},events={};
 for(const node of graph.nodes.values()){
  if(node.kind==='state')states.add(node.semanticId);
  if(node.kind==='guard')guards[node.semanticId]=ctx=>ctx.durableFacts[node.semanticId]===true;
  if(node.kind==='action')actions[node.semanticId]={id:node.semanticId};
  if(node.kind==='emit')events[node.semanticId]={id:node.semanticId};
 }
 for(const edge of graph.edges){
  if(edge.kind==='on'||edge.kind==='emit')events[edge.semanticId]={id:edge.semanticId};
  if(edge.kind==='request')actions[edge.semanticId]={id:edge.semanticId};
 }
 return new GraphRuntime(graph,{states,guards,actions,events});
}
async function nodeDispatcher(req){
 try{
  const runtime=runtimeFromSource(req.source),executed=[],transitions=[],events=[];
  const options={initialState:req.initialState,input:req.input,durableFacts:req.facts,maxSteps:req.maxSteps,
    isTransientState:state=>req.transientPrefix?state.startsWith(req.transientPrefix):false,
    persistTransition:(source,target)=>transitions.push({source,target}),
    executeAction:id=>{executed.push(id);if(req.actionErrors?.[id])throw Error(req.actionErrors[id]);return req.receipts?.[id]??{};},
    publishEvent:(id,payload)=>events.push({id,payload})};
  const decision=req.async?await dispatchWorkflowGraph(runtime,options):dispatchWorkflowGraphSync(runtime,options);
  return reply({decision,executed,transitions,events});
 }catch(error){return {ok:false,error:error.message}}
}
let seed=0x9d340317;
const rand=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n};
const pick=a=>a[rand(a.length)];
const policyNames=Object.keys(graphModules);
const cases=[];
for(const policy of policyNames){
 const graph=graphModules[policy];
 const states=statesOf(graph),events=eventsOf(graph),guards=[...graph.registry.guards.keys()];
 const actions=[...graph.registry.actions.keys()];
 for(let i=0;i<235;i++){
  const facts=Object.fromEntries(guards.flatMap(guard=>[
      [guard,pick([true,false,null,'true',0,1])],
      [guard.replace(/^delivery\./,''),pick([true,false,null,'true',0,1])]
  ]));
  facts.attempts=pick([0,1,2,3,4,5,'2','invalid',null,undefined]);
  facts.maxAttempts=pick([1,2,3,4,5,'4','invalid',null,undefined]);
  facts.blockedTroubleshooter=pick([true,false]);
  const state=pick([...states,'UNKNOWN']);
  const event=pick([...events,'unknown-event']);
  const dispatch=pick([true,false]);
  const receipts=Object.fromEntries(actions.map(name=>[name,pick([{}, {ok:true}, {payloads:{'done':{ok:true}}}])]));
  const actionErrors=i%31===0?Object.fromEntries(actions.slice(0,1).map(id=>[id,'fixture denied action'])):{};
  cases.push({op:'workflowPolicyScenario',directory,policy,state,event,facts,dispatch,receipts,actionErrors});
 }
}
test('all nine source policy wrappers are Node-exact Graph decisions with transient guards and action callbacks',async()=>{
 for(let i=0;i<cases.length;i++){
  const request=JSON.parse(JSON.stringify(cases[i]));
  const actual=rust(request),expected=await nodePolicy(request);
  assert.deepEqual(actual,expected,`policy fixture ${i}: ${JSON.stringify(request).slice(0,520)}`);
 }
 console.log(`Verified ${cases.length} Node/Rust Graph domain-policy dispatcher histories across ${policyNames.length} Graph profiles`);
});
const dispatchSource=[
 'flowchart LR\n%% relay: initial a\na["state: idle"]\nb["state: done"]\na -->|on: finish| b',
 'flowchart TD\n%% relay: initial a\na["state: idle"]\ng["guard: ready"]\nb["state: done"]\na -->|on: finish| g\ng -->|true| b\ng -->|false| a',
 'flowchart LR\n%% relay: initial a\na["state: idle"]\naction["action: effect.process"]\ne["emit: notified"]\nb["state: done"]\na -->|on: finish| action\naction -->|emit: notified| e\naction -->|to: done| b',
 'flowchart TD\n%% relay: initial a\na["state: idle"]\nmid["state: check_in_progress"]\nb["state: done"]\na -->|on: finish| mid\nmid -->|on: finish| b',
];
const dispatchCases=[];
for(let i=0;i<760;i++){
 const source=pick(dispatchSource);
 const facts={ready:pick([true,false,null])};
 const req={op:'workflowDispatcherScenario',source,initialState:pick(['idle','check_in_progress','done','unrecognized']),
   input:{transport:'event',id:pick(['finish','bad','notified']),payload:{fixture:i}},facts,
   maxSteps:pick([0,1,2,3,5]),transientPrefix:pick(['check_','done','idle',null]),async:rand(2)===0,
   receipts:{'effect.process':pick([{}, {ok:true}, {payloads:{notified:{fixture:i}}},{ok:false,failureEvent:{id:'notified',payload:{failed:true}}}])},
   actionErrors:i%41===0?{'effect.process':'fixture action execution failed'}:{}};
 dispatchCases.push(req);
}
test('Graph dispatcher owns transition persistence, action execution, emitted events and transient replay, sync and async',async()=>{
 for(let i=0;i<dispatchCases.length;i++){
  const req=JSON.parse(JSON.stringify(dispatchCases[i]));
  assert.deepEqual(rust(req),await nodeDispatcher(req),`dispatcher fixture ${i}: ${JSON.stringify(req).slice(0,580)}`);
 }
 console.log(`Verified ${dispatchCases.length} direct Node/Rust Graph dispatcher source/event/action/receipt histories`);
});
