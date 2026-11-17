import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { reviewWorkSettled, reviewNeedsReplan, reviewPlanReady } from '../dist/review-replan.js';
import { plannerOrchestrationFacts, decidePlannerOrchestration } from '../dist/workflow/planner-orchestration-v2.js';
import { decideReviewLifecycle } from '../dist/workflow/review-v2.js';
import { createPlanRound, plannerInput } from '../dist/planner.js';
import { completionGateSatisfied } from '../dist/task-transitions.js';

function job(outcome = 'SUCCEEDED') {
  return {
    id:'jel', repository:'lalalic/agents-relay', state:'ACTIVE', priority:'P2', reviewEnabled:true, headSha:'sha1',
    tasks:[{ id:'work',kind:'work',agentName:'implementation',state:outcome,
      planningDecisionId:'plan-1',createdAt:'2026-11-10T10:00:00Z',dependencies:[] }],
    plans:[{ id:'plan-1',round:1,status:'SUCCEEDED',trigger:{source:'initial'},
      objectiveStatus:'in_progress',generatedTaskIds:['work'],createdAt:'2026-11-10T10:00:00Z' }],
  };
}
function reviewFacts(j) {
  return {reviewEnabled:true,jobActive:true,reviewWorkSettled:reviewWorkSettled(j),
    headAvailable:true,reviewPlanReady:reviewPlanReady(j,j.headSha),noActiveReviewTask:true,noApprovedCurrentReview:true};
}
test('JEL starts Final Review directly after any terminal Task outcome, never automatic Plan 2', () => {
  for (const state of ['SUCCEEDED','FAILED','CANCELLED']) {
    const j=job(state);
    if (state === 'FAILED') {
      j.tasks[0].attempt=1;
      j.tasks.push({id:'troubleshoot-work',kind:'work',agentName:'troubleshooter',parentTaskId:'work',
        state:'SUCCEEDED',recoveryForAttempt:1});
    }
    assert.equal(reviewWorkSettled(j),true,state);
    assert.equal(decideReviewLifecycle(undefined,'reconcile',reviewFacts(j)).target,'PENDING',state);
    assert.equal(decidePlannerOrchestration(plannerOrchestrationFacts(j,false)).target,'wait',state);
    if(state!=='SUCCEEDED') assert.equal(completionGateSatisfied(j),false, 'A terminal failure/cancellation cannot qualify for merge');
  }
  for (const state of ['RUNNING','QUEUED','DRAFT','BLOCKED','AWAITING_DECISION']) {
    const j=job(state);
    assert.equal(reviewWorkSettled(j),false,state);
    assert.equal(decideReviewLifecycle(undefined,'reconcile',reviewFacts(j)).target,'NONE',state);
  }
  const unresolved=job('FAILED');
  assert.equal(reviewWorkSettled(unresolved),false,'a newly failed Task must receive recovery before Final Review');
  const j=job();j.tasks.push({id:'recovery',kind:'work',agentName:'troubleshooter',state:'BLOCKED'});
  assert.equal(reviewWorkSettled(j),false,'unresolved Troubleshooter blocks Review');
});

