import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { completionGateSatisfied } from '../dist/task-transitions.js';
const work={id:'implementation',kind:'work',agentName:'implementation',state:'SUCCEEDED'};
const reviewer={id:'previous-review',kind:'work',agentName:'reviewer',state:'SUCCEEDED'};
const job=(status,nextTasks=[],tasks=[work])=>({tasks,plans:[{id:'plan-10',round:10,status:'SUCCEEDED',objectiveStatus:status,plannerResult:{next_tasks:nextTasks}}]});
test('pre-merge review requires satisfied latest plan and terminal work',()=>{
  assert.equal(completionGateSatisfied(job('in_progress')),false);
  assert.equal(completionGateSatisfied(job('satisfied',[],[])),false,'satisfied Plan without real implementation is not completion evidence');
  assert.equal(completionGateSatisfied(job('satisfied',[],[reviewer])),false,'Reviewer-only history is not implementation evidence');
  assert.equal(completionGateSatisfied(job('satisfied',[],[{id:'plan-10',kind:'planner',state:'SUCCEEDED'}])),false,'Planner-only success is not implementation evidence');
  assert.equal(completionGateSatisfied(job('satisfied',[],[work,reviewer])),true);
  assert.equal(completionGateSatisfied(job('in_progress',[{id:'more-work'}],[work,reviewer])),false);
  assert.equal(completionGateSatisfied(job('in_progress',[],[{...work,state:'RUNNING'},reviewer])),false);
});
test('new failed plan does not reuse historical review readiness',()=>{
  const j=job('in_progress',[],[work,reviewer]);j.plans.push({id:'plan-11',round:11,status:'FAILED',objectiveStatus:'in_progress'});
  assert.equal(completionGateSatisfied(j),false);
});
