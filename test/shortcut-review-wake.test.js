import test from './test-runtime.js';
import assert from 'node:assert/strict';
import {eligibleShortcutReviewTask,createShortcutReviewWake} from '../dist/shortcut-review-wake.js';
import {RepositoryWorkerPool} from '../dist/pool.js';
import {MemoryEventBus,eventFor} from '../dist/events.js';
const executionId='exec-old';
const fixture=()=>({id:'611',repository:'local/vlog',state:'ACTIVE',executionMode:'shortcut',contentOnly:true,
 shortcutExecutionStartedAt:new Date().toISOString(),shortcutRunnerContext:{projectPath:'/fixture/project',workspaceRoot:'/fixture',noGitHub:true},
 tasks:[{id:'content-run',state:'QUEUED',executionId:null,leaseOwner:null,agentGraph:'flowchart TD\nA[agent:alpha]',
 interactiveInvocation:{status:'approved',invocationId:executionId,executionId,revision:executionId,decidedAt:new Date().toISOString()},
 result:{data:{shortcut:{inFlight:{A:executionId}}}}}]});
test('Shortcut review event launches only a trusted previously started and decided Task',()=>{
 assert.equal(eligibleShortcutReviewTask(fixture(),'content-run')?.id,'content-run');
 for(const modify of [
  j=>delete j.shortcutExecutionStartedAt,j=>delete j.shortcutRunnerContext,
  j=>j.state='CANCELLED',j=>j.state='DRAFT',j=>j.pause={reason:'user'},
  j=>j.tasks[0].state='AWAITING_DECISION',j=>j.tasks[0].state='RUNNING',
  j=>j.tasks[0].executionId='still-leased',j=>j.tasks[0].leaseOwner='worker',
  j=>delete j.tasks[0].interactiveInvocation.decidedAt,
  j=>j.tasks[0].interactiveInvocation.status='awaiting_decision',
  j=>j.tasks[0].interactiveInvocation.revision='not-current-execution',
  j=>j.tasks[0].interactiveInvocation.executionId='different',
  j=>j.tasks[0].result.data.shortcut.inFlight={},
 ]){const j=fixture();modify(j);assert.equal(eligibleShortcutReviewTask(j,'content-run'),null);}
 const j=fixture();j.tasks[0].interactiveInvocation.status='changes_requested';
 assert.equal(eligibleShortcutReviewTask(j,'content-run')?.id,'content-run');
});
test('event listener starts CLI once and never on inventory/reconcile scans',async()=>{
 const job=fixture();let calls=0,done;
 const gate=new Promise(resolve=>done=resolve);
 const listener=createShortcutReviewWake(async()=>job,async()=>{calls++;await gate;});
 const pool=new RepositoryWorkerPool(2,()=>({applyEvent:async()=>({applied:false,reconcile:false,reason:'task.interactive_decision.duplicate'}),reconcile:async()=>null}),
  async()=>[{job}],async()=>({job,store:{}}),listener);
 await pool.reconcile();assert.equal(calls,0,'no job-scan auto dispatch');
 const bus=new MemoryEventBus();const stop=await pool.watch(bus);
 await bus.publish(eventFor(job.id,'content-run',null,'task.interactive_decision','running','decision received'));
 for(let i=0;i<50&&!calls;i++)await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(calls,1);
 await bus.publish(eventFor(job.id,'content-run',null,'task.interactive_decision','running','duplicate decision'));
 await new Promise(resolve=>setTimeout(resolve,30));assert.equal(calls,1,'deduplicated while CLI running');
 job.tasks[0].state='RUNNING';done();await new Promise(resolve=>setTimeout(resolve,10));
 await stop();
});
test('no Shortcut event means no Shortcut CLI, ordinary Jobs continue normal dispatch',async()=>{
 const job=fixture();let calls=0;
 const listener=createShortcutReviewWake(async()=>job,async()=>{calls++});
 assert.equal(await listener(job.id,'wrong-task'),true);
 assert.equal(calls,0);
 job.executionMode='normal';assert.equal(await listener(job.id,'content-run'),false);
 assert.equal(calls,0);
});
test('human review listener handles both Approve and Request Changes',async()=>{
 const job=fixture();const decisions=[];
 const listener=createShortcutReviewWake(async()=>job,async j=>{decisions.push(j.tasks[0].interactiveInvocation.status);});
 assert.equal(await listener(job.id,'content-run'),true);
 await new Promise(resolve=>setImmediate(resolve));
 job.tasks[0].interactiveInvocation={...job.tasks[0].interactiveInvocation,
  status:'changes_requested',invocationId:'inv-second',decidedAt:new Date().toISOString()};
 assert.equal(await listener(job.id,'content-run'),true);
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(decisions,['approved','changes_requested']);
});
