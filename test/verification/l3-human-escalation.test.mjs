import test from 'node:test';
import assert from 'node:assert/strict';
import {runReplay} from './l3-replay.mjs';

test('human escalation durable event -> notification receipt -> unblock Troubleshooter -> recover original -> Objective COMPLETED',async()=>{
 const result=await runReplay({id:'human-escalation-objective',autoMerge:true,tasks:[{id:'a'}],steps:[
   {type:'task.failed',taskId:'a'},
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
   {type:'task.completed',taskId:'a',executionId:'worker-2'},
   {type:'job.merge.succeeded'},
   {type:'reconcile'},
 ],expected:{jobState:'COMPLETED',tasks:{a:'SUCCEEDED','troubleshoot-a':'SUCCEEDED'},localMergeStatus:'succeeded'}});
 assert.equal(result.outcome,'PASS',result.errors.join('; '));
 const escalationEvents=result.observedEvents.filter(e=>e.event==='escalation.requested');
 assert.equal(escalationEvents.length,1,'repeated escalation never duplicates notification request');
 assert.deepEqual(result.trace[1].escalations,[{taskId:'troubleshoot-a',status:'pending',notificationStatus:'pending'}]);
 assert.equal(result.trace[1].after.find(t=>t.id==='a').state,'FAILED','original stays failed');
 assert.equal(result.trace[1].after.find(t=>t.id==='troubleshoot-a').state,'BLOCKED');
 assert.equal(result.trace[4].escalations[0].notificationStatus,'pending','restart alone cannot imply delivery');
 assert.equal(result.trace[5].escalations[0].notificationStatus,'delivered');
 assert.equal(result.trace[6].escalations[0].status,'responded');
 assert.equal(result.trace[6].after.find(t=>t.id==='a').state,'FAILED','human response alone cannot claim original recovery');
 assert.equal(result.trace.at(-2).jobState,'ACTIVE');
 assert.equal(result.trace.at(-1).jobState,'COMPLETED');
});
