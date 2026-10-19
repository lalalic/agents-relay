import test from 'node:test';
import assert from 'node:assert/strict';
import {runReplay} from './l3-replay.mjs';

test('unknown launch postcondition stays fenced across restart, verified by real task.started, then objective completes',async()=>{
 const result=await runReplay({id:'unknown-effect-eventual-verification',autoMerge:true,tasks:[{id:'a',state:'QUEUED'}],steps:[
  {type:'mock.claim',taskId:'a',executionId:'generation-1'},
  {type:'restart'},
  {type:'reconcile'},
  {type:'task.started',taskId:'a',executionId:'generation-1'},
  {type:'task.completed',taskId:'a',executionId:'generation-1'},
  {type:'job.merge.succeeded'},
  {type:'reconcile'},
 ],expected:{jobState:'COMPLETED',tasks:{a:'SUCCEEDED'},localMergeStatus:'succeeded'}});
 assert.equal(result.outcome,'PASS',result.errors.join('; '));
 const at=i=>result.trace[i].actionAttempts;
 assert.equal(at(0).length,1);
 assert.equal(at(0)[0].outcome,'Unknown');
 assert.deepEqual(at(1),at(0),'restart retains unknown attempt and execution identity');
 assert.deepEqual(at(2),at(0),'reconciliation cannot bless unknown outcome');
 assert.equal(at(3)[0].outcome,'Verified','correlated canonical started event establishes postcondition');
 assert.equal(at(4).length,1,'no duplicate Action reservation');
 assert.equal(result.trace.at(-1).jobState,'COMPLETED');
});

test('unknown launch cannot be claimed twice or replaced by a fabricated second generation',async()=>{
 await assert.rejects(()=>runReplay({id:'unknown-double-launch-rejected',tasks:[{id:'a',state:'QUEUED'}],steps:[
  {type:'mock.claim',taskId:'a',executionId:'generation-1'},
  {type:'restart'},
  {type:'mock.claim',taskId:'a',executionId:'generation-2'},
 ]}),/cannot claim non-dispatchable Task/);
});
