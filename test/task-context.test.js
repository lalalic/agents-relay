import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { taskExecutionContext, taskReferencePrompt } from '../dist/task-context.js';

const job = { id:'j1', repository:'owner/repo', title:'A job', objective:'Deliver code', state:'ACTIVE', tasks:[
  { id:'build', state:'QUEUED', executionId:'exec-1', input:'Produce an implementation', dependencies:['prep'], planningDecisionId:'plan-1', output:{kind:'task_pr'} },
  { id:'prep', state:'SUCCEEDED', executionId:null, dependencies:[] }
], plans:[{id:'plan-1',status:'SUCCEEDED',assessment:'planned'}] };

test('task context resolves exact authoritative execution and dependencies',()=>{
  const contract=taskExecutionContext(job,'build','exec-1');
  assert.equal(contract.task.input,'Produce an implementation');
  assert.equal(contract.dependencies[0].state,'SUCCEEDED');
  assert.equal(contract.plan.id,'plan-1');
  assert.equal(contract.job.repository,'owner/repo');
});
test('task context rejects stale, missing and terminal executions',()=>{
  assert.throws(()=>taskExecutionContext(job,'build','old'),/Stale Task execution/);
  assert.throws(()=>taskExecutionContext(job,'build',''),/requires --execution-id/);
  assert.throws(()=>taskExecutionContext(job,'none','exec-1'),/not found/);
  assert.throws(()=>taskExecutionContext({...job,tasks:[{...job.tasks[0],state:'FAILED'}]},'build','exec-1'),/Stale Task execution/);
});
test('reference prompt carries identity not task content',()=>{
  const prompt=taskReferencePrompt('owner/repo','j1','build','exec-1');
  assert.match(prompt,/task context --repo owner\/repo --id j1 --task-id build --execution-id exec-1/);
  assert.doesNotMatch(prompt,/Produce an implementation/);
});

test('reference prompt preserves canonical event contract and excludes task body',()=>{
  const source='LONG_PRIVATE_TASK_BODY\n[Execution event contract — mandatory]\nsource.id=job/j1/task/build/execution/exec-1\ntask.started\ntask.completed';
  const prompt=taskReferencePrompt('owner/repo','j1','build','exec-1',source);
  assert.doesNotMatch(prompt,/LONG_PRIVATE_TASK_BODY/);
  assert.match(prompt,/source.id: job\/j1\/task\/build\/execution\/exec-1/);
  assert.match(prompt,/task.started/);
  assert.match(prompt,/task.completed/);
  assert.doesNotMatch(prompt,/LONG_PRIVATE_TASK_BODY|\[Execution event contract — mandatory\]/);
  assert.ok(prompt.length < 1600);
  assert.throws(()=>taskReferencePrompt('owner/repo','j1','build','exec-1','missing'),/Missing managed execution event contract/);
});
