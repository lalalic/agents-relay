import test from 'node:test';
import assert from 'node:assert/strict';
import {runReplay} from './l3-replay.mjs';

/** Real Review Graph transitions, SHA fencing, repair task creation,
 * Troubleshooter-owned recovery, restart, Merge completion and SQLite authority.
 * Only the external model launches and Git merge receipts are simulated. */
test('review changes-required -> fix -> new SHA -> reviewer fails -> troubleshooter -> approved -> merge retry -> Objective COMPLETED',async()=>{
 const steps=[
   {type:'task.completed',taskId:'a'},
   {type:'mock.claim',taskId:'@review',executionId:'review-1'},
   {type:'review.started',taskId:'@review',executionId:'review-1',data:{head_sha:'head-1'}},
   {type:'review.changes_required',taskId:'@review',executionId:'review-1',data:{head_sha:'head-1',blocking_findings:[{message:'missing invariant'}]}},
   {type:'mock.claim',taskId:'@fix',executionId:'fix-1'},
   {type:'task.started',taskId:'@fix',executionId:'fix-1'},
   {type:'task.completed',taskId:'@fix',executionId:'fix-1'},
   {type:'job.head.changed',headSha:'head-2'},
   {type:'reconcile'},
   {type:'review.approved',taskId:'final-review-head-1',executionId:'review-1',data:{head_sha:'head-1'},expectIgnored:true},
   {type:'mock.claim',taskId:'@review',executionId:'review-2'},
   {type:'review.started',taskId:'@review',executionId:'review-2',data:{head_sha:'head-2'}},
   {type:'task.failed',taskId:'@review',executionId:'review-2',data:{reason:'reviewer_transport_failure'}},
   {type:'mock.claim',taskId:'troubleshoot-final-review-head-2',executionId:'troubleshoot-2'},
   {type:'task.started',taskId:'troubleshoot-final-review-head-2',executionId:'troubleshoot-2'},
   {type:'task.recover',taskId:'@review',recoveryTaskId:'troubleshoot-final-review-head-2'},
   {type:'task.completed',taskId:'troubleshoot-final-review-head-2',executionId:'troubleshoot-2'},
   {type:'restart'},
   {type:'mock.claim',taskId:'@review',executionId:'review-3'},
   {type:'review.started',taskId:'@review',executionId:'review-3',data:{head_sha:'head-2'}},
   {type:'review.approved',taskId:'@review',executionId:'review-3',data:{head_sha:'head-2'}},
   {type:'restart'},
   {type:'mock.clock.advance',millis:5000},
   {type:'reconcile'},
 ];
 const result=await runReplay({id:'review-recovery-objective-convergence',autoMerge:true,reviewEnabled:true,headSha:'head-1',mergeOutcomes:['failed','succeeded'],tasks:[{id:'a'}],steps,
   expected:{jobState:'COMPLETED',localMergeStatus:'succeeded',tasks:{a:'SUCCEEDED','final-review-head-1':'SUCCEEDED','review-fix-head-1':'SUCCEEDED','final-review-head-2':'SUCCEEDED','troubleshoot-final-review-head-2':'SUCCEEDED'}}});
 assert.equal(result.outcome,'PASS',result.errors.join('; '));
 assert.equal(result.trace.at(-1).jobState,'COMPLETED');
 assert.equal(result.externalGitAttempts,2);
 assert.ok(result.actionTraces.length >= 5);
 assert.ok(result.actionTraces.every(x=>x.outcome==='Verified'), 'Reviewer and Worker launches verified by authoritative SQLite');
 assert.deepEqual(result.observedEvents.filter(x=>x.event.startsWith('job.merge.')).map(x=>x.event),['job.merge.failed','job.merge.succeeded']);
 assert.equal(result.trace[9].progress,false,'stale approval of superseded SHA is rejected');
 assert.equal(result.trace[3].after.some(t=>t.id==='review-fix-head-1'&&t.state==='QUEUED'),true);
 assert.equal(result.trace[12].after.some(t=>t.id==='final-review-head-2'&&t.state==='FAILED'),true);
 assert.equal(result.trace[16].after.some(t=>t.id==='troubleshoot-final-review-head-2'&&t.state==='SUCCEEDED'),true);
});
