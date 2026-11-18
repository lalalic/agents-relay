// Node src/local-authority-store.ts + src/projected-store.ts vs Rust Store
// facades. Actual disposable SQLite for all writes, no live Job/GitHub/API.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {SQLiteRelayStore} from '../../dist/relay-store.js';
import {LocalAuthorityDurableStore} from '../../dist/local-authority-store.js';
import {ProjectedDurableStore} from '../../dist/projected-store.js';
import {InMemoryStore} from '../../dist/store.js';

const root=resolve(import.meta.dirname,'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');
const scratch=mkdtempSync(join(tmpdir(),'rust2-store-facade-'));
test.after(()=>rmSync(scratch,{force:true,recursive:true}));
const at='2026-11-17T10:00:00.000Z';
let seed=0xacf547;function random(){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;}
const scenarios=[];
function scenario(variant,index){
 const jobId=String(101+index);
 const job={id:jobId,title:'Example-'+index,repository:'fixture',prNumber:0,
  state:'ACTIVE',projectRoot:join(scratch,'repo-'+index),createdAt:at,updatedAt:at,
  continuation:null,tasks:[],plans:[],review:null};
 const facts={state:'OPEN',head:{ref:'refs/heads/main',sha:'a'.repeat(40)},observedAt:at};
 const agent={id:'reviewer-'+index,name:'Reviewer',capabilities:['review'],skills:[]};
 const taskId='1',executionId='exec-'+index;
 const record={jobId,taskId,executionId,leaseOwner:'relay',host:'127.0.0.1',
  pid:500+index,pgid:500+index,startToken:'token-'+index,observedAt:at,endedAt:null};
 const identity={jobId,taskId,executionId,attempt:1,leaseOwner:'relay'};
 const delivery={jobId,taskId,eventId:'host-event-'+index,invocationId:'inv-'+index,
  executionId,revision:'rev1',decision:'approved',deliveredAt:at};
 const common={jobId,taskId,executionId};
 const actions=[
  {method:'saveJob',job},
  {method:'load',id:jobId},
  {method:'listAgents'},
  {method:'saveAgent',agent},
  {method:'pendingProjectionCount'},
  {method:'saveAgent',agent},
  {method:'pendingProjectionCount'},
  {method:'listAgents'},
  {method:'applyPullRequestFacts',facts},
  {method:'pullRequestState'},
  {method:'pullRequestHead'},
  {method:'recordExecutionProcess',record},
  {method:'loadExecutionProcess',...common},
  {method:'recordExecutionProcess',record},
  {method:'finishExecutionProcess',...common},
  {method:'loadExecutionProcess',...common},
  {method:'hasHostInvocationDecision',...common,invocationId:delivery.invocationId},
  {method:'recordHostInvocationEvent',delivery,outcome:'ignored',fingerprint:'fp-'+index},
  {method:'hasHostInvocationDecision',...common,invocationId:delivery.invocationId},
 ];
 if(variant==='projected'){
  const eventId='event-'+index;
  actions.push(
   {method:'markEventProcessed',eventId,stream:'events',sequence:1},
   {method:'markEventProcessed',eventId,stream:'events',sequence:1},
   {method:'markEventProcessed',eventId:eventId+'-2',stream:null,sequence:null},
  );
 }else{
  actions.push(
   {method:'verifyWorkflowLaunch',...common},
  );
 }
 // End with a durable reload to check that process/host events did not
 // accidentally alter the canonical Job snapshot.
 actions.push({method:'load',id:jobId});
 return {variant,actions};
}
for(let i=0;i<12;i++){
 scenarios.push(scenario('local',i),scenario('projected',i+12));
}
async function onNode(fixture){
 const db=new SQLiteRelayStore(':memory:');
 const store=fixture.variant==='local'?
  new LocalAuthorityDurableStore(db,new InMemoryStore()):
  new ProjectedDurableStore(db,new InMemoryStore());
 const outcomes=[];
 try {
  for(const action of fixture.actions){
   const {method}=action;let result;
   try{
    switch(method){
     case 'saveJob': result=await store.saveJob(structuredClone(action.job));break;
     case 'load':result=await store.load(action.id);break;
     case 'listAgents':result=await store.listAgents();break;
     case 'pendingProjectionCount':result=await db.pendingProjectionCount();break;
     case 'saveAgent':result=await store.saveAgent(action.agent);break;
     case 'applyPullRequestFacts':result=await store.applyPullRequestFacts(action.facts);break;
     case 'pullRequestState':result=await store.pullRequestState();break;
     case 'pullRequestHead':result=await store.pullRequestHead();break;
     case 'recordExecutionProcess':result=await store.recordExecutionProcess(action.record);break;
     case 'loadExecutionProcess':result=await store.loadExecutionProcess(action.jobId,action.taskId,action.executionId);break;
     case 'finishExecutionProcess':result=await store.finishExecutionProcess(action.jobId,action.taskId,action.executionId);break;
     case 'markEventProcessed':result=await store.markEventProcessed(action.eventId,action.stream,action.sequence);break;
     case 'hasHostInvocationDecision':result=await store.hasHostInvocationDecision(action.jobId,action.taskId,action.invocationId,action.fingerprint);break;
     case 'recordHostInvocationEvent':result=await store.recordHostInvocationEvent(action.delivery,action.outcome,action.fingerprint);break;
     case 'verifyWorkflowLaunch':result=await store.verifyWorkflowLaunch(action.jobId,action.taskId,action.executionId);break;
     default:throw new Error('Unknown test method '+method);
    }
    const normalized=result===undefined?null:structuredClone(result);
    if(method==='loadExecutionProcess'&&normalized?.endedAt)normalized.endedAt='SET';
    outcomes.push({ok:true,value:normalized});
   }catch(error){outcomes.push({ok:false,error:error.message});}
  }
 }finally{db.close();}
 return outcomes;
}
test('Node and Rust facade methods commit identical isolated SQLite state, events and process identity',async()=>{
 const expected=[];
 for(const f of scenarios)expected.push(await onNode(f));
 const run=spawnSync(binary,[],{
  input:scenarios.map(f=>JSON.stringify({op:'storeFacadeDelegation',...f})).join('\n')+'\n',
  cwd:root,encoding:'utf8',timeout:120000,maxBuffer:20*1024*1024,
  env:{...process.env,AGENTS_RELAY_STORE_DIR:join(scratch,'stores')},
 });
 assert.equal(run.status,0,run.stderr||run.error?.message);
 const actual=run.stdout.trim().split('\n').map(JSON.parse);
 assert.equal(actual.length,scenarios.length);
 const mismatches=[];
 for(let i=0;i<scenarios.length;i++){
  try{assert.deepEqual(actual[i],{ok:true,value:expected[i]});}
  catch{
   for(let j=0;j<expected[i].length;j++){
    if(JSON.stringify(actual[i]?.value?.[j])!==JSON.stringify(expected[i][j])){
      // Exact deep-equivalence, ignoring JSON key order; this summary prints
      // only the first failing action per scenario for diagnosis.
      try{assert.deepEqual(actual[i]?.value?.[j],expected[i][j]);}
      catch {mismatches.push({scenario:i,variant:scenarios[i].variant,action:scenarios[i].actions[j],node:expected[i][j],rust:actual[i]?.value?.[j]});break;}
    }
   }
  }
 }
 assert.deepEqual(mismatches.slice(0,12),[],`${mismatches.length} scenarios differ`);
 console.log(`Verified ${scenarios.length} Node/Rust real SQLite facade scenarios across ${scenarios.reduce((n,s)=>n+s.actions.length,0)} public API calls`);
});
