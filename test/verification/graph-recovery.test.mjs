import test from 'node:test';
import assert from 'node:assert/strict';
import {decideTaskLifecycle,decideJobLifecycle} from '../../dist/workflow/lifecycle.js';
import {transitionTaskEvent} from '../../dist/scheduler.js';
const task = state=>({id:'worker',jobId:'verification',state,dependencies:[],updatedAt:new Date().toISOString(),error:null});
const job = state=>({id:'verification',state,tasks:[],repository:'test/isolation',prNumber:0,executionMode:'fixed',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
test('canonical Graph owns failure, retry, review, and escalation gates',async()=>{
  const worker=task('RUNNING');
  await transitionTaskEvent(worker,'task.failed');
  assert.equal(worker.state,'FAILED');
  await transitionTaskEvent(worker,'retry');
  assert.equal(worker.state,'QUEUED');
  assert.equal(decideTaskLifecycle(task('RUNNING'),'review.changes_required',{}).target,'SUCCEEDED');
  const blocked=task('BLOCKED');
  await transitionTaskEvent(blocked,'task.unblocked');
  assert.equal(blocked.state,'QUEUED');
  assert.equal(decideTaskLifecycle(task('RUNNING'),'task.blocked',{recoverableExecution:false}).target,'BLOCKED');
});
test('job Graph forbids arbitrary job completion without local delivery authority',()=>{
  assert.equal(decideJobLifecycle(job('ACTIVE'),'local.completed',{localCompletionAllowed:false}).target,'ACTIVE');
  assert.equal(decideJobLifecycle(job('ACTIVE'),'local.completed',{localCompletionAllowed:true}).target,'COMPLETED');
});
