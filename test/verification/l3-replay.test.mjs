import test from 'node:test';
import assert from 'node:assert/strict';
import {runReplay} from './l3-replay.mjs';

test('CLI replay follows real ingress and records SQLite causal transitions',async()=>{
 const result=await runReplay({id:'dependency-release',steps:[{type:'task.completed'},{type:'task.completed'}],expected:{jobState:'ACTIVE',tasks:{a:'SUCCEEDED',b:'QUEUED'}}});
 assert.equal(result.outcome,'PASS');
 assert.deepEqual(result.trace[0].before.map(x=>x.state),['RUNNING','DRAFT']);
 assert.deepEqual(result.trace[0].after.map(x=>x.state),['SUCCEEDED','QUEUED']);
 assert.equal(result.trace[1].progress,false);
});
test('intentionally broken scenario fails even when caller asserts terminal completion',async()=>{
 const result=await runReplay({id:'broken-premature-completion',steps:[{type:'task.completed'}],expected:{jobState:'COMPLETED',tasks:{a:'SUCCEEDED',b:'SUCCEEDED'}}});
 assert.equal(result.outcome,'FAIL');
 assert.equal(result.actual.jobState,'ACTIVE');
 assert.ok(result.errors.some(e=>e.includes('job expected COMPLETED')));
});

test('matrix replays restart, parallel release, and merge retry through SQLite',async()=>{
 const result=await runReplay({id:'restart-merge-retry',tasks:[{id:'a'},{id:'b'},{id:'c',dependencies:['a']}],steps:[
  {type:'task.completed',taskId:'a'},
  {type:'restart'},
  {type:'task.completed',taskId:'b'},
  {type:'job.merge.failed',message:'dirty target',attempts:1},
  {type:'job.merge.succeeded',attempts:2,mergedCommitSha:'merge-2',sourceSha:'head-2'},
  {type:'reconcile'}
 ],expected:{jobState:'ACTIVE',tasks:{a:'SUCCEEDED',b:'SUCCEEDED',c:'QUEUED'},localMergeStatus:'succeeded'}});
 assert.equal(result.outcome,'PASS');
 assert.equal(result.actual.localMerge.mergedCommitSha,'merge-2');
 assert.ok(result.trace.some(step=>step.event==='restart'));
});

test('stale and duplicate terminal events cannot mutate authoritative SQLite',async()=>{
 const result=await runReplay({id:'stale-duplicate',steps:[{type:'task.completed',executionId:'stale'},{type:'task.completed'},{type:'task.completed'}],assertions:[{step:0,taskId:'a',before:'RUNNING',after:'RUNNING',progress:false},{step:1,taskId:'a',after:'SUCCEEDED',progress:true},{step:2,taskId:'a',after:'SUCCEEDED',progress:false}],expected:{jobState:'ACTIVE',tasks:{a:'SUCCEEDED',b:'QUEUED'}}});
 assert.equal(result.outcome,'PASS',result.errors.join('; '));
});
test('worker failure persists and does not release dependent work',async()=>{
 const result=await runReplay({id:'worker-failure',steps:[{type:'task.failed',data:{phase:'implementation',reason:'fault injection'}},{type:'reconcile'}],expected:{jobState:'ACTIVE',tasks:{a:'FAILED',b:'DRAFT'}},assertions:[{step:0,taskId:'a',before:'RUNNING',after:'FAILED'}]});
 assert.equal(result.outcome,'PASS',result.errors.join('; '));
});
test('repeated idle reconciliation triggers timestamp-independent loop detection',async()=>{
 const result=await runReplay({id:'idle-loop',steps:[{type:'reconcile'},{type:'reconcile'}]});
 assert.equal(result.outcome,'FAIL');
 assert.ok(result.errors.includes('NO_PROGRESS_LOOP'));
});
test('incorrect causal transition expectation cannot be supplied as proof',async()=>{
 const result=await runReplay({id:'false-causality',steps:[{type:'task.completed',executionId:'stale'}],assertions:[{step:0,taskId:'a',after:'SUCCEEDED'}]});
 assert.equal(result.outcome,'FAIL');
 assert.ok(result.errors.some(e=>e.includes('after expected')));
});
