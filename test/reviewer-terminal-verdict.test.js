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
