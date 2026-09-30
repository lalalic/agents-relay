import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { decidePlannerOrchestration } from '../dist/workflow/planner-orchestration-v2.js';

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
