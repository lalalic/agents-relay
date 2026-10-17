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
