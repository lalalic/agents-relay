import test from 'node:test';
import assert from 'node:assert/strict';
import {InMemoryStore} from '../../dist/store.js';
import {Reconciler} from '../../dist/reconciler.js';
import {MemoryEventBus,eventFor} from '../../dist/events.js';
import {executionEventSource} from '../../dist/reconciler.js';

function fixture(){
  const now=new Date().toISOString(), sha='ab'.repeat(20);
  const task={jobId:'review-probe',id:'review-1',kind:'work',priority:'P1',storySize:'S',
    agentName:'reviewer',parentTaskId:null,dependencies:[],capabilities:[],adapter:'chatgpt',
    input:'Review head '+sha,output:{kind:'task_pr'},state:'RUNNING',attempt:1,maxAttempts:3,
    leaseOwner:'fixture',leaseExpiresAt:now,executionId:'exec-review',threadId:null,
    reviewHeadSha:sha,result:null,error:null,timeoutMs:900000,createdAt:now,updatedAt:now,
    executionHistory:[{id:'exec-review',attempt:1,startedAt:now}]};
  const job={id:'review-probe',repository:'verification/isolated',prNumber:0,title:'review',state:'ACTIVE',
    autoMerge:false,reviewEnabled:true,headSha:sha,createdAt:now,updatedAt:now,tasks:[task]};
  const store=new InMemoryStore(job);
  const runner=new Reconciler(store,{owner:'review-fixture',adapters:[],eventBus:new MemoryEventBus(),maxConcurrent:0});
  return {sha,store,runner};
}
for(const verdict of ['approved','changes-required']) test('reviewer canonical '+verdict+' reaches production event ingress',async()=>{
  const {sha,store,runner}=fixture();
  try {
    const event=eventFor('review-probe','review-1',null,'task.completed','succeeded','review','orchestrator',
      {verdict,head_sha:sha,findings:verdict==='changes-required'?[{message:'repair'}]:[]},
      {id:executionEventSource('review-probe','review-1','exec-review')});
    await runner.handleEvent(event);
    const updated=await store.load('review-probe');
    assert.equal(updated.tasks[0].state,'SUCCEEDED');
  } finally {await runner.close()}
});
