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

test('a blocked Troubleshooter keeps Planner waiting despite historical ordinary unblock metadata', () => {
  const job={executionMode:'autonomous',tasks:[{id:'25',kind:'work',agentName:'troubleshooter',state:'BLOCKED'},{id:'30',kind:'work',state:'FAILED',planningDecisionId:'plan-3',unblock:{at:'2026-10-15T01:20:24Z',source:'cli',reason:'legacy unblock',baseline:{blockedAt:'2026-10-15T01:10:00Z'}}}],plans:[{id:'plan-3',round:3,status:'SUCCEEDED',trigger:{source:'continuation'},objectiveStatus:'in_progress'}]};
  const facts=plannerOrchestrationFacts(job,false);
  assert.equal(plannerOrchestrationFacts(job,false).noBlockedWork,false);
  assert.equal(decidePlannerOrchestration(facts).target,'wait');
});


test('unconsumed unblock bypasses empty successful manual continuation gate', () => {
  const job = {executionMode:'autonomous',tasks:[{id:'30',kind:'work',state:'DRAFT',planningDecisionId:'plan-3',unblock:{event:'task.unblocked',at:'2026-10-15T01:20:24Z',source:'cli',reason:'retry',baseline:{blockedAt:'2026-10-15T01:10:00Z'}}}],plans:[{id:'plan-7',round:7,status:'SUCCEEDED',trigger:{source:'manual'},objectiveStatus:'in_progress'}]};
  const facts = plannerOrchestrationFacts(job,false);
  assert.equal(facts.continuationMaterialized,true);
  assert.equal(decidePlannerOrchestration(facts).target,'created');
});


test('terminal failed unblock Plan pauses automatic retry until manually requested', () => {
  const job={executionMode:'autonomous',tasks:[{id:'30',kind:'work',state:'DRAFT',unblock:{event:'task.unblocked',at:'2026-10-15T01:20:24Z',source:'cli',reason:'retry',baseline:{blockedAt:'2026-10-15T01:10:00Z'}}}],plans:[{id:'plan-8',round:8,status:'FAILED',trigger:{source:'unblock',taskIds:['30']},objectiveStatus:'in_progress'}]};
  const facts=plannerOrchestrationFacts(job,false);
  assert.equal(facts.noActivePlanner,false);
  assert.equal(decidePlannerOrchestration(facts).target,'wait');
});
