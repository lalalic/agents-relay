import test from 'node:test';
import assert from 'node:assert/strict';
import {runReplay} from './l3-replay.mjs';

test('human escalation durable event -> notification receipt -> unblock Troubleshooter -> recover original -> Objective COMPLETED',async()=>{
 const result=await runReplay({id:'human-escalation-objective',autoMerge:true,tasks:[{id:'a'}],steps:[
   {type:'task.failed',taskId:'a'},
   {type:'mock.claim',taskId:'troubleshoot-a',executionId:'recovery-1'},
   {type:'task.started',taskId:'troubleshoot-a',executionId:'recovery-1'},
   {type:'task.escalate',taskId:'a'},
   {type:'task.escalate',taskId:'a'},
   {type:'restart'},
   {type:'reconcile'},
   {type:'mock.notification.delivered',taskId:'a'},
   {type:'human.unblock',taskId:'a',response:'Approved the identity request'},
   {type:'mock.claim',taskId:'troubleshoot-a',executionId:'recovery-2'},
   {type:'task.started',taskId:'troubleshoot-a',executionId:'recovery-2'},
   {type:'task.recover',taskId:'a'},
   {type:'task.completed',taskId:'troubleshoot-a',executionId:'recovery-2'},
   {type:'mock.claim',taskId:'a',executionId:'worker-2'},
   {type:'task.started',taskId:'a',executionId:'worker-2'},
   {type:'task.failed',taskId:'a',executionId:'worker-2',reason:'repeat semantic failure'},
   {type:'restart'},
   {type:'reconcile'},
   {type:'mock.claim',taskId:'troubleshoot-a',executionId:'recovery-3'},
   {type:'task.started',taskId:'troubleshoot-a',executionId:'recovery-3'},
   {type:'task.recover',taskId:'a'},
   {type:'task.completed',taskId:'troubleshoot-a',executionId:'recovery-3'},
   {type:'mock.claim',taskId:'a',executionId:'worker-3'},
   {type:'task.started',taskId:'a',executionId:'worker-3'},
   {type:'task.completed',taskId:'a',executionId:'worker-3'},
   {type:'job.merge.succeeded'},
   {type:'reconcile'},
 ],expected:{jobState:'COMPLETED',tasks:{a:'SUCCEEDED','troubleshoot-a':'SUCCEEDED'},localMergeStatus:'succeeded'}});
 assert.equal(result.outcome,'PASS',result.errors.join('; '));
 const escalationEvents=result.observedEvents.filter(e=>e.event==='escalation.requested');
 assert.equal(escalationEvents.length,1,'repeated escalation never duplicates notification request');
 const firstBlocked=result.trace.find(t=>t.after.find(x=>x.id==='troubleshoot-a')?.state==='BLOCKED');
 assert.deepEqual(firstBlocked.escalations,[{taskId:'troubleshoot-a',status:'pending',notificationStatus:'pending'}]);
 assert.equal(firstBlocked.after.find(t=>t.id==='a').state,'FAILED','original stays failed');
 assert.ok(result.trace.every(t=>t.after.find(x=>x.id==='a')?.state!=='BLOCKED'),'ordinary original never enters BLOCKED');
 const retryResolutions=result.trace.filter(t=>t.event==='task.recover').map(t=>t.taskResolutions.find(r=>r.taskId==='a'));
 assert.deepEqual(retryResolutions.map(r=>r?.recoveryExecutionId),['recovery-2','recovery-3'],'each retry uses a fresh resolution from the rerun Troubleshooter execution');
 assert.deepEqual(retryResolutions.map(r=>r?.state),['resolved','resolved']);
 assert.notEqual(retryResolutions[0]?.recoveryExecutionId,retryResolutions[1]?.recoveryExecutionId,'a prior resolved resolution cannot authorize a later attempt');
 const responseTrace=result.trace.find(t=>t.escalations[0]?.status==='responded');
 assert.equal(responseTrace.after.find(t=>t.id==='a').state,'FAILED','human response alone cannot claim original recovery');
 const failedOriginals=result.trace.filter(t=>t.after.find(x=>x.id==='a')?.state==='FAILED');
 assert.ok(failedOriginals.length>=2,'the repeated worker failure remains FAILED before a fresh recovery cycle');
 assert.equal(result.trace.at(-2).jobState,'ACTIVE');
 assert.equal(result.trace.at(-1).jobState,'COMPLETED');
});