test('CHANGES_REQUIRED -> exactly one finding-bound Plan -> revision Task -> fresh Final Review', () => {
  const j=job();
  j.tasks.push({id:'review1',kind:'work',agentName:'job-acceptance-reviewer',state:'SUCCEEDED'});
  j.review={outcome:'changes_required',taskId:'review1',headSha:'sha1',revisionDisposition:'needs-ownership',
    evidence:{data:{findings:[{id:'test-gap',summary:'A required regression is missing',ownerTaskId:'work'}]}}};
  assert.equal(reviewNeedsReplan(j),true);
  assert.equal(decidePlannerOrchestration(plannerOrchestrationFacts(j,false)).target,'created');
  const plan=createPlanRound(j,{now:'2026-11-10T10:05:00Z'});
  assert.equal(plan.trigger.source,'review');
  assert.equal(plan.trigger.reviewTaskId,'review1');
  j.plans.push(plan);
  assert.equal(reviewNeedsReplan(j),false,'persistent Plan identity makes retries idempotent');
  assert.equal(reviewPlanReady(j),false,'cannot re-review a PLANNING round');
  plan.status='SUCCEEDED';plan.generatedTaskIds=['fix1'];
  j.tasks.push({id:'fix1',kind:'work',agentName:'implementation',state:'RUNNING',planningDecisionId:plan.id});
  assert.equal(reviewWorkSettled(j),false);
  assert.equal(decideReviewLifecycle('changes_required','reconcile',reviewFacts(j)).target,'CHANGES_REQUIRED');
  j.tasks.at(-1).state='SUCCEEDED';
  assert.equal(reviewPlanReady(j),false,'repair success without a new commit cannot re-review the same SHA');
  j.headSha='sha2';
  assert.equal(reviewPlanReady(j),true,'a changed committed SHA releases the re-review gate');
  const renewed=decideReviewLifecycle('changes_required','reconcile',reviewFacts(j));
  assert.equal(renewed.target,'PENDING');
  assert.deepEqual(renewed.actions.map(action=>action.id),['review.create']);
});

test('review never begins during planning, and historical targeted requests remain compatible', () => {
  const j=job('FAILED');j.plans.push({id:'plan-2',round:2,status:'PLANNING',trigger:{source:'manual'}});
  assert.equal(reviewPlanReady(j),false);
  assert.equal(decideReviewLifecycle(undefined,'reconcile',reviewFacts(j)).target,'NONE');
  j.plans.pop();j.review={outcome:'changes_required',taskId:'old',revisionDisposition:'targeted'};
  assert.equal(reviewNeedsReplan(j),false,'historical targeted review children remain owned by the existing revision Graph');
});

test('a stale changes-required review still provides the original findings to Planner N+1', () => {
  const j=job();
  j.review={outcome:'stale',taskId:'review-old',headSha:'old-head',revisionDisposition:'needs-ownership',
    evidence:{data:{findings:[{id:'F-7',summary:'Preserve cancellation behavior',ownerTaskId:'work'}]}}};
  j.reviewRevisionRounds=[{reviewTaskId:'review-old',headSha:'old-head',status:'changes_required'}];
  assert.equal(reviewNeedsReplan(j),true);
  const next=createPlanRound(j,{now:'2026-11-10T10:06:00Z'});
  assert.equal(next.trigger.source,'review');
  const prompt=JSON.parse(plannerInput({job:j,tasks:j.tasks,objective:j.objective,
    previousPlannerTaskId:'plan-1',trigger:next.trigger}));
  assert.equal(prompt.review_feedback.task_id,'review-old');
  assert.match(prompt.review_feedback.findings,/Preserve cancellation behavior/);
});

test('a no-op review Plan cannot spin Final Review without a real fix', () => {
  const j=job();
  j.headSha='SHA';
  j.review={outcome:'changes_required',taskId:'review1',headSha:'SHA',revisionDisposition:'needs-ownership'};
  j.tasks.push({id:'review1',kind:'work',agentName:'job-acceptance-reviewer',state:'SUCCEEDED'});
  j.plans.push({id:'plan-2',round:2,status:'SUCCEEDED',trigger:{source:'review',reviewTaskId:'review1'},
    objectiveStatus:'satisfied',generatedTaskIds:[]});
  assert.equal(reviewNeedsReplan(j),false,'the review finding was already assigned one planning round');
  assert.equal(reviewPlanReady(j),false,'same reviewed SHA cannot spin another Final Review');
  const decision=decideReviewLifecycle('changes_required','reconcile',reviewFacts(j));
  assert.equal(decision.target,'CHANGES_REQUIRED');
  assert.deepEqual(decision.actions.map(action=>action.id),[]);
  j.headSha='new-SHA';
  assert.equal(reviewPlanReady(j),true,'new immutable head, not a plan-created task, unlocks re-review');
});

