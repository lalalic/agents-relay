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
import {beginInteractiveReview,failInteractiveReview,abortInteractiveReview,interactiveWaitingEvent} from '../dist/interactive-request.js';
const now=()=>new Date().toISOString();
const task=()=>({jobId:'job-preview',id:'producer',parentTaskId:null,dependencies:[],capabilities:[],
 adapter:'orchestrator',input:'make preview',state:'RUNNING',attempt:1,maxAttempts:3,
 leaseOwner:'owner',leaseExpiresAt:now(),executionId:'exec-1',threadId:null,result:null,error:null,
 timeoutMs:60000,createdAt:now(),updatedAt:now(),continuation:null,continuationDeliveredAt:null});
const job=(t=task())=>({id:t.jobId,title:'Preview',prNumber:0,repository:'job',state:'ACTIVE',
 continuation:null,createdAt:now(),updatedAt:now(),tasks:[t]});
async function fixture({localAuthority=false}={}){const dir=await mkdtemp(join(tmpdir(),'relay-preview-'));const store=new SQLiteRelayStore(join(dir,'db.sqlite'));
 const j=job();await store.saveJob(j);
 const runtime=localAuthority ? new LocalAuthorityDurableStore(store,new InMemoryStore(j),undefined,true) : new ProjectedDurableStore(store,new InMemoryStore(j));
 const reconciler=managedReconciler(runtime,{owner:'preview-test',adapters:[]});
 return {store,j,reconciler,async close(){await reconciler.close();store.close();await rm(dir,{recursive:true,force:true});}};}
