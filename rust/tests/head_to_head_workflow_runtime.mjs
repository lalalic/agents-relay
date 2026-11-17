// Direct Node/Rust differential for src/workflow/runtime.ts: mutation effects are mechanical, Graph still owns transition policy.
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {dirname,resolve} from 'node:path';import {fileURLToPath} from 'node:url';
import * as runtime from '../../dist/workflow/runtime.js';
import {parseExecutableMermaid,WorkflowEngine} from '../../dist/workflow/mermaid.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),bin=resolve(root,'rust/target/debug/relay-rust2-parity');let built=false;
function rust(req){if(!built){const b=spawnSync('cargo',['build','--offline','--manifest-path','rust/Cargo.toml'],{cwd:root,encoding:'utf8',timeout:90000});assert.equal(b.status,0,b.stderr);built=true;}
 const r=spawnSync(bin,[],{input:JSON.stringify(req)+'\n',encoding:'utf8',timeout:13000,maxBuffer:8*1024*1024});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout.trim());}
function node(req){try{let value;
 if(req.op==='graphWorkflowDecision'){
   const graph=parseExecutableMermaid(req.source),guards=Object.fromEntries(graph.transitions.filter(t=>t.guard).map(t=>[t.guard,()=>req.guards[t.guard]??false]));
   const actions=Object.fromEntries(graph.transitions.flatMap(t=>t.actions).map(name=>[name,{declarative:true}]));
   value=runtime.graphWorkflowDecision(new WorkflowEngine(graph,guards,actions),req.from,req.event,req.facts);
 }else{
   value=structuredClone(req.target);
   switch(req.action){
   case 'applyTaskMutation':runtime.applyTaskMutation(value,req.mutation);break;
   case 'applyTaskGraphTarget':runtime.applyTaskGraphTarget(value,req.state,req.timestamp,req.authoritativeUnblock);break;
   case 'applyJobGraphTarget':runtime.applyJobGraphTarget(value,req.state,req.timestamp);break;
   case 'applyTaskWorkflowDecision':runtime.applyTaskWorkflowDecision(value,req.decision,req.timestamp);break;
   case 'applyJobWorkflowDecision':runtime.applyJobWorkflowDecision(value,req.decision,req.timestamp);break;
   case 'applyHistoricalJobCompatibilityRepair':runtime.applyHistoricalJobCompatibilityRepair(value,req.state,req.timestamp);break;
   default:throw Error('unknown Runtime action');
   }
 }
 return {ok:true,value:JSON.parse(JSON.stringify(value))};}catch(error){return {ok:false,error:error.message}}
}
let seed=0x152188dc;const rand=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n},pick=a=>a[rand(a.length)];
const TIMESTAMP='2026-11-17T05:14:21.000Z';
const mutations=['mutation.clearError','mutation.clearFailureReason','mutation.clearLease','mutation.clearExecution','mutation.markLeaseExpired','mutation.markStartupOrphanedExhausted','mutation.markUnknownOutcome','mutation.markPlannerUnavailable','mutation.preparePlatformFallback','mutation.quarantinePlatformFailure'];
const task=()=>({id:'t',state:pick(['BLOCKED','RUNNING','FAILED','QUEUED']),agentName:pick(['troubleshooter','builder','']),updatedAt:pick([TIMESTAMP,'2026-11-15T01:00:00.000Z','invalid']),
  error:pick([null,'previous error','']),failureReason:pick(['some-reason',undefined]),adapter:pick(['chatgpt','z','script']),
  routing:pick([{provider:'openrouter',model:'gpt-6',profile:'high'},undefined]),workerSelection:pick([{workerId:'x'},undefined]),
  leaseOwner:pick(['relay','',null]),leaseExpiresAt:'2026-11-17T06:00:00.000Z',executionId:pick(['x',null]),attempt:2,
  platformFailure:pick([{classification:'outcome_unknown'}, {classification:'start_ack_timeout'}, {classification:'worker_platform_failure'},undefined])});
