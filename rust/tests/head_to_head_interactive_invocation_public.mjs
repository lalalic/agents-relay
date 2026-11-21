// Real original Node src/interactive-invocation.ts vs native Rust public
// Host event/normalizer/fingerprint/Graph recovery and atomic bind candidates.
// Test-owned in-memory fixture data; no external UI, provider or live Job.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import * as nodeApi from '../../dist/interactive-invocation.js';
const root=resolve(import.meta.dirname,'../..');
const bin=resolve(root,'rust/target/debug/relay-rust2-parity');
const NOW='2026-11-19T09:30:00.000Z';
const context={jobId:'41',taskId:'12',executionId:'exec-1'};
const feedback={eventId:'event-123',decision:'approved',feedback:'approved by owner',comments:[]};
const valid=nodeApi.hostInteractiveDecisionEvent(context,feedback,NOW);
const cases=[];
for(const decision of ['approved','changes_requested','invalid',null]){
 for(const eventId of ['event-123','',null]){
  cases.push({method:'hostEvent',context,feedback:{...feedback,eventId,decision},now:NOW});
 }
}
for(const replacement of [
 {},
 {jobId:''},{taskId:''},{executionId:''},{decision:'invalid'},
 {feedback:null},{feedback:42},{feedback:''},
 {invocationId:'forged'},{revision:'forged'},{commitSha:'a'},
 {contentHash:'a'}, {revisionId:'a'},
 {comments:[{text:'OK'}]},{comments:[{text:77}]},
 {comments:[]},{comments:101},{comments:Array.from({length:101},()=>({text:'a'}))},
 {previewId:'preview'},{requestId:'request'}, {idempotencyKey:'k'},
]){
 const event=structuredClone(valid);
 Object.assign(event.data.interactive,replacement);
 cases.push({method:'normalize',event});
}
for(const replacement of [
 {type:'other'},{source:{id:'forged'}},
 {job_id:'wrong'}, {task_id:'wrong'},
 {data:{interactive:null}},{data:{interactive:[]}},
 {data:{interactive:{...valid.data.interactive,revision:'forged'}}},
]){
 const event=structuredClone(valid);
 Object.assign(event,replacement);
 cases.push({method:'normalize',event});
}
const basic=nodeApi.normalizeInteractiveDecision(valid);
for(const data of [
 basic,{...basic,decision:'changes_requested'},
 {...basic,feedback:'new feedback'},
 {...basic,feedback:''},
 {...basic,comments:[{text:'a'}, {text:'b'}]},
 {...basic,comments:null},
 {...basic,requestId:'request-1'},
 {...basic,idempotencyKey:'idempotent'},
 {...basic,revision:'new-generation'},
 {...basic,previewId:'prev'},
]){
 cases.push({method:'fingerprint',delivery:data});
 cases.push({method:'eligible',delivery:data});
}
for(const status of ['awaiting_decision','changes_requested','approved','invalid']){
 cases.push({method:'recover',status});
}
const stamp=NOW;
function job(state='RUNNING',execution='exec-1',invocation){
 const task={id:'12',jobId:'41',kind:'work',state,
   executionId:execution,agentName:'worker',adapter:'script',
   attempt:1,maxAttempts:3,createdAt:stamp,updatedAt:stamp};
 if(invocation)task.interactiveInvocation=invocation;
 return {id:'41',state:'ACTIVE',repository:'fixture',title:'Interactive fixture',
  tasks:[task],plans:[],createdAt:stamp,updatedAt:stamp};
}
for(const [current,executionId] of [
 [job(),'exec-1'],[job('QUEUED'),'exec-1'],[job('FAILED'),'exec-1'],
 [job('RUNNING','exec-other'),'exec-1'],[job('RUNNING','exec-1'),'wrong'],
 [job('RUNNING','exec-1',{invocationId:'exec-1',revision:'exec-1',
  executionId:'exec-1',status:'awaiting_decision',boundAt:stamp}),'exec-1'],
 [job('RUNNING','exec-1',{invocationId:'exec-1',revision:'bad',
  executionId:'exec-1',status:'awaiting_decision',boundAt:stamp}),'exec-1'],
 [job('RUNNING','exec-1',{invocationId:'old',revision:'old',
  executionId:'old',status:'changes_requested',boundAt:stamp}),'exec-1'],
 ]){
 cases.push({method:'bind',job:current,taskId:'12',executionId,now:NOW});
}
function clean(value){return JSON.parse(JSON.stringify(value));}
async function nodeResult(f){
 try{
  let value;
  switch(f.method){
   case 'hostEvent': value=nodeApi.hostInteractiveDecisionEvent(f.context,f.feedback,f.now);break;
   case 'normalize': value=nodeApi.normalizeInteractiveDecision(f.event);break;
   case 'fingerprint':value=nodeApi.interactiveDecisionFingerprint(f.delivery);break;
   case 'eligible':value=nodeApi.eventOnlyReviewEligible(f.delivery);break;
   case 'recover':value=await nodeApi.shouldRecoverInteractiveDecision(f.status);break;
   case 'bind':{
    let current=structuredClone(f.job);
    const coordinator=new nodeApi.HostInteractiveInvocationCoordinator({
     store:{
      loadJob:async()=>structuredClone(current),
      mutateJob:async(_jobId,mutate)=>{
       current=structuredClone(await mutate(structuredClone(current)));
       return structuredClone(current);
      }
     }, now:()=>new Date(f.now)
    });
    try{
     await coordinator.bind(current.id,structuredClone(current.tasks[0]),f.executionId);
     value=current;
    }finally{coordinator.close();}
    break;
   }
  }
  return {ok:true,value:clean(value)};
 }catch(error){return {ok:false,error:error.message};}
}
test('original Node/Rust public Host interactive decisions, fingerprints, Graph, bind',async()=>{
 const expected=[];for(const f of cases)expected.push(await nodeResult(f));
 const run=spawnSync(bin,[],{cwd:root,encoding:'utf8',timeout:60000,maxBuffer:12e6,
  input:cases.map(f=>JSON.stringify({op:'interactiveInvocationContract',...f})).join('\n')+'\n'});
 assert.equal(run.status,0,run.stderr);
 const output=run.stdout.trim().split('\n').map(JSON.parse);
 assert.equal(output.length,cases.length);
 for(let i=0;i<cases.length;i++){
  assert.equal(output[i].ok,true,JSON.stringify(output[i]));
  assert.deepEqual(clean(output[i].value.outcome),expected[i],
   'case '+i+' method '+cases[i].method+' payload '+JSON.stringify(cases[i]).slice(0,350));
 }
 console.log('Host Interactive Node/Rust direct API parity: '+cases.length+' cases');
});