async function wait(f,inv){
 const ev={version:1,event_id:'wait-'+inv,job_id:f.j.id,task_id:'producer',parent_task_id:null,
 type:'task.interactive_waiting',status:'waiting',timestamp:now(),visibility:'orchestrator',level:'info',message:'Interactive review requested',
 source:{id:'job/job-preview/task/producer/execution/exec-1',component:'interactive-review'},data:{}};
 assert.equal((await f.reconciler.applyEvent(ev)).applied,true);
}
test('Neo prepare is idempotent and binds current execution before suspension',async()=>{
 const f=await fixture();try{
  const first=await beginInteractiveReview(f.store,f.j.id,'producer','exec-1');
  const retry=await beginInteractiveReview(f.store,f.j.id,'producer','exec-1');
  assert.equal(first.executionId,retry.executionId);
  assert.equal(first.reused,false);assert.equal(retry.reused,true);
  assert.equal(first.eventTemplate.type,'task.interactive_decision');
  assert.equal(first.eventTemplate.data.interactive.executionId,'exec-1');
  assert.equal((await f.store.loadJob(f.j.id)).tasks[0].state,'RUNNING');
  await assert.rejects(beginInteractiveReview(f.store,f.j.id,'producer','stale'));
  await wait(f,first.executionId);
  const waiting=(await f.store.loadJob(f.j.id)).tasks[0];
  assert.equal(waiting.state,'AWAITING_DECISION');assert.equal(waiting.executionId,null);
  assert.equal(waiting.interactiveInvocation.revision,'exec-1');

 }finally{await f.close();}
});
test('Neo preview compile failure returns original Task to QUEUED without creating another Task',async()=>{
 const f=await fixture();try{
  const first=await beginInteractiveReview(f.store,f.j.id,'producer','exec-1');
  await wait(f,first.executionId);
  const recovery=await failInteractiveReview(f.store,f.j.id,'producer','exec-1','compile crashed');
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
  await abortInteractiveReview(f.store,f.j.id,'producer','exec-1');
  const current=(await f.store.loadJob(f.j.id)).tasks[0];
  assert.equal(current.state,'RUNNING');assert.equal(current.interactiveInvocation,undefined);
 }finally{await f.close();}
});
test('iPhone Decision Event resumes original awaiting Task after Neo binds exact revision',async()=>{
 const f=await fixture();try{
  const started=await beginInteractiveReview(f.store,f.j.id,'producer','exec-1');
  await wait(f,started.executionId);

  const event={version:1,event_id:'phone-'+started.executionId,job_id:f.j.id,task_id:'producer',
    parent_task_id:null,type:'task.interactive_decision',status:'running',timestamp:now(),
    visibility:'user',level:'info',message:'User approved Preview',
    source:{id:'job/job-preview/task/producer/execution/exec-1'},
    data:{interactive:{...started.eventTemplate.data.interactive,previewId:'p1',requestId:'request1',idempotencyKey:'key1',
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
   await wait(f,started.executionId);

   const original={version:1,event_id:'mobile-pool-'+started.executionId,job_id:f.j.id,task_id:'producer',
     parent_task_id:null,type:'task.interactive_decision',status:'running',timestamp:now(),visibility:'orchestrator',level:'info',
     message:'Task decision submitted from native iPhone',source:{id:'job/job-preview/task/producer/execution/exec-1'},
     data:{interactive:{...started.eventTemplate.data.interactive,previewId:'preview',
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
  await wait(f,start.executionId);

  const event={version:1,event_id:'changes-'+start.executionId,job_id:f.j.id,task_id:'producer',
    parent_task_id:null,type:'task.interactive_decision',status:'running',timestamp:now(),visibility:'user',level:'info',
    message:'User requested edits',source:{id:'job/job-preview/task/producer/execution/exec-1'},
    data:{interactive:{...start.eventTemplate.data.interactive,
      previewId:'p1',requestId:'r1',idempotencyKey:'k1',decision:'changes_requested',feedback:'Shorten opening',comments:[]}}};
  assert.equal((await f.reconciler.applyEvent(event)).reason,'task.interactive_decision.accepted');
  let current=await f.store.loadJob(f.j.id);
  assert.equal(current.tasks[0].state,'QUEUED');
  assert.equal(current.tasks[0].interactiveInvocation.status,'changes_requested');
  assert.match(JSON.stringify(current.tasks[0].comments),/Shorten opening/);
  await f.store.mutateJob(f.j.id,j=>{j.tasks[0].state='RUNNING';j.tasks[0].executionId='exec-2';return j;});
  const next=await beginInteractiveReview(f.store,f.j.id,'producer','exec-2');
  assert.notEqual(start.executionId,next.executionId);
  assert.equal((await f.store.loadJob(f.j.id)).tasks[0].interactiveInvocation.status,'awaiting_decision');
 }finally{await f.close();}
});

test('next Stage can prepare a fresh review after prior approval on the same Shortcut parent Task',async()=>{
 const f=await fixture();try{
  const first=await beginInteractiveReview(f.store,f.j.id,'producer','exec-1');
  await wait(f,first.executionId);

  const {resumeInteractiveTask}=await import('../dist/interactive-resume.js');
  await f.store.mutateJob(f.j.id,j=>{const t=j.tasks[0];t.interactiveInvocation.status='approved';t.interactiveInvocation.decidedAt=now();return j;});
  assert.equal(await resumeInteractiveTask(f.store,f.j.id,'producer','exec-1','exec-1','approved'),true);
  await f.store.mutateJob(f.j.id,j=>{j.tasks[0].state='RUNNING';j.tasks[0].executionId='exec-2';j.tasks[0].leaseOwner='new-owner';return j;});
  const next=await beginInteractiveReview(f.store,f.j.id,'producer','exec-2');
  assert.notEqual(next.executionId,first.executionId);
  assert.equal(next.reused,false);
  const current=(await f.store.loadJob(f.j.id)).tasks[0];
  assert.equal(current.interactiveInvocation.status,'awaiting_decision');
  await assert.rejects(beginInteractiveReview(f.store,f.j.id,'producer','exec-old'));
 }finally{await f.close()}
});

test('new authoritative execution replaces an orphaned pending Invocation after wrapper crash',async()=>{
 const f=await fixture();try{
  const old=await beginInteractiveReview(f.store,f.j.id,'producer','exec-1');
  // Crash before task.interactive_waiting; the worker lease is superseded by a new execution.
  await f.store.mutateJob(f.j.id,j=>{j.tasks[0].executionId='exec-2';return j;});
  const fresh=await beginInteractiveReview(f.store,f.j.id,'producer','exec-2');
  assert.equal(fresh.reused,false);
  assert.notEqual(fresh.executionId,old.executionId);
  const current=(await f.store.loadJob(f.j.id)).tasks[0];
  assert.equal(current.interactiveInvocation.executionId,'exec-2');
  assert.equal(current.interactiveInvocation.invocationId,fresh.executionId);
 }finally{await f.close();}
});


test('interactive waiting event is provider-neutral and execution-bound',()=>{
 const event=interactiveWaitingEvent('job-1','task-2',null,'exec-3');
 assert.equal(event.type,'task.interactive_waiting');
 assert.equal(event.status,'waiting');
 assert.equal(event.message,'Interactive review requested');
 assert.deepEqual(event.source,{id:'job/job-1/task/task-2/execution/exec-3',component:'interactive-review'});
 assert.doesNotMatch(JSON.stringify(event),/neo-preview|markcut|Neo Preview/);
});