test('Job 658: initial Plan repair plus empty review Plan re-reviews only on new committed SHA', () => {
  const j=job();j.id='658';j.headSha='e2828b1';
  j.tasks.push({id:'1945',kind:'work',agentName:'job-acceptance-reviewer',state:'SUCCEEDED'});
  j.tasks.push({id:'1946',kind:'work',agentName:'implementation',state:'SUCCEEDED',planningDecisionId:'plan-1'});
  j.plans[0].generatedTaskIds.push('1946');
  j.plans.push({id:'plan-2',status:'SUCCEEDED',trigger:{source:'review',reviewTaskId:'1945'},
    objectiveStatus:'satisfied',generatedTaskIds:[]});
  j.review={outcome:'changes_required',headSha:'e2828b1',taskId:'1945',revisionDisposition:'needs-ownership'};
  assert.equal(reviewWorkSettled(j),true);
  assert.equal(reviewNeedsReplan(j),false);
  assert.equal(reviewPlanReady(j),false,'uncommitted work cannot authorize a second review');
  assert.equal(decideReviewLifecycle('changes_required','reconcile',reviewFacts(j)).target,'CHANGES_REQUIRED');
  assert.equal(reviewPlanReady(j,null),false,'a missing source HEAD never qualifies');
  j.headSha='d4e5f6a';
  assert.equal(reviewPlanReady(j),true,'source HEAD change qualifies despite plan-2 generating no Tasks');
  assert.deepEqual(decideReviewLifecycle('changes_required','reconcile',reviewFacts(j)).actions.map(a=>a.id),['review.create']);
  j.review={...j.review,outcome:'stale'};
  j.reviewRevisionRounds=[{reviewTaskId:'1945',headSha:'e2828b1',status:'changes_required'}];
  assert.equal(reviewPlanReady(j),true,'the old finding stays in audit after SHA invalidation');
  j.plans[1].status='PLANNING';
  assert.equal(reviewPlanReady(j),false,'active Planner still blocks premature review');
  j.plans[1].status='SUCCEEDED';j.tasks.at(-1).state='RUNNING';
  assert.equal(reviewWorkSettled(j),false,'an active repair still blocks Review');
});

test('failed review-triggered Plan is retried only after verified Planner recovery', () => {
  const j=job();
  j.review={outcome:'changes_required',taskId:'review-old',headSha:'head',revisionDisposition:'needs-ownership'};
  j.tasks.push({id:'review-old',kind:'work',agentName:'job-acceptance-reviewer',state:'SUCCEEDED'});
  j.plans.push({id:'plan-2',round:2,status:'FAILED',trigger:{source:'review',reviewTaskId:'review-old'},
    error:'planner execution failed',generatedTaskIds:[]});
  assert.equal(reviewNeedsReplan(j),true,'failed Plan does not consume findings');
  assert.equal(decidePlannerOrchestration(plannerOrchestrationFacts(j,false)).target,'created',
    'initial failure schedules a Plan Troubleshooter, not premature replan');
  j.tasks.push({id:'troubleshoot-plan-2',kind:'work',agentName:'troubleshooter',state:'SUCCEEDED',
    recoveryPlanId:'plan-2',result:{data:{verified:true,evidence:'planner context and runtime restored'}}});
  assert.equal(decidePlannerOrchestration(plannerOrchestrationFacts(j,false)).target,'created',
    'verified recovery schedules the next Plan');
  j.plans.push({id:'plan-3',round:3,status:'PLANNING',trigger:{source:'review',reviewTaskId:'review-old'},
    generatedTaskIds:[]});
  assert.equal(reviewNeedsReplan(j),false,'a fresh pending Plan prevents duplicate rounds');
  assert.equal(decidePlannerOrchestration(plannerOrchestrationFacts(j,false)).target,'wait');
});
