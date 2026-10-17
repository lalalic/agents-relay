import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateEmissions,runLiveMatrix} from './live-compliance.mjs';
const source='job/481/task/reviewer/execution/abc';
const good=[{type:'task.started',source},{type:'task.completed',source,data:{verdict:'changes-required',head_sha:'0123',findings:[]}}];
test('L2 evaluator validates actual reviewer event identity and verdict',()=>{
  assert.equal(evaluateEmissions({role:'reviewer',executionId:'abc',source,events:good}).outcome,'PASS');
  assert.equal(evaluateEmissions({role:'reviewer',executionId:'abc',source,events:[...good,good[1]]}).outcome,'FAIL');
  assert.equal(evaluateEmissions({role:'reviewer',executionId:'abc',source,events:[good[0],{...good[1],data:{}}]}).outcome,'FAIL');
  assert.equal(evaluateEmissions({role:'reviewer',executionId:'abc',source,events:good,transportAccepted:false}).failureClass,'TRANSPORT');
});
test('L2 live provider calls are NOT_RUN without opt-in',async()=>{
  const results=await runLiveMatrix({cases:[{role:'implementation',provider:'test'}]});
  assert.equal(results[0].outcome,'NOT_RUN');
});
