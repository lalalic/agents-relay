import test, {managedReconciler} from './test-runtime.js';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SQLiteRelayStore} from '../dist/relay-store.js';
import {ProjectedDurableStore} from '../dist/projected-store.js';
import {LocalAuthorityDurableStore} from '../dist/local-authority-store.js';
import {InMemoryStore} from '../dist/store.js';
import {RepositoryWorkerPool} from '../dist/pool.js';
import {MemoryEventBus} from '../dist/events.js';
import {beginInteractiveReview,readyInteractiveReview,failInteractiveReview,abortInteractiveReview} from '../dist/interactive-request.js';
const now=()=>new Date().toISOString();
const task=()=>({jobId:'job-preview',id:'producer',parentTaskId:null,dependencies:[],capabilities:[],
 adapter:'orchestrator',input:'make preview',state:'RUNNING',attempt:1,maxAttempts:3,
 leaseOwner:'owner',leaseExpiresAt:now(),executionId:'exec-1',threadId:null,result:null,error:null,
 timeoutMs:60000,createdAt:now(),updatedAt:now(),continuation:null,continuationDeliveredAt:null});
const job=(t=task())=>({id:t.jobId,title:'Preview',prNumber:0,repository:'local/job',state:'ACTIVE',
 continuation:null,createdAt:now(),updatedAt:now(),tasks:[t]});
async function fixture({localAuthority=false}={}){const dir=await mkdtemp(join(tmpdir(),'relay-preview-'));const store=new SQLiteRelayStore(join(dir,'db.sqlite'));
 const j=job();await store.saveJob(j);
 const runtime=localAuthority ? new LocalAuthorityDurableStore(store,new InMemoryStore(j),undefined,true) : new ProjectedDurableStore(store,new InMemoryStore(j));
 const reconciler=managedReconciler(runtime,{owner:'preview-test',adapters:[]});
 return {store,j,reconciler,async close(){await reconciler.close();store.close();await rm(dir,{recursive:true,force:true});}};}
