import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { decidePlannerTrigger } from '../dist/workflow/planner-trigger-v2.js';

test('Planner trigger v2 graph owns trigger precedence', () => {
  const cases = [
    [{manualPlan:true,hasUnblock:true,scheduledRun:true,initialPlan:true},'manual'],
    [{manualPlan:false,hasUnblock:true,scheduledRun:true,initialPlan:true},'unblock'],
    [{manualPlan:false,hasUnblock:false,scheduledRun:true,initialPlan:true},'schedule'],
    [{manualPlan:false,hasUnblock:false,scheduledRun:false,initialPlan:true},'initial'],
    [{manualPlan:false,hasUnblock:false,scheduledRun:false,initialPlan:false},'continuation'],
  ];
  for (const [facts,target] of cases) {
    const decision=decidePlannerTrigger(facts);
    assert.equal(decision.accepted,true);
    assert.equal(decision.target,target);
  }
});
