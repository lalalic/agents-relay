import test from 'node:test';
import assert from 'node:assert/strict';
import { replayIngress } from './real-ingress-replay.mjs';
const fixture={scenarioId:'stale-duplicate-restart',expectedTaskState:'SUCCEEDED',events:[
  {type:'task.completed',executionId:'stale'},
  {type:'task.completed',data:{summary:'done',validation:'pass'}},
  {type:'task.completed',data:{summary:'duplicate'}}]};
test('real replay rejects stale, accepts terminal, remains idempotent across restart',async()=>{
  const result=await replayIngress(fixture);
  assert.equal(result.outcome,'PASS');
  assert.deepEqual(result.trace.map(x=>x.state),['RUNNING','SUCCEEDED','SUCCEEDED']);
});
test('mutated expected outcome is detected as a regression',async()=>{
  const result=await replayIngress({...fixture,expectedTaskState:'FAILED'});
  assert.equal(result.outcome,'FAIL');
  assert.equal(result.reason,'DURABLE_STATE_MISMATCH');
});
