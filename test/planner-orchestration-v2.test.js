import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { decidePlannerOrchestration, plannerOrchestrationFacts } from '../dist/workflow/planner-orchestration-v2.js';

const base={autonomousJob:true,legacyPlanningPending:false,recoverablePendingPlan:false,hasSeedWork:true,noActivePlanner:true,noBlockedWork:true,noActiveImplementation:true,continuationMaterialized:true,objectiveUnsatisfied:true};
test('Planner orchestration v2 graph owns wait/recover/create decisions', () => {
  assert.equal(decidePlannerOrchestration({...base,autonomousJob:false}).target,'wait');
  const recover=decidePlannerOrchestration({...base,recoverablePendingPlan:true});
  assert.equal(recover.target,'recovered');
  assert.deepEqual(recover.actions.map(action=>action.id),['planner.recoverPending']);
  assert.equal(decidePlannerOrchestration({...base,noActiveImplementation:false}).target,'wait');
  assert.equal(decidePlannerOrchestration({...base,objectiveUnsatisfied:false}).target,'wait');
  const create=decidePlannerOrchestration(base);
  assert.equal(create.target,'created');
  assert.deepEqual(create.actions.map(action=>action.id),['planner.createRound']);
});

test('unconsumed unblock permits planning despite an unrelated BLOCKED task', () => {
  const job={executionMode:'autonomous',tasks:[{id:'25',kind:'work',state:'BLOCKED'},{id:'30',kind:'work',state:'UNBLOCKED',planningDecisionId:'plan-3',unblock:{at:'2026-10-15T01:20:24Z',source:'cli',reason:'retry',baseline:{blockedAt:'2026-10-15T01:10:00Z'}}}],plans:[{id:'plan-3',round:3,status:'SUCCEEDED',trigger:{source:'continuation'},objectiveStatus:'in_progress'}]};
  const facts=plannerOrchestrationFacts(job,false);
  assert.equal(facts.noBlockedWork,true);
  assert.equal(decidePlannerOrchestration(facts).target,'created');
  job.plans.push({id:'plan-4',round:4,status:'SUCCEEDED',trigger:{source:'unblock',taskIds:['30']},objectiveStatus:'in_progress'});
  assert.equal(plannerOrchestrationFacts(job,false).noBlockedWork,false);
});
