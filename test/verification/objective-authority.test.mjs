import test from 'node:test';
import assert from 'node:assert/strict';
import {runReplay} from './l3-replay.mjs';
import {SQLiteRelayStore} from '../../dist/relay-store.js';
import {renderJobComment,parseJob} from '../../dist/markers.js';
import {rejectRemovedJobOptions} from '../../dist/cli-support.js';

// This is a production ingress/Graph/Reconciler/SQLite negative gate, not a
// simulated final objective success. In particular injected merge receipts
// are not authorization to terminalize an unfinished Job.
test('false completion rejected after chained planner and worker faults and merge receipt',async()=>{
 const result=await runReplay({id:'impossible-objective-after-faults',tasks:[
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

test('retired Job mode and cron data migrate on read and never serialize on write', async () => {
 const sqlite = new SQLiteRelayStore(':memory:');
 try {
  const at = '2026-10-26T00:00:00Z';
  const old = {id:'legacy-mode',title:'legacy mode',repository:'local/isolated',prNumber:0,state:'DRAFT',objective:'ship',createdAt:at,updatedAt:at,tasks:[],executionMode:'autonomous',schedule:{kind:'cron',expression:'* * * * *'}};
  const parsed = parseJob(renderJobComment(old));
  assert.equal(parsed.executionMode,undefined);
  assert.equal(parsed.schedule,undefined);
  await sqlite.saveJob(old);
  const raw=sqlite.db.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get(old.id).json;
  assert.equal(JSON.parse(raw).executionMode,undefined);
  assert.equal(JSON.parse(raw).schedule,undefined);
  const loaded=await sqlite.loadJob(old.id);
  assert.equal(loaded.executionMode,undefined);
  assert.equal(loaded.schedule,undefined);
  for(const flag of ['--mode','--schedule','--cron','--schedule-cron'])
    assert.throws(()=>rejectRemovedJobOptions([flag,'value']),/Unsupported Job option/);
 }finally{sqlite.close();}
});
