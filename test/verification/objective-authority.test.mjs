import test from 'node:test';
import assert from 'node:assert/strict';
import {runReplay} from './l3-replay.mjs';

// This is a production ingress/Graph/Reconciler/SQLite negative gate, not a
// simulated final objective success. In particular injected merge receipts
// are not authorization to terminalize an unfinished Job.
test('false completion rejected after chained planner and worker faults and merge receipt',async()=>{
 const result=await runReplay({id:'impossible-objective-after-faults',executionMode:'autonomous',tasks:[
  {id:'planner'}, {id:'worker',dependencies:['planner']},
  {id:'reviewer',dependencies:['worker']}, {id:'merge',dependencies:['reviewer']}
 ],steps:[
  {type:'task.failed',taskId:'planner',data:{phase:'planning',reason:'transient'}},
  {type:'restart'},
  {type:'task.completed',taskId:'planner',executionId:'old-generation'},
  {type:'task.failed',taskId:'worker',executionId:'old-generation'},
  {type:'review.approved',taskId:'reviewer',data:{head_sha:'abc123'}},
  {type:'job.merge.succeeded',mergedCommitSha:'not-an-objective-proof'},
  {type:'restart'}, {type:'reconcile'}
 ],expected:{jobState:'ACTIVE',tasks:{planner:'FAILED',worker:'DRAFT',reviewer:'DRAFT',merge:'DRAFT'},localMergeStatus:'succeeded'}});
 assert.equal(result.outcome,'PASS',result.errors.join('; '));
 assert.equal(result.actual.jobState,'ACTIVE');
 assert.notEqual(result.actual.jobState,'COMPLETED');
});
