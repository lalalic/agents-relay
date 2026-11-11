import test from './test-runtime.js';
import assert from 'node:assert/strict';
import {shortcutAutoResumeTask} from '../dist/shortcut-auto-resume.js';
import {RepositoryWorkerPool} from '../dist/pool.js';
const sha='a'.repeat(40), executionId='exec-old', invocationId='inv-one';
const fresh=()=>({id:'610',repository:'local/vlog',state:'ACTIVE',executionMode:'shortcut',contentOnly:true,
 shortcutExecutionStartedAt:new Date().toISOString(),shortcutRunnerContext:{projectPath:'/fixture/project',workspaceRoot:'/fixture',noGitHub:true},tasks:[{id:'content-run',state:'QUEUED',executionId:null,leaseOwner:null,
 agentGraph:'flowchart TD\nA[agent:alpha]',interactiveInvocation:{status:'changes_requested',
 invocationId,executionId,revision:sha,decidedAt:new Date().toISOString()},
 result:{data:{shortcut:{inFlight:{A:executionId}}}}}]});
test('auto-resume is authorized only by a previously launched, exact decided Review',()=>{
 assert.equal(shortcutAutoResumeTask(fresh())?.id,'content-run');
 for(const modify of [
   j=>delete j.shortcutExecutionStartedAt, j=>delete j.shortcutRunnerContext,
   j=>j.state='DRAFT',j=>j.state='CANCELLED',j=>j.pause={reason:'operator'},
   j=>j.tasks[0].state='AWAITING_DECISION', j=>j.tasks[0].state='RUNNING',
   j=>j.tasks[0].interactiveInvocation.status='awaiting_decision',
   j=>delete j.tasks[0].interactiveInvocation.decidedAt,
   j=>j.tasks[0].interactiveInvocation.revision='wrong-sha',
   j=>j.tasks[0].interactiveInvocation.executionId='other-exec',
   j=>j.tasks[0].result.data.shortcut.inFlight={},
 ]){const job=fresh();modify(job);assert.equal(shortcutAutoResumeTask(job),null);}
});
test('shared Worker Pool resumes only once while an accepted Review is being processed',async()=>{
 const job=fresh(); let calls=0;let finish;
 const gate=new Promise(resolve=>finish=resolve);
 const pool=new RepositoryWorkerPool(2,()=>{throw Error('normal Reconciler should not dispatch Shortcut')},
   async()=>[{job}],async()=>({job,store:{}}),async (_job,task)=>{calls++;assert.equal(task.id,'content-run');await gate;});
 await pool.reconcile();await pool.reconcile();assert.equal(calls,1);
 job.tasks[0].state='RUNNING';finish();await Promise.resolve();await pool.reconcile();
 assert.equal(calls,1,'claimed Shortcut is never double-launched');
});
test('shared Worker Pool never starts unlaunched or human-waiting Shortcut',async()=>{
 const job=fresh();delete job.shortcutExecutionStartedAt;
 let called=0;const pool=new RepositoryWorkerPool(2,()=>{throw Error('not eligible')},async()=>[{job}],
   async()=>({job,store:{}}),async()=>{called++});
 await pool.reconcile();job.shortcutExecutionStartedAt=new Date().toISOString();job.tasks[0].state='AWAITING_DECISION';
 await pool.reconcile();assert.equal(called,0);
});
test('failed resume is backoff-limited and does not hammer the shared Scheduler',async()=>{
 const job=fresh();let calls=0;
 const pool=new RepositoryWorkerPool(2,()=>{throw Error('should not execute normal Job')},
   async()=>[{job}],async()=>({job,store:{}}),async()=>{calls++;throw Error('backend unavailable');});
 await pool.reconcile();await new Promise(resolve=>setImmediate(resolve));
 await pool.reconcile();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(calls,1,'same invocation cannot repeatedly spawn a broken Runner');
 const last=job.tasks[0].interactiveInvocation;
 last.invocationId='new-invocation';
 await pool.reconcile();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(calls,2,'a new review identity is independently eligible');
});

test('accepted decision bus wake inspects SQLite even when decision was already applied',async()=>{
 const job=fresh();let calls=0;
 const {MemoryEventBus,eventFor}=await import('../dist/events.js');
 const bus=new MemoryEventBus();
 const pool=new RepositoryWorkerPool(2,()=>({applyEvent:async()=>({applied:false,reconcile:false,reason:'duplicate'}),
   reconcile:async()=>job}),async()=>[{job}],async()=>({job,store:{}}),async()=>{calls++;job.tasks[0].state='RUNNING';});
 const stop=await pool.watch(bus);
 await bus.publish(eventFor(job.id,'content-run',null,'task.interactive_decision','running',
   'Human decision already accepted','orchestrator',{}));
 for(let i=0;i<50 && !calls;i++) await new Promise(resolve=>setTimeout(resolve,10));
 await stop();assert.equal(calls,1);
});
