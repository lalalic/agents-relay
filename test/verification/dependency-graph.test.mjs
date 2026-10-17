import test from 'node:test';
import assert from 'node:assert/strict';
import {schedule} from '../../dist/scheduler.js';
import {InMemoryStore} from '../../dist/store.js';
import {Reconciler} from '../../dist/reconciler.js';
import {MemoryEventBus,eventFor} from '../../dist/events.js';
import {executionEventSource} from '../../dist/reconciler.js';

const now=()=>new Date().toISOString();
const task=(id,state,dependencies=[],executionId=null)=>({jobId:'dependency',id,kind:'work',priority:'P1',storySize:'S',agentName:'implementation',parentTaskId:null,dependencies,
  capabilities:[],adapter:'chatgpt',input:'fixture',output:{kind:'task_pr'},state,attempt:1,maxAttempts:2,leaseOwner:'fixture',leaseExpiresAt:now(),executionId,
  threadId:null,result:null,error:null,timeoutMs:900000,createdAt:now(),updatedAt:now(),executionHistory:executionId?[{id:executionId,attempt:1,startedAt:now()}]:[]});

test('production ingress drives Graph scheduling of dependent work after real terminal event',async()=>{
  const initial={id:'dependency',title:'dependency',repository:'test/fixture',prNumber:0,state:'ACTIVE',autoMerge:false,reviewEnabled:false,
    createdAt:now(),updatedAt:now(),tasks:[task('root','RUNNING',[],'actual'),task('child','DRAFT',['root'])]};
  const store=new InMemoryStore(initial);
  const runner=new Reconciler(store,{owner:'dependency-test',adapters:[],eventBus:new MemoryEventBus(),maxConcurrent:0});
  try {
    const before=schedule(await store.load('dependency'));
    assert.equal(before.tasks[1].state,'DRAFT');
    const event=eventFor('dependency','root',null,'task.completed','succeeded','done','orchestrator',
      {summary:'completed'}, {id:executionEventSource('dependency','root','actual')});
    await runner.handleEvent(event);
    const after=schedule(await store.load('dependency'));
    assert.equal(after.tasks[0].state,'SUCCEEDED');
    assert.equal(after.tasks[1].state,'QUEUED');
  }finally{await runner.close()}
});
test('production graph does not release a failed prerequisite',()=>{
  const job={id:'dependency',state:'ACTIVE',tasks:[task('root','FAILED'),task('child','DRAFT',['root'])]};
  assert.equal(schedule(job).tasks[1].state,'DRAFT');
});
