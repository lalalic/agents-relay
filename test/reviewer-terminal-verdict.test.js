import test, { managedReconciler } from './test-runtime.js';
import assert from 'node:assert/strict';
import { InMemoryStore } from '../dist/store.js';
import { MemoryEventBus, eventFor } from '../dist/events.js';
import { executionEventSource } from '../dist/reconciler.js';

for (const [verdict, expected, expectedTask] of [
  ['changes-required', 'changes_required', 'SUCCEEDED'],
  ['approved', 'approved', 'SUCCEEDED'],
]) {
  test(`reviewer task.completed verdict ${verdict} advances review graph exactly once`, async () => {
    const head = 'abcdef0123456789';
    const id = 'review-1';
    const executionId = 'execution-1';
    const now = new Date().toISOString();
    const task = {jobId:'j',id,kind:'work',priority:'P1',storySize:'M',agentName:'reviewer',
      parentTaskId:null,dependencies:[],capabilities:[],adapter:'chatgpt',input:'review',
      output:{kind:'task_pr'},state:'RUNNING',attempt:1,maxAttempts:3,leaseOwner:'lease',
      leaseExpiresAt:now,executionId,threadId:null,result:null,error:null,timeoutMs:900000,
      createdAt:now,updatedAt:now,reviewHeadSha:head,planningDecisionId:'plan-1',
      executionHistory:[{id:executionId,attempt:1,startedAt:now}]};
    const job={id:'j',title:'review',repository:'x/y',prNumber:0,state:'ACTIVE',headSha:head,
      autoMerge:false,reviewEnabled:true,createdAt:now,updatedAt:now,tasks:[task]};
    const store=new InMemoryStore(job);
    const runtime=managedReconciler(store,{owner:'test',adapters:[],eventBus:new MemoryEventBus(),maxConcurrent:0});
    const event=eventFor('j',id,null,'task.completed','succeeded','review verdict','orchestrator',
      {verdict,headSha:head,findings:verdict==='approved'?[]:[{message:'needs repair',severity:'blocking'}]},
      {id:executionEventSource('j',id,executionId)});
    await runtime.handleEvent(event);
    let saved=await store.load('j');
    assert.equal(saved.tasks.find(t=>t.id===id)?.state,expectedTask);
    assert.equal(saved.review?.outcome,expected);
    assert.equal(saved.tasks.find(t=>t.id===id)?.executionId,null);
    await runtime.handleEvent(event);
    saved=await store.load('j');
    assert.equal(saved.tasks.filter(t=>t.id.startsWith('review-fix-')).length,verdict==='approved'?0:1);
    await runtime.close();
  });
}

for (const [label, evidence] of [
  ['nested head', {outcome:{head_sha:'abcdef0123456789'}}],
  ['snake case head', {head_sha:'abcdef0123456789'}],
  ['nested camel head', {outcome:{headSha:'abcdef0123456789'}}],
  ['review head beats conflicting top-level head', {review:{head_sha:'abcdef0123456789'},head_sha:'wrong-head',headSha:'wrong-head'}],
  ['outcome head beats conflicting review and top-level heads', {outcome:{head_sha:'abcdef0123456789'},review:{head_sha:'wrong-head'},head_sha:'wrong-head'}],
]) {
  test(`review terminal changes-required preserves ${label}`, async () => {
    const head='abcdef0123456789'; const now=new Date().toISOString();
    const id='review-1';const exec='execution-1';
    const task={jobId:'j',id,kind:'work',agentName:'reviewer',adapter:'chatgpt',
      priority:'P1',storySize:'M',parentTaskId:null,dependencies:[],capabilities:[],
      input:'review',output:{kind:'task_pr'},state:'RUNNING',attempt:1,maxAttempts:3,
      leaseOwner:'worker',leaseExpiresAt:now,executionId:exec,threadId:null,
      result:null,error:null,timeoutMs:900000,createdAt:now,updatedAt:now,
      reviewHeadSha:head,planningDecisionId:'plan-1',
      executionHistory:[{id:exec,attempt:1,startedAt:now}]};
    const store=new InMemoryStore({id:'j',title:'review',repository:'x/y',prNumber:0,
      state:'ACTIVE',headSha:head,autoMerge:false,reviewEnabled:true,
      createdAt:now,updatedAt:now,tasks:[task]});
    const runtime=managedReconciler(store,{owner:'test',adapters:[],eventBus:new MemoryEventBus(),maxConcurrent:0});
    await runtime.handleEvent(eventFor('j',id,null,'task.completed','succeeded','review result','orchestrator',
      {verdict:'changes-required',findings:[{message:'repair'}],...evidence},
      {id:executionEventSource('j',id,exec)}));
    const saved=await store.load('j');
    assert.equal(saved.review?.outcome,'changes_required');
    assert.equal(saved.tasks[0].state,'SUCCEEDED');
    assert.equal(saved.review?.headSha,head);
    await runtime.close();
  });
}

test('real SQLite-like mutation consumes approved verdict for a fresh head after stale review', async () => {
  const oldHead='old-head', head='current-head', id='fresh-review', executionId='new-exec';
  const now=new Date().toISOString();
  const old={jobId:'j',id:'old-review',agentName:'reviewer',reviewHeadSha:oldHead,state:'SUCCEEDED'};
  const task={jobId:'j',id,kind:'work',agentName:'reviewer',adapter:'chatgpt',
    priority:'P1',storySize:'M',planningDecisionId:'plan-2',reviewHeadSha:head,
    parentTaskId:null,dependencies:[],capabilities:[],input:'review current head',output:{kind:'task_pr'},
    state:'RUNNING',attempt:1,maxAttempts:3,leaseOwner:'worker',leaseExpiresAt:now,
    executionId,threadId:null,result:null,error:null,timeoutMs:900000,
    createdAt:now,updatedAt:now,executionHistory:[{id:executionId,attempt:1,startedAt:now}]};
  const store=new InMemoryStore({id:'j',title:'review',repository:'x/y',prNumber:0,
    state:'ACTIVE',headSha:head,autoMerge:false,reviewEnabled:true,
    review:{outcome:'stale',headSha:oldHead,taskId:old.id,evidence:null,updatedAt:now},
    createdAt:now,updatedAt:now,tasks:[old,task]});
  store.mutateJob=async(jobId,mutate)=>{
    const updated=mutate(await store.load(jobId));
    await store.saveJob(updated);
    for(const current of updated.tasks) await store.saveTask(current);
    return store.load(jobId);
  };
  const runtime=managedReconciler(store,{owner:'test',adapters:[],eventBus:new MemoryEventBus(),maxConcurrent:0});
  const event=eventFor('j',id,null,'task.completed','succeeded','approved review','orchestrator',
    {verdict:'approved',headSha:head}, {id:executionEventSource('j',id,executionId)});
  await runtime.handleEvent(event);
  const saved=await store.load('j');
  assert.equal(saved.review?.outcome,'approved');
  assert.equal(saved.review?.headSha,head);
  assert.equal(saved.tasks.find(t=>t.id===id)?.state,'SUCCEEDED');
  await runtime.close();
});
