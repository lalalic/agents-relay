import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryStore } from '../../dist/store.js';
import { Reconciler } from '../../dist/reconciler.js';
import { MemoryEventBus, eventFor } from '../../dist/events.js';
import { executionEventSource } from '../../dist/reconciler.js';

const task = (executionId='live-exec') => {
  const now = new Date().toISOString();
  return {jobId:'verification',id:'worker-1',kind:'work',priority:'P1',storySize:'S',agentName:'implementation',
    parentTaskId:null,dependencies:[],capabilities:[],adapter:'chatgpt',input:'test event ingress',output:{kind:'task_pr'},
    state:'RUNNING',attempt:2,maxAttempts:3,leaseOwner:'fixture',leaseExpiresAt:now,executionId,threadId:null,
    result:null,error:null,timeoutMs:900000,createdAt:now,updatedAt:now,
    executionHistory:[{id:executionId,attempt:2,startedAt:now}]};
};
const fixture = () => {
  const now = new Date().toISOString();
  const store = new InMemoryStore({id:'verification',title:'ingress',repository:'x/y',prNumber:0,
    state:'ACTIVE',autoMerge:false,reviewEnabled:false,createdAt:now,updatedAt:now,tasks:[task()]});
  return {store,runner:new Reconciler(store,{owner:'verification',adapters:[],eventBus:new MemoryEventBus(),maxConcurrent:0})};
};
const completed = executionId => eventFor('verification','worker-1',null,'task.completed','succeeded','done','orchestrator',
  {validation:'pass'}, {id:executionEventSource('verification','worker-1',executionId)});

test('real event ingress rejects stale identity; accepts and persists current terminal once', async()=>{
  const {store,runner}=fixture();
  try {
    await runner.handleEvent(completed('old-exec'));
    assert.equal((await store.load('verification')).tasks[0].state,'RUNNING');
    await runner.handleEvent(completed('live-exec'));
    assert.equal((await store.load('verification')).tasks[0].state,'SUCCEEDED');
    await runner.handleEvent(completed('live-exec'));
    assert.equal((await store.load('verification')).tasks.filter(t=>t.id==='worker-1').length,1);
  } finally {await runner.close();}
});
