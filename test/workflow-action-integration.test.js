import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { GraphRuntime } from '../dist/workflow/graph-v2.js';
import { dispatchWorkflowGraph } from '../dist/workflow/dispatcher.js';
import { WorkflowActionLedger } from '../dist/workflow/action-ledger.js';
import { ConditionRegistry, booleanCondition } from '../dist/workflow/conditions.js';
const source = `flowchart LR
%% relay: initial a
a["state: ACTIVE"]
b["state: COMPLETED"]
merge["action: effect.mergePullRequest"]
a -->|on: approved| merge
merge --> b`;
const runtime = new GraphRuntime(source, {states: new Set(['ACTIVE','COMPLETED']),actions:{'effect.mergePullRequest':{id:'effect.mergePullRequest'}},events:{approved:{id:'approved'}}});
const input = {transport:'event',id:'approved',payload:{}};
const identity = {attemptKey:'exec-1/g1/merge',executionId:'exec-1',generation:1,graph:'job-lifecycle.mmd',actionId:'effect.mergePullRequest'};
test('production dispatcher action loop is fenced and Unknown stops repeated external effect', async () => {
  const ledger = new WorkflowActionLedger(new DatabaseSync(':memory:'));
  const conditions = new ConditionRegistry([booleanCondition('merged')]);
  let calls = 0;
  const transitions = [];
  const options = {initialState:'ACTIVE', input, executeAction:() => {calls++; return {ok:true};},
    persistTransition:(from,to)=>transitions.push([from,to]),
    actionVerification:{ledger,conditions,identity:()=>identity,conditionId:()=> 'merged',observedFacts:()=>({})},observe:false};
  await assert.rejects(dispatchWorkflowGraph(runtime,options), /Unknown/);
  assert.equal(calls,1);
  assert.deepEqual(transitions, []);
  await assert.rejects(dispatchWorkflowGraph(runtime,options), /already reserved/);
  assert.equal(calls,1);
  assert.equal(ledger.trace(identity.attemptKey).outcome,'Unknown');
  assert.equal(ledger.verify(identity.attemptKey,conditions,{merged:true}).outcome,'Verified');
});
