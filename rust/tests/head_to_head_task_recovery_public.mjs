// All four public src/task-recovery.ts APIs original Node vs native Rust.
// Injected DurableStore commits snapshots; no outbound notification provider.
import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';import {resolve} from 'node:path';
import * as n from '../../dist/task-recovery.js';
const root=resolve(import.meta.dirname,'../..'),bin=resolve(root,'rust/target/debug/relay-rust2-parity');
const now='2026-11-18T20:00:00.000Z';
const request={requiredAction:'Investigate provider failure',resolutionCondition:'User verifies restored provider',context:'The original job hit an unverified failure and requires investigation',notification:{channel:'neo-mobile'}};
const baseTask=(id,state)=>({id,jobId:'17',kind:'work',state,agentName:id==='2'?'implementation':'troubleshooter',
 adapter:'script',attempt:1,maxAttempts:2,input:'perform recovery',dependencies:[],
 ...(id==='3'?{parentTaskId:'2'}:{}),
 createdAt:now,updatedAt:now});
const job=(state='ACTIVE',r='RUNNING',o='FAILED')=>({id:'17',repository:'fixture',state,title:'Recover original failure',
 tasks:[baseTask('2',o),baseTask('3',r)],plans:[],createdAt:now,updatedAt:now});
const esc=(status='pending',notification='pending')=>({id:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',originalTaskId:'2',
 requiredAction:request.requiredAction,resolutionCondition:request.resolutionCondition,
 context:request.context,status,requestedAt:now,fingerprint:'external-fingerprint',
 notification:notification==='delivered'?{status:'delivered',channel:'neo-mobile',deliveryId:'delivery-9',deliveredAt:now}: {status:'pending',channel:'relay-event',requestedAt:now}});
const fixtures=[];
for(const state of ['ACTIVE','PAUSED','COMPLETED','CANCELLED'])for(const recovery of ['RUNNING','QUEUED','FAILED','BLOCKED','SUCCEEDED','DRAFT'])
 for(const original of ['FAILED','RUNNING']){
 const fresh=job(state,recovery,original);
 fixtures.push({op:'certTaskRecovery',action:'request',job:fresh,request,taskId:'3',now});
}
for(const state of ['BLOCKED','RUNNING','FAILED','QUEUED'])for(const status of ['pending','responded'])
 for(const response of ['Restore verified provider',' ', 'retry in CI']){
 const fresh=job('ACTIVE',state);fresh.tasks[1].escalation=esc(status);
 fixtures.push({op:'certTaskRecovery',action:'resume',job:fresh,taskId:'3',response,now});
}
for(const status of ['pending','responded'])for(const recovery of ['BLOCKED','RUNNING','DRAFT','FAILED']){
 const fresh=job('ACTIVE',recovery);fresh.tasks[1].escalation=esc(status);
 fixtures.push({op:'certTaskRecovery',action:'hasPending',job:fresh,original:fresh.tasks[0]});
}
for(const status of ['pending','responded'])for(const prior of ['pending','delivered'])for(const channel of ['neo-mobile','','another'])
 for(const id of ['delivery-9','delivery-10','']){
 const fresh=job('ACTIVE','BLOCKED');fresh.tasks[1].escalation=esc(status,prior);
 fixtures.push({op:'certTaskRecovery',action:'receipt',job:fresh,taskId:'3',
 escalationId:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',receipt:{channel,deliveryId:id,deliveredAt:now}});
}
function clean(val){return JSON.parse(JSON.stringify(val,(key,value)=>{
 if(key==='id'&&typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f-]{27,}$/.test(value))return '<uuid>';
 if(typeof value==='string' && /^\d{4}-\d\d-\d\dT/.test(value) && ['updatedAt','createdAt','requestedAt','respondedAt','at'].includes(key))return '<clock>';
 return value;
}));}
function rust(){const proc=spawnSync(bin,[],{cwd:root,input:fixtures.map(JSON.stringify).join('\n')+'\n',encoding:'utf8',timeout:40000,maxBuffer:13e6});assert.equal(proc.status,0,proc.stderr);return proc.stdout.trim().split('\n').map(JSON.parse);}
function store(value){let current=structuredClone(value);return{
  async load(){return structuredClone(current);},
  async mutateJob(_id,fn){current=structuredClone(await fn(structuredClone(current)));return current;},
  async commitWorkflowMutationWithEvents(_id,fn){const r=await fn(structuredClone(current));current=structuredClone(r.next);return current;},
  get current(){return current;},
};}
async function original(f){const stub=store(f.job);
 try{
 let value;
 switch(f.action){
 case 'request':value=await n.requestTroubleshooterEscalation(stub,'17',f.taskId,f.request,f.now);break;
 case 'resume':value=await n.resumeTroubleshooter(stub,'17',f.taskId,f.response,f.now);break;
 case 'hasPending':value=n.hasPendingTroubleshooterEscalation(f.job,f.original);break;
 case 'receipt':{
  const escalation=await n.recordEscalationNotificationDelivery(stub,'17',f.taskId,f.escalationId,f.receipt);
  value={job:stub.current,escalation};break;
 }
 }
 return {ok:true,value:clean(value)};
 }catch(e){return {ok:false,error:e.message};}
}
test('original Node/Rust Escalation request/resume/notification/duplicate and pending guards',async()=>{
 const expected=[];for(const f of fixtures)expected.push(await original(f));
 const result=rust();assert.equal(result.length,expected.length);
 for(let i=0;i<fixtures.length;i++){
  const actual=result[i].ok?{ok:true,value:clean(result[i].value)}:result[i];
  assert.deepEqual(actual,expected[i],`Task recovery case ${i} ${fixtures[i].action}`);
 }
 console.log(`${fixtures.length} original Node/Rust 4 escalation API cases validated`);
});
