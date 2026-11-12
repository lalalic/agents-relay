import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { decidePlannerOrchestration, plannerOrchestrationFacts } from '../dist/workflow/planner-orchestration-v2.js';

const base={legacyPlanningPending:false,recoverablePendingPlan:false,hasSeedWork:true,planningRequested:true,noActivePlanner:true,noBlockedWork:true,noActiveImplementation:true,continuationMaterialized:true,reviewNeedsReplan:false};
test('Planner orchestration v2 graph owns wait/recover/create decisions', () => {
  assert.equal(decidePlannerOrchestration({...base,legacyPlanningPending:true}).target,'wait');
  const recover=decidePlannerOrchestration({...base,recoverablePendingPlan:true});
  assert.equal(recover.target,'recovered');
  assert.deepEqual(recover.actions.map(action=>action.id),['planner.recoverPending']);
  assert.equal(decidePlannerOrchestration({...base,noActiveImplementation:false}).target,'wait');
  assert.equal(decidePlannerOrchestration({...base,reviewNeedsReplan:false}).target,'wait');
  const create=decidePlannerOrchestration({...base,reviewNeedsReplan:true});
  assert.equal(create.target,'created');
  assert.deepEqual(create.actions.map(action=>action.id),['planner.createRound']);
});

test('a blocked Troubleshooter keeps Planner waiting despite historical ordinary unblock metadata', () => {
  const job={tasks:[{id:'25',kind:'work',agentName:'troubleshooter',state:'BLOCKED'},{id:'30',kind:'work',state:'FAILED',planningDecisionId:'plan-3',unblock:{at:'2026-10-15T01:20:24Z',source:'cli',reason:'legacy unblock',baseline:{blockedAt:'2026-10-15T01:10:00Z'}}}],plans:[{id:'plan-3',round:3,status:'SUCCEEDED',trigger:{source:'continuation'},objectiveStatus:'in_progress'}]};
  const facts=plannerOrchestrationFacts(job,false);
  assert.equal(plannerOrchestrationFacts(job,false).noBlockedWork,false);
  assert.equal(decidePlannerOrchestration(facts).target,'wait');
});


test('unconsumed unblock bypasses empty successful manual continuation gate', () => {
  const job = {tasks:[{id:'30',kind:'work',state:'DRAFT',planningDecisionId:'plan-3',unblock:{event:'task.unblocked',at:'2026-10-15T01:20:24Z',source:'cli',reason:'retry',baseline:{blockedAt:'2026-10-15T01:10:00Z'}}}],plans:[{id:'plan-7',round:7,status:'SUCCEEDED',trigger:{source:'manual'},objectiveStatus:'in_progress'}]};
  const facts = plannerOrchestrationFacts(job,false);
  assert.equal(facts.continuationMaterialized,true);
  assert.equal(decidePlannerOrchestration(facts).target,'created');
});


test('terminal failed unblock Plan pauses automatic retry until manually requested', () => {
  const job={tasks:[{id:'30',kind:'work',state:'DRAFT',unblock:{event:'task.unblocked',at:'2026-10-15T01:20:24Z',source:'cli',reason:'retry',baseline:{blockedAt:'2026-10-15T01:10:00Z'}}}],plans:[{id:'plan-8',round:8,status:'FAILED',trigger:{source:'unblock',taskIds:['30']},objectiveStatus:'in_progress'}]};
  const facts=plannerOrchestrationFacts(job,false);
  assert.equal(facts.noActivePlanner,false);
  assert.equal(decidePlannerOrchestration(facts).target,'wait');
});

test('review-disabled Jobs retain Planner continuation until objective is satisfied', () => {
  const work={id:'work',kind:'work',state:'SUCCEEDED',planningDecisionId:'plan-1'};
  const root={reviewEnabled:false,tasks:[work],plans:[{id:'plan-1',round:1,status:'SUCCEEDED',
    trigger:{source:'initial'},objectiveStatus:'in_progress'}]};
  const facts=plannerOrchestrationFacts(root,false);
  assert.equal(facts.reviewNeedsReplan,true);
  assert.equal(decidePlannerOrchestration(facts).target,'created');
  root.plans[0].objectiveStatus='satisfied';
  assert.equal(plannerOrchestrationFacts(root,false).reviewNeedsReplan,false);
  assert.equal(decidePlannerOrchestration(plannerOrchestrationFacts(root,false)).target,'wait');
});


test('Plan-free Jobs never spawn an unsolicited Planner after seeded Tasks finish',()=>{
 const job={id:'plan-free',state:'ACTIVE',reviewEnabled:true,tasks:[{id:'root',kind:'work',state:'SUCCEEDED',agentGraph:'flowchart TD\nA[agent:worker]'}],plans:[]};
 const facts=plannerOrchestrationFacts(job,false);
 assert.equal(facts.planningRequested,false);
 assert.equal(decidePlannerOrchestration(facts).target,'wait');
 const enabled=plannerOrchestrationFacts({...job,plans:[{id:'plan-1',round:1,status:'SUCCEEDED',trigger:{source:'initial'},objectiveStatus:'in_progress'}]},false);
 assert.equal(enabled.planningRequested,true);
});


test('a plan-free Graph Job only starts a repair Planner when Final Review explicitly requests changes',()=>{
 const completed={id:'root',kind:'work',state:'SUCCEEDED',agentGraph:'flowchart TD\nA[agent:worker]'};
 const job={id:'plan-free-review',state:'ACTIVE',reviewEnabled:true,tasks:[completed,
   {id:'final-review',kind:'work',agentName:'job-acceptance-reviewer',state:'SUCCEEDED'}],plans:[],
   review:{taskId:'final-review',outcome:'changes_required',headSha:'abc',revisionDisposition:'needs-ownership'}};
 const facts=plannerOrchestrationFacts(job,false);
 assert.equal(facts.planningRequested,true);
 assert.equal(decidePlannerOrchestration(facts).target,'created');
});
