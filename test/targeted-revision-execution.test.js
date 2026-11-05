import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { recordTargetedRevisionRequest } from '../dist/review-revision-model.js';
import { reconcileReviewRevisionFacts, revisionRequestReady } from '../dist/review-revision-execution.js';
import { settleReviewRevisionRound } from '../dist/review-revision-settlement.js';
import { reconcileTaskDependencies } from '../dist/workflow/task-reconcile.js';
import { decideReviewLifecycle } from '../dist/workflow/review-v2.js';
import { decideRevisionLifecycle } from '../dist/workflow/revision-v2.js';
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
 assert.deepEqual(decideReviewLifecycle('changes_required','revision.settled',{targetedRevisionsVerified:true,reviewRoundWithinLimit:false}).actions.map(x=>x.id),['review.requireOwnerResolution']);
});

test('recovered revision requeues the same child through Graph without another feedback request', () => {
 const j=fixture();recordTargetedRevisionRequest(j,request('retry-request','F1'));
 const child=j.tasks[2];j.tasks[1].state='SUCCEEDED';
 j.review={...j.review,outcome:'changes_required',revisionDisposition:'targeted'};
 assert.equal(reconcileReviewRevisionFacts(j),true);
 child.state='RUNNING';child.executionId='first-execution';
 assert.equal(reconcileReviewRevisionFacts(j),true);
 child.state='FAILED';child.executionId=null;
 assert.equal(reconcileReviewRevisionFacts(j),true);
 assert.equal(j.reviewRevisionRequests[0].status,'failed');
 assert.equal(revisionRequestReady(j,child),false);
 assert.notEqual(decideRevisionLifecycle('FAILED','revision.retry',{taskRetryQueued:false}).target,'QUEUED');
 // Simulate the authorized Task Graph recovery; the revision layer never
 // changes Task.state or creates another child independently.
 child.state='QUEUED';
 assert.equal(reconcileReviewRevisionFacts(j),true);
 assert.equal(j.reviewRevisionRequests[0].status,'queued');
 assert.equal(revisionRequestReady(j,child),true);
 assert.equal(reconcileReviewRevisionFacts(j),false);
 assert.equal(j.tasks.length,3);
 child.state='RUNNING';child.executionId='new-execution';
 reconcileReviewRevisionFacts(j);
 child.state='SUCCEEDED';reconcileReviewRevisionFacts(j);
 assert.equal(j.reviewRevisionRequests[0].status,'verified');
});

test('exhausted review cycle records durable owner-resolution gate and cannot silently re-review', async () => {
 const j=fixture();recordTargetedRevisionRequest(j,request('limit-request','F1'));
 j.tasks[1].state='SUCCEEDED';j.tasks[2].state='SUCCEEDED';
 j.review={...j.review,outcome:'changes_required',revisionDisposition:'targeted'};
 j.reviewRevisionRequests[0].status='verified';
 j.reviewRevisionRounds=Array.from({length:5},(_,i)=>({
   reviewTaskId:'review-'+i,reviewExecutionId:'execution-'+i,headSha:'head',
   requestIds:[],status:'changes_required',recordedAt:now(),
 }));
 const store={mutateJob:async(_id, mutate)=>mutate(j)};
 const settled=await settleReviewRevisionRound(store,j);
 assert.equal(settled.review.outcome,'changes_required');
 assert.equal(settled.review.revisionDisposition,'needs-ownership');
 assert.equal(settled.tasks.find(t=>t.id==='review').comments.length,1);
 await settleReviewRevisionRound(store,j);
 assert.equal(settled.tasks.find(t=>t.id==='review').comments.length,1);
});

test('Planner rejects duplicate effective role but accepts independent agents and later rounds', () => {
 const spec=(id,agentName)=>({id,agentName});
 assert.throws(()=>validatePlannerAgentRoles([spec('a','implementation'),spec('b',undefined)]),/duplicate effective Agent role implementation/);
 assert.throws(()=>validatePlannerAgentRoles([spec('a','director'),spec('b','director')]),/duplicate effective Agent role director/);
 assert.throws(()=>validatePlannerAgentRoles([spec('a','job-acceptance-reviewer')]),/Relay creates/);
 assert.throws(()=>validatePlannerAgentRoles([spec('a','reviewer')]),/Relay creates/);
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

test('targeted revision preserves exact compatible original ChatGPT FIFO new-turn identity; incompatible adapter fails safe', async () => {
 const { prepareRevisionThreadDelivery } = await import('../dist/reviewer-thread.js');
 const original = {...task('owner'),adapter:'chatgpt',threadId:'thread-1',threadUrl:'https://chatgpt.com/c/thread-1',
   routing:{provider:'chatgpt',projectId:'p',model:'account-defaults'}};
 const buildChild = () => ({...task('child','QUEUED'),adapter:'chatgpt',executionId:'revision-execution',
   routing:{provider:'chatgpt',projectId:'p',model:'account-defaults'},
   revision:{kind:'targeted',originalTaskId:'owner',reviewTaskId:'review',basedOnHeadSha:'head',requestIds:['r1']}});
 const j={...fixture(),tasks:[original]};
 const matching=buildChild();
 assert.equal(prepareRevisionThreadDelivery(j,matching).threadId,'thread-1');
 assert.equal(matching.revision.threadContinuation.decision,'reuse');
 assert.equal(prepareRevisionThreadDelivery(j,matching).requestId,'test:child:revision-execution');
 const unavailable=buildChild();unavailable.adapter='codex';
 assert.equal(prepareRevisionThreadDelivery(j,unavailable),undefined);
 assert.equal(unavailable.revision.threadContinuation.decision,'fallback');
 const deleted=buildChild();j.tasks[0].threadDeletedAt=new Date().toISOString();
 assert.equal(prepareRevisionThreadDelivery(j,deleted),undefined);
 assert.equal(deleted.revision.threadContinuation.decision,'fallback');
 j.tasks[0].threadDeletedAt=undefined;
 matching.adapter='codex';
 assert.throws(()=>prepareRevisionThreadDelivery(j,matching),/refuse uncertain duplicate send/);
});