async function wait(f,inv){
 const ev={version:1,event_id:'wait-'+inv,job_id:f.j.id,task_id:'producer',parent_task_id:null,
 type:'task.interactive_waiting',status:'waiting',timestamp:now(),visibility:'orchestrator',level:'info',message:'Preview handoff',
 source:{id:'job/job-preview/task/producer/execution/exec-1',component:'neo-preview'},data:{}};
 assert.equal((await f.reconciler.applyEvent(ev)).applied,true);
}
test('Neo prepare is idempotent and binds current execution before suspension',async()=>{
 const f=await fixture();try{
  const first=await beginInteractiveReview(f.store,f.j.id,'producer','exec-1');
  const retry=await beginInteractiveReview(f.store,f.j.id,'producer','exec-1');
  assert.equal(first.invocationId,retry.invocationId);
  assert.equal(first.reused,false);assert.equal(retry.reused,true);
  assert.equal(first.eventTemplate.type,'task.interactive_decision');
  assert.equal(first.eventTemplate.data.interactive.executionId,'exec-1');
  assert.equal((await f.store.loadJob(f.j.id)).tasks[0].state,'RUNNING');
  await assert.rejects(beginInteractiveReview(f.store,f.j.id,'producer','stale'));
  await wait(f,first.invocationId);
  const waiting=(await f.store.loadJob(f.j.id)).tasks[0];
  assert.equal(waiting.state,'AWAITING_DECISION');assert.equal(waiting.executionId,null);
  await assert.rejects(readyInteractiveReview(f.store,f.j.id,'producer','exec-1',first.invocationId,'bad'));
  const hash='a'.repeat(40);
  assert.equal((await readyInteractiveReview(f.store,f.j.id,'producer','exec-1',first.invocationId,hash)).ready,true);
  assert.equal((await f.store.loadJob(f.j.id)).tasks[0].interactiveInvocation.revision,hash);
  await assert.rejects(readyInteractiveReview(f.store,f.j.id,'producer','exec-1',first.invocationId,'b'.repeat(40)));
 }finally{await f.close();}
});
test('Neo preview compile failure returns original Task to QUEUED without creating another Task',async()=>{
 const f=await fixture();try{
  const first=await beginInteractiveReview(f.store,f.j.id,'producer','exec-1');
  await wait(f,first.invocationId);
  const recovery=await failInteractiveReview(f.store,f.j.id,'producer','exec-1',first.invocationId,'compile crashed');
  assert.equal(recovery.requeued,true);
  const current=await f.store.loadJob(f.j.id);
  assert.equal(current.tasks.length,1);
  assert.equal(current.tasks[0].state,'QUEUED');
  assert.equal(current.tasks[0].interactiveInvocation,undefined);
  assert.match(JSON.stringify(current.tasks[0].comments),/compile crashed/);
 }finally{await f.close();}
});
test('Neo provider failure before suspension cancels bound invocation but keeps Worker RUNNING',async()=>{
 const f=await fixture();try{
  const first=await beginInteractiveReview(f.store,f.j.id,'producer','exec-1');
  await abortInteractiveReview(f.store,f.j.id,'producer','exec-1',first.invocationId);
  const current=(await f.store.loadJob(f.j.id)).tasks[0];
  assert.equal(current.state,'RUNNING');assert.equal(current.interactiveInvocation,undefined);
 }finally{await f.close();}
});
test('iPhone Decision Event resumes original awaiting Task after Neo binds exact revision',async()=>{
 const f=await fixture();try{
  const started=await beginInteractiveReview(f.store,f.j.id,'producer','exec-1');
  await wait(f,started.invocationId);
  const hash='f'.repeat(40);
  await readyInteractiveReview(f.store,f.j.id,'producer','exec-1',started.invocationId,hash);
  const event={version:1,event_id:'phone-'+started.invocationId,job_id:f.j.id,task_id:'producer',
    parent_task_id:null,type:'task.interactive_decision',status:'running',timestamp:now(),
    visibility:'user',level:'info',message:'User approved Preview',
    source:{id:'job/job-preview/task/producer/execution/exec-1'},
    data:{interactive:{...started.eventTemplate.data.interactive,revision:hash,commitSha:hash,previewId:'p1',requestId:'request1',idempotencyKey:'key1',
      decision:'approved',feedback:'',comments:[]}}};
  const result=await f.reconciler.applyEvent(event);
  assert.equal(result.reason,'task.interactive_decision.accepted');
  const current=await f.store.loadJob(f.j.id);
  assert.equal(current.tasks.length,1);assert.equal(current.tasks[0].state,'QUEUED');
  assert.equal(current.tasks[0].interactiveInvocation.status,'approved');
 }finally{await f.close();}
});
test('full pool NATS-style review intake applies mobile CHANGES_REQUESTED to original durable Task',async()=>{
 const f=await fixture({localAuthority:true}); const bus=new MemoryEventBus();
 const pool=new RepositoryWorkerPool(1,
   (_store,_capacity)=>({
     applyEvent:event=>f.reconciler.applyEvent(event),
     reconcile:async()=>{},
   }),
   async()=>[{job:await f.store.loadJob(f.j.id),githubState:'UNKNOWN',draft:false,mergedAt:null,closedAt:null}],
   async id=>id===f.j.id?{job:await f.store.loadJob(id),store:f.store}:null);
 const stop=await pool.watch(bus);
 try{
   const started=await beginInteractiveReview(f.store,f.j.id,'producer','exec-1');
   await wait(f,started.invocationId);
   const sha='b'.repeat(40);
   await readyInteractiveReview(f.store,f.j.id,'producer','exec-1',started.invocationId,sha);
   const original={version:1,event_id:'mobile-pool-'+started.invocationId,job_id:f.j.id,task_id:'producer',
     parent_task_id:null,type:'task.interactive_decision',status:'running',timestamp:now(),visibility:'orchestrator',level:'info',
     message:'Task decision submitted from native iPhone',source:{id:'job/job-preview/task/producer/execution/exec-1'},
     data:{interactive:{...started.eventTemplate.data.interactive,revision:sha,commitSha:sha,previewId:'preview',
       requestId:'request-from-phone',idempotencyKey:'unique-phone-key',decision:'changes_requested',
       feedback:'E2E_TEST_ONLY: adjust opening',comments:[]}}};
   assert.equal((await f.store.loadJob(f.j.id)).tasks[0].state,'AWAITING_DECISION');
   await bus.publish(original);
   for(let attempt=0;attempt<100;attempt++){
     if((await f.store.loadJob(f.j.id)).tasks[0].state==='QUEUED')break;
     await new Promise(done=>setTimeout(done,5));
   }
   const task=(await f.store.loadJob(f.j.id)).tasks[0];
   assert.equal(task.state,'QUEUED','live pool must consume the human event instead of just storing it');
   assert.equal(task.interactiveInvocation.status,'changes_requested');
   assert.match(JSON.stringify(task.comments),/E2E_TEST_ONLY/);
   await bus.publish(original);
   await new Promise(done=>setTimeout(done,15));
   assert.equal((await f.store.loadJob(f.j.id)).tasks[0].state,'QUEUED','retrying same delivery must be idempotent');
 }finally{await stop();await f.close();}
});

