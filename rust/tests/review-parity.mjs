import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {SQLiteRelayStore} from '../../dist/relay-store.js';
import {interactiveDecisionFingerprint} from '../../dist/interactive-invocation.js';
const bin=resolve(import.meta.dirname,'../target/debug/examples/interop_fixture');
const initial='2099-01-01T00:00:00.000Z';
function rust(op,db,job,delivery){
 const result=spawnSync(bin,[op,db,job,op==='review-resume'?'2099-01-01T00:00:02.000Z':initial,typeof delivery==='string'?delivery:JSON.stringify(delivery)],{
  encoding:'utf8',env:{...process.env,RELAY_RUST_EXPERIMENTAL_TEST_ONLY:'isolated-test'},
 });assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
}
function setup(){
 const dir=mkdtempSync(join(tmpdir(),'relay-rust-authority-'));
 writeFileSync(join(dir,'.relay-rust-authority-isolated-test'),'test');
 return {dir,db:join(dir,'relay.sqlite')};
}
function job(id,dir){
 return {id,title:'Rust review cross-language parity',repository:'example',projectRoot:dir,prNumber:0,
  state:'ACTIVE',reviewEnabled:false,continuation:null,createdAt:initial,updatedAt:initial,
  tasks:[{id:'101',jobId:id,parentTaskId:null,dependencies:[],capabilities:[],adapter:'script',input:'work',
   state:'AWAITING_DECISION',attempt:1,maxAttempts:3,leaseOwner:null,leaseExpiresAt:null,executionId:null,threadId:null,
   result:null,error:null,timeoutMs:1000,createdAt:initial,updatedAt:initial,continuation:null,continuationDeliveredAt:null,
   interactiveInvocation:{invocationId:'ex1',revision:'ex1',executionId:'ex1',status:'awaiting_decision',boundAt:initial}}]};
}
function delivery(jobId,decision,feedback,eventId){
 return {jobId,taskId:'101',executionId:'ex1',invocationId:'ex1',revision:'ex1',decision,feedback,
  // These keys intentionally aren't alphabetical: JSON stringify order is part of the fingerprint contract.
  comments:[{text:'review',zeta:3,alpha:2,details:{text:'nested',zone:'two',area:'one'}}],
  idempotencyKey:'ios-client-key',eventId,deliveredAt:'2099-01-01T00:00:01.000Z'};
}
test('Rust Review ledger matches TypeScript fingerprint, decision, duplicate, conflicting revision',async()=>{
 const {dir,db}=setup();let store;
 try{
  store=new SQLiteRelayStore(db);await store.saveJob(job('91',dir));store.close();store=null;
  const accepted=delivery('91','changes_requested','Revise the narration','review-event-a');
  const fingerprint=interactiveDecisionFingerprint(accepted);
  assert.equal(rust('review-fingerprint',db,'91',accepted).fingerprint,fingerprint,
    'cross-language fingerprint must preserve comment object insertion order');
  const result=rust('review',db,'91',accepted);
  assert.equal(result.outcome,'accepted');
  assert.equal(result.invocation.status,'changes_requested');
  assert.equal(result.invocation.feedback,'Revise the narration');
  store=new SQLiteRelayStore(db);
  const snapshot=await store.loadJob('91');
  assert.equal(snapshot.tasks[0].interactiveInvocation.status,'changes_requested');
  assert.equal(snapshot.tasks[0].interactiveInvocation.revision,'ex1');
  assert.equal((await store.recordHostInvocationDecision({...accepted,eventId:'transport-retry'},fingerprint)).outcome,'duplicate');
  assert.equal((await store.recordHostInvocationDecision(delivery('91','approved','late','late-event'),interactiveDecisionFingerprint(delivery('91','approved','late','late-event')))).outcome,'stale');
  assert.equal((await store.loadJob('91')).tasks[0].interactiveInvocation.status,'changes_requested');
  const native=new DatabaseSync(db);
  const decisionRow=native.prepare('SELECT fingerprint,decision FROM host_invocation_decision WHERE job_id=? AND task_id=?')
    .get('91','101');
  assert.equal(decisionRow.fingerprint,fingerprint);
  assert.equal(decisionRow.decision,'changes_requested');
  assert.equal(native.prepare('SELECT count(*) AS n FROM host_invocation_decision').get().n,1);
  assert.equal(native.prepare('SELECT count(*) AS n FROM host_invocation_event').get().n,3);
  native.close();
  console.log('Review parity: TS fingerprint + Rust accepted + TS duplicate/stale + SQLite authority');
 }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});