const cases=[];
for(let i=0;i<1160;i++){
 const target=task(),state=pick(['QUEUED','BLOCKED','RUNNING','SUCCEEDED','CANCELLED','FAILED']);
 const action=pick(['applyTaskMutation','applyTaskMutation','applyTaskGraphTarget','applyTaskWorkflowDecision','applyJobGraphTarget','applyJobWorkflowDecision','applyHistoricalJobCompatibilityRepair']);
 const mutation=pick(mutations),decision=pick([{accepted:true,target:state,mutations:[mutation],effects:[]},{accepted:true,target:state,mutations:[],effects:[]},{accepted:false,target:null,mutations:[],effects:[]}]);
 cases.push({op:'workflowRuntimeMutation',action,target,state,timestamp:TIMESTAMP,authoritativeUnblock:rand(2)===0,mutation,decision});
}
test('Task/Job graph-authorized mechanical transitions and durable field mutations agree with Node',()=>{
 for(const [i,req] of cases.entries())assert.deepEqual(rust(req),node(req),`runtime mutation ${i}: ${JSON.stringify(req).slice(0,700)}`);
 console.log(`Verified ${cases.length} Node/Rust workflow target and Task/Job mutation cases`);
});
const graphCases=[];
const sources=[
  'stateDiagram-v2\n[*] --> QUEUED\nQUEUED --> RUNNING : dispatch / mutation.clearError, effect.launchTask\nRUNNING --> SUCCEEDED : finished / mutation.clearExecution',
  'stateDiagram-v2\n[*] --> ACTIVE\nACTIVE --> COMPLETED : finish [pass] / effect.cleanupJobWorktree\nACTIVE --> CANCELLED : cancel / mutation.clearError',
  'stateDiagram-v2\n[*] --> QUEUED\nQUEUED --> RUNNING : dispatch [ready] / mutation.clearExecution\nQUEUED --> FAILED : dispatch [notReady] / mutation.markLeaseExpired',
];
for(let i=0;i<850;i++){
 const source=pick(sources),graph=parseExecutableMermaid(source);
 const from=pick([...graph.states,'UNKNOWN']),event=pick(['dispatch','finished','finish','cancel','wrong']);
 graphCases.push({op:'graphWorkflowDecision',source,from,event,facts:{ready:pick([true,false])},guards:{ready:pick([true,false]),notReady:pick([true,false])}});
}
test('workflow graph event decisions and bound guard paths match Node',()=>{
 for(const [i,req] of graphCases.entries())assert.deepEqual(rust(req),node(req),`graph workflow decision ${i}: ${JSON.stringify(req).slice(0,480)}`);
 console.log(`Verified ${graphCases.length} Node/Rust workflow-engine selected event/action decisions`);
});

test('no-start fallback preserves exclusions, clear ownership, and original routing fields',()=>{
  const base={id:'t',state:'RUNNING',updatedAt:TIMESTAMP,adapter:'chatgpt',attempt:3,executionId:'old-execution',
    leaseOwner:'relay',leaseExpiresAt:'2026-11-17T06:00:00Z',error:'No start observed',failureReason:'platform',
    routing:{provider:'openrouter',model:'gpt-6',profile:'high'},workerSelection:{workerId:'model-worker'},routingExclusions:[{adapter:'prior'}]};
  for(let i=0;i<90;i++){
    const target=structuredClone(base);
    if(i%4===0)delete target.routing;
    if(i%5===0)target.error='';
    if(i%6===0)target.adapter='z';
    if(i%7===0)target.adapter='script';
    const req={op:'workflowRuntimeMutation',action:'applyTaskMutation',mutation:'mutation.prepareNoStartFallback',target,timestamp:TIMESTAMP};
    const actual=rust(req),expected=node(req);
    const normal=(out)=>{
      if(!out.ok)return out;
      const value=structuredClone(out.value);
      if(value.noStartFallback)value.noStartFallback.at='DYNAMIC_TIME';
      for(const x of value.routingExclusions??[])if(x.at)x.at='DYNAMIC_TIME';
      return {...out,value};
    };
    assert.deepEqual(normal(actual),normal(expected),`fallback semantics ${i}`);
  }
  console.log('Verified 90 dynamically-timestamped no-start fallback semantic cases');
});