test('changes_requested retains approval gate while fresh execution may prepare a new revision',async()=>{
 const f=await fixture();try{
  const start=await beginInteractiveReview(f.store,f.j.id,'producer','exec-1');
  await wait(f,start.invocationId);
  const hash='e'.repeat(40);
  await readyInteractiveReview(f.store,f.j.id,'producer','exec-1',start.invocationId,hash);
  const event={version:1,event_id:'changes-'+start.invocationId,job_id:f.j.id,task_id:'producer',
    parent_task_id:null,type:'task.interactive_decision',status:'running',timestamp:now(),visibility:'user',level:'info',
    message:'User requested edits',source:{id:'job/job-preview/task/producer/execution/exec-1'},
    data:{interactive:{...start.eventTemplate.data.interactive,revision:hash,commitSha:hash,
      previewId:'p1',requestId:'r1',idempotencyKey:'k1',decision:'changes_requested',feedback:'Shorten opening',comments:[]}}};
  assert.equal((await f.reconciler.applyEvent(event)).reason,'task.interactive_decision.accepted');
  let current=await f.store.loadJob(f.j.id);
  assert.equal(current.tasks[0].state,'QUEUED');
  assert.equal(current.tasks[0].interactiveInvocation.status,'changes_requested');
  assert.match(JSON.stringify(current.tasks[0].comments),/Shorten opening/);
  await f.store.mutateJob(f.j.id,j=>{j.tasks[0].state='RUNNING';j.tasks[0].executionId='exec-2';return j;});
  const next=await beginInteractiveReview(f.store,f.j.id,'producer','exec-2');
  assert.notEqual(start.invocationId,next.invocationId);
  assert.equal((await f.store.loadJob(f.j.id)).tasks[0].interactiveInvocation.status,'awaiting_decision');
 }finally{await f.close();}
});

test('new authoritative execution replaces an orphaned pending Invocation after wrapper crash',async()=>{
 const f=await fixture();try{
  const old=await beginInteractiveReview(f.store,f.j.id,'producer','exec-1');
  // Crash before task.interactive_waiting; the worker lease is superseded by a new execution.
  await f.store.mutateJob(f.j.id,j=>{j.tasks[0].executionId='exec-2';return j;});
  const fresh=await beginInteractiveReview(f.store,f.j.id,'producer','exec-2');
  assert.equal(fresh.reused,false);
  assert.notEqual(fresh.invocationId,old.invocationId);
  const current=(await f.store.loadJob(f.j.id)).tasks[0];
  assert.equal(current.interactiveInvocation.executionId,'exec-2');
  assert.equal(current.interactiveInvocation.invocationId,fresh.invocationId);
 }finally{await f.close();}
});