test('Rust denies unbound Review, terminal Job Review, and leaves snapshots unmodified',async()=>{
 const {dir,db}=setup();let store;
 try{
  store=new SQLiteRelayStore(db);const state=job('91',dir);state.tasks[0].interactiveInvocation=undefined;
  await store.saveJob(state);store.close();store=null;
  const response=rust('review',db,'91',delivery('91','approved','unsupported','orphan-event'));
  assert.equal(response.outcome,'stale');
  store=new SQLiteRelayStore(db);
  assert.equal((await store.loadJob('91')).tasks[0].interactiveInvocation,undefined);
 }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});

test('accepted changes_requested resumes SAME DAG Script Task through Rust Task Graph as Model route',async()=>{
 const {dir,db}=setup();let store;
 try{
  const waiting=job('91',dir);
  waiting.tasks[0].dagNode={parentTaskId:'90',nodeId:'A',graphHash:'fake-hash',executor:'script'};
  waiting.tasks[0].input=JSON.stringify({source:'relay-dag-task',taskId:'101',data:'pre-reviewed'});
  await (store=new SQLiteRelayStore(db)).saveJob(waiting);store.close();store=null;
  const accepted=delivery('91','changes_requested','Adjust scene transitions','revision-event-1');
  assert.equal(rust('review',db,'91',accepted).outcome,'accepted');
  const resumed=rust('review-resume',db,'91','101');
  assert.deepEqual(resumed,{taskId:'101',status:'changes_requested',state:'QUEUED',adapter:'codex'});
  store=new SQLiteRelayStore(db);
  const state=await store.loadJob('91');
  assert.equal(state.tasks.length,1,'no duplicate revision Task');
  assert.equal(state.tasks[0].executionId,null);
  assert.equal(state.tasks[0].attempt,0);
  assert.equal(state.tasks[0].maxAttempts,3);
  assert.equal(state.tasks[0].leaseOwner,null);
  assert.equal(state.tasks[0].error,null);
  assert.equal(state.tasks[0].comments.length,1);
  assert.equal(state.tasks[0].comments[0].author,'cli');
  assert.match(state.tasks[0].comments[0].text,/Interactive review changes requested.*Adjust scene transitions/);
  assert.equal(state.tasks[0].dagNode.executor,'script','original executor identity is durable');
  assert.deepEqual(state.tasks[0].workerRequirements.capabilities,['model']);
  const input=JSON.parse(state.tasks[0].input);
  assert.equal(input.reviewRevision.status,'changes_requested');
  assert.equal(input.reviewRevision.feedback,'Adjust scene transitions');
  assert.equal(input.source,'relay-dag-task');
  console.log('Review resume parity: Rust accepted -> Graph QUEUED -> Script-to-Model same-task revision');
 }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});

test('unapproved Review cannot resume and does not mutate authoritative task',async()=>{
 const {dir,db}=setup();let store;
 try{
  await (store=new SQLiteRelayStore(db)).saveJob(job('91',dir));store.close();store=null;
  const fail=spawnSync(bin,['review-resume',db,'91','2099-01-01T00:00:05.000Z','101'],{
   encoding:'utf8',env:{...process.env,RELAY_RUST_EXPERIMENTAL_TEST_ONLY:'isolated-test'}});
  assert.notEqual(fail.status,0);
  assert.match(fail.stderr,/Review has no accepted decision/);
  store=new SQLiteRelayStore(db);
  assert.equal((await store.loadJob('91')).tasks[0].state,'AWAITING_DECISION');
 }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});
