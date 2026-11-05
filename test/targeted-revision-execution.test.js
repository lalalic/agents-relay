import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { recordTargetedRevisionRequest } from '../dist/review-revision-model.js';
import { reconcileReviewRevisionFacts, revisionRequestReady } from '../dist/review-revision-execution.js';
import { reconcileTaskDependencies } from '../dist/workflow/task-reconcile.js';
import { decideReviewLifecycle } from '../dist/workflow/review-v2.js';
import { implementationComplete } from '../dist/runtime-status.js';
import { validatePlannerAgentRoles } from '../dist/planner.js';
import { parseRevisionFindings } from '../dist/cli-revision.js';
import { isFinalReviewAgent } from '../dist/final-review-role.js';

const now = () => new Date().toISOString();
const task = (id, state='SUCCEEDED') => ({id,jobId:'test',parentTaskId:null,dependencies:[],capabilities:[],agentName:'implementation',kind:'work',adapter:'codex',input:'original',output:{kind:'task_pr'},state,attempt:1,maxAttempts:3,leaseOwner:null,leaseExpiresAt:null,executionId:null,threadId:null,result:{summary:'original OK'},error:null,timeoutMs:10000,createdAt:now(),updatedAt:now()});
function fixture() {
 const owner = task('owner'); const review = {...task('review','RUNNING'),agentName:'job-acceptance-reviewer',reviewHeadSha:'head',executionId:'exec',dependencies:['owner'],result:null};
 return {id:'test',title:'test',repository:'t/test',state:'ACTIVE',prNumber:0,continuation:null,headSha:'head',createdAt:now(),updatedAt:now(),review:{outcome:'started',taskId:'review',headSha:'head',evidence:null,updatedAt:now()},tasks:[owner,review]};
}
const request = (id, finding) => ({requestId:id,reviewTaskId:'review',reviewExecutionId:'exec',headSha:'head',originalTaskId:'owner',findings:[{id:finding,summary:finding}]});

test('revision lifecycle is held until fully covered reviewer changes required verdict, then verified from actual child result', () => {
 const j=fixture();
 recordTargetedRevisionRequest(j,request('req-1','F1'));
 const child=j.tasks[2];
 reconcileTaskDependencies(j);
 assert.equal(child.state,'DRAFT');
 assert.equal(revisionRequestReady(j,child),false);
 assert.equal(reconcileReviewRevisionFacts(j),false);
 j.tasks[1].state='SUCCEEDED';j.tasks[1].executionId=null;
 j.review={...j.review,outcome:'changes_required',revisionDisposition:'needs-ownership'};
 reconcileReviewRevisionFacts(j);
 reconcileTaskDependencies(j);
 assert.equal(child.state,'DRAFT','partial/unowned review cannot dispatch');
 j.review.revisionDisposition='targeted';
 assert.equal(reconcileReviewRevisionFacts(j),true);
 assert.equal(j.reviewRevisionRequests[0].status,'queued');
 reconcileTaskDependencies(j);
 assert.equal(child.state,'QUEUED');
 assert.equal(implementationComplete(j),false);
 child.state='RUNNING';reconcileReviewRevisionFacts(j);
 assert.equal(j.reviewRevisionRequests[0].status,'running');
 child.state='SUCCEEDED';reconcileReviewRevisionFacts(j);
 assert.equal(j.reviewRevisionRequests[0].status,'verified');
 assert.equal(implementationComplete(j),true);
 const settled=decideReviewLifecycle(j.review.outcome,'revision.settled',{targetedRevisionsVerified:true,reviewRoundWithinLimit:true});
 assert.equal(settled.target,'STALE');
 assert.deepEqual(settled.actions.map(x=>x.id),['review.prepareRereview']);
 assert.notEqual(decideReviewLifecycle('changes_required','revision.settled',{targetedRevisionsVerified:false,reviewRoundWithinLimit:true}).target,'STALE');
 assert.notEqual(decideReviewLifecycle('changes_required','revision.settled',{targetedRevisionsVerified:true,reviewRoundWithinLimit:false}).target,'STALE');
});

test('Planner rejects duplicate effective role but accepts independent agents and later rounds', () => {
 const spec=(id,agentName)=>({id,agentName});
 assert.throws(()=>validatePlannerAgentRoles([spec('a','implementation'),spec('b',undefined)]),/duplicate effective Agent role implementation/);
 assert.throws(()=>validatePlannerAgentRoles([spec('a','director'),spec('b','director')]),/duplicate effective Agent role director/);
 assert.throws(()=>validatePlannerAgentRoles([spec('a','job-acceptance-reviewer')]),/Relay creates/);
 assert.doesNotThrow(()=>validatePlannerAgentRoles([spec('a','implementation'),spec('b','video-director')]));
 assert.doesNotThrow(()=>validatePlannerAgentRoles([spec('third-round','implementation')]));
});

test('active named Reviewer role is admitted and strict CLI findings parse reject malformed payloads', () => {
 const j=fixture();assert.equal(isFinalReviewAgent(j.tasks[1].agentName),true);
 assert.equal(recordTargetedRevisionRequest(j,request('r1','F1')).request.revisionTaskId,j.tasks[2].id);
 assert.deepEqual(parseRevisionFindings('[{"id":"A","summary":"fix","evidence":"assert"}]'),[{id:'A',summary:'fix',evidence:'assert'}]);
 for(const sample of ['{}','[]','[{"id":"A","summary":""}]','[{"id":"A","summary":"x"},{"id":"A","summary":"y"}]'])
   assert.throws(()=>parseRevisionFindings(sample));
});
