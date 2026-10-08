import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { InMemoryStore } from '../dist/store.js';
import { applyManagedTaskUpdate } from '../dist/task-update.js';

const stamp = () => new Date().toISOString();
function fixture(state='QUEUED') {
  const task={jobId:'j',id:'work',kind:'work',priority:'P2',storySize:'M',parentTaskId:null,dependencies:[],capabilities:[],adapter:'codex',input:'before',output:{kind:'task_pr'},attempt:0,maxAttempts:3,leaseOwner:null,leaseExpiresAt:null,executionId:null,threadId:null,result:null,error:null,timeoutMs:1000,createdAt:stamp(),updatedAt:stamp(),state};
  return {task,store:new InMemoryStore({id:'j',title:'update',repository:'owner/repo',prNumber:1,executionMode:'fixed',state:'ACTIVE',createdAt:stamp(),updatedAt:stamp(),continuation:null,tasks:[task]})};
}
test('managed task update preserves lifecycle authority, execution fields and fresh optimistic preflight', async () => {
  const {task,store}=fixture(); const requested={...task,input:'after',priority:'P1'};
  const latest=await applyManagedTaskUpdate(store,'j','work',requested,task.updatedAt);
  assert.equal(latest.tasks[0].input,'after');
  assert.equal(latest.tasks[0].priority,'P1');
  assert.equal(latest.tasks[0].state,'QUEUED');
  assert.equal(latest.tasks[0].attempt,0);
  await assert.rejects(()=>applyManagedTaskUpdate(store,'j','work',{...requested,input:'stale'},'2000-01-01T00:00:00Z'),/Task changed/);
});
test('managed task update does not replace a claimed execution or its adapter', async () => {
  const {task,store}=fixture();
  task.attempt=1; await store.saveTask(task);
  await assert.rejects(()=>applyManagedTaskUpdate(store,'j','work',{...task,adapter:'orchestrator'},task.updatedAt),/Cannot replace adapter/);
  task.executionId='claimed';task.leaseOwner='relayd-old';await store.saveTask(task);
  await assert.rejects(()=>applyManagedTaskUpdate(store,'j','work',{...task,input:'overwrite'},task.updatedAt),/not mutable/);
});
test('managed task updates cannot forge completed or blocked states', async () => {
  const {task,store}=fixture();
  await assert.rejects(()=>applyManagedTaskUpdate(store,'j','work',{...task,state:'SUCCEEDED'},task.updatedAt),/dedicated lifecycle action/);
});
