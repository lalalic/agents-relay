import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {SQLiteRelayStore} from '../../dist/relay-store.js';
import {LocalAuthorityDurableStore} from '../../dist/local-authority-store.js';
import {InMemoryStore} from '../../dist/store.js';
import {MemoryEventBus} from '../../dist/events.js';
import {Reconciler} from '../../dist/reconciler.js';
import {createIsolatedEnvironment} from './harness.mjs';

test('real Planner Plan round failure retries into committed child under isolated SQLite',async()=>{
 const env=createIsolatedEnvironment('relay-planner-round-');
 const jobId='planner-l3';
 const timestamp=new Date().toISOString();
 const plan={jobId,id:'plan-1',round:1,source:'model-planner',previousPlanId:null,trigger:{source:'initial'},status:'PLANNING',assessment:'Planning in progress.',generatedTaskIds:[],attempt:0,maxAttempts:2,manualPlanning:false,leaseOwner:null,leaseExpiresAt:null,executionId:null,timeoutMs:10000,createdAt:timestamp,updatedAt:timestamp};
 const job={id:jobId,title:'Planner recovery',objective:'Implement and verify a small change',repository:'local/isolated',prNumber:0,state:'ACTIVE',executionMode:'autonomous',autoMerge:false,reviewEnabled:false,createdAt:timestamp,updatedAt:timestamp,plans:[plan],tasks:[]};
 const sqlite=new SQLiteRelayStore(join(env.storeDir,'relay.sqlite'),jobId);
 const store=new LocalAuthorityDurableStore(sqlite,new InMemoryStore(),undefined,true);
 const bus=new MemoryEventBus();
 let attempts=0;
 const observations=[];
 const failures=[];
 const unsubscribe=await bus.subscribeAll(event=>{observations.push(event.type)});
 const runtime=new Reconciler(store,{owner:'planner-l3',adapters:[{name:'codex',id:'planner-l3-worker',capabilities:['model']}],eventBus:bus,maxConcurrent:0,noGitHub:true,emit:async event=>{if(event.type==='runtime.persistence.failed')failures.push(event.message);},projectPathForJob:()=>process.cwd(),planner:{plan:async()=>{
  attempts++;
  if(attempts===1)throw Error('Injected transient Planner provider failure');
  return {objective_status:'satisfied',assessment:'Work required before objective is fulfilled',
  next_tasks:[{id:'implementation',title:'Implement and verify isolated test fixture',input:'Verify fixture and report exact result.',agentName:'implementation',output:{kind:'task_pr'},storySize:'S'}],unblocks:[]};
 }}});
 try{
  await store.saveJob(job);
  for(let i=0;i<30;i++){
   await runtime.reconcile(jobId);
   await new Promise(resolve=>setTimeout(resolve,20));
   const latest=await sqlite.loadJob(jobId);
   if(latest.plans?.[0]?.status==='SUCCEEDED')break;
  }
  const current=await sqlite.loadJob(jobId);
  assert.equal(attempts,2,JSON.stringify({attempts,plan:current.plans?.[0],events:observations}));
  assert.equal(current.plans?.[0]?.status,'SUCCEEDED',JSON.stringify({plan:current.plans?.[0],events:observations,failures}));
  assert.equal(current.plans?.[0]?.attempt,2);
  assert.ok(current.plans?.[0]?.generatedTaskIds?.length>0,'real Plan must record generated Task IDs');
  assert.ok(current.plans[0].generatedTaskIds.every(id=>current.tasks.some(item=>item.id===id)),JSON.stringify({plans:current.plans,tasks:current.tasks}));
  assert.ok(observations.includes('planner.retry'));
  assert.ok(observations.includes('planner.completed'));
  assert.notEqual(current.state,'COMPLETED','Planner success cannot prematurely close unfinished objective');
 }finally{await runtime.close();await unsubscribe();sqlite.close();env.cleanup();}
});

test('SQLite reconcile preserves historical Plan child and reopens the same Troubleshooter for attempt 3',async()=>{
 const env=createIsolatedEnvironment('relay-planner-child-recovery-');
 const jobId='planner-child-recovery-l3';
 const timestamp=new Date().toISOString();
 const task=(id,state,extra={})=>({jobId,id,kind:'work',priority:'P1',storySize:'S',projectName:'Job 473',
  parentTaskId:null,dependencies:[],capabilities:[],adapter:'codex',input:id,output:{kind:'task_pr'},state,
  attempt:0,maxAttempts:3,leaseOwner:null,leaseExpiresAt:null,executionId:null,threadId:null,result:null,
  plannerResult:null,error:null,timeoutMs:10000,createdAt:timestamp,updatedAt:timestamp,
  continuation:null,continuationDeliveredAt:null,...extra});
 const original=task('original','FAILED',{attempt:3,error:'original attempt 3 failed'});
 const dependencyTarget=task('dependency-target','CANCELLED');
 const historicalResolution={path:'same_job_dependency',targetTaskId:'dependency-target',rootCause:'Historical dependency',solution:'Wait for target'};
 const child=task('planned-child','FAILED',{attempt:2,result:'historical child result',error:'historical child failure',
  resolution:{...historicalResolution,state:'active',owner:'planner',updatedAt:timestamp}});
 const recovery=task('troubleshoot-original','SUCCEEDED',{agentName:'troubleshooter',parentTaskId:'original',
  recoveryForAttempt:2,attempt:1,maxAttempts:3,input:'old successful recovery'});
 const plan={jobId,id:'plan-1',round:1,source:'model-planner',previousPlanId:null,trigger:{source:'initial'},status:'SUCCEEDED',
  generatedTaskIds:[child.id],assessment:'Continue work.',createdAt:timestamp,updatedAt:timestamp,
  plannerResult:{objective_status:'in_progress',assessment:'Continue work.',next_tasks:[{id:child.id,title:'Planned work',
   input:child.input,output:child.output,storySize:'S',resolution:historicalResolution}],unblocks:[]}};
 const job={id:jobId,title:'Job 473 recovery',objective:'Recover failed work and preserve historical execution evidence',
  repository:'local/isolated',prNumber:0,state:'ACTIVE',executionMode:'autonomous',autoMerge:false,reviewEnabled:false,
  createdAt:timestamp,updatedAt:timestamp,plans:[plan],tasks:[original,dependencyTarget,child,recovery]};
 const sqlite=new SQLiteRelayStore(join(env.storeDir,'relay.sqlite'),jobId);
 const store=new LocalAuthorityDurableStore(sqlite,new InMemoryStore(),undefined,true);
 const runtime=new Reconciler(store,{owner:'planner-child-recovery-l3',adapters:[],eventBus:new MemoryEventBus(),
  maxConcurrent:0,noGitHub:true,projectPathForJob:()=>process.cwd()});
 try{
  await store.saveJob(job);
  await runtime.reconcile(jobId);
  const current=await sqlite.loadJob(jobId);
  assert.equal(current.tasks.filter(item=>item.id===child.id).length,1);
  const persistedChild=current.tasks.find(item=>item.id===child.id);
  assert.equal(persistedChild.attempt,2);
  assert.equal(persistedChild.result,'historical child result');
  assert.equal(persistedChild.error,'historical child failure');
  assert.equal(persistedChild.resolution.targetTaskId,'dependency-target');
  assert.equal(current.tasks.filter(item=>item.agentName==='troubleshooter'&&item.parentTaskId==='original').length,1);
  const reopened=current.tasks.find(item=>item.id===recovery.id);
  assert.equal(reopened.state,'QUEUED');
  assert.equal(reopened.recoveryForAttempt,3);
  assert.match(reopened.input,/original attempt 3 failed/);
 }finally{await runtime.close();sqlite.close();env.cleanup();}
});


test('real Planner round retries, then Worker and Reviewer faults recover, Review fix, merge retry, objective verified in SQLite',async()=>{
 const {runReplay}=await import('./l3-replay.mjs');
 const {plannerCombinedScenario}=await import('./l3-planner-combined.mjs');
 const result=await runReplay(plannerCombinedScenario);
 assert.equal(result.outcome,'PASS',result.errors.join('; '));
 assert.equal(result.plannerCalls,2);
 assert.equal(result.actual.plans[0].attempt,2);
 assert.equal(result.actual.plans[0].status,'SUCCEEDED');
 assert.equal(result.actual.jobState,'COMPLETED');
 assert.equal(result.externalGitAttempts,2);
 assert.ok(result.trace[0].planStatuses[0].generatedTaskIds.length>0);
 assert.equal(result.trace[0].jobState,'ACTIVE','successful Plan cannot mean fulfilled Objective');
 assert.ok(result.trace.some(x=>x.event==='task.failed'&&x.after.some(t=>t.id.startsWith('troubleshoot-'))));
 assert.ok(result.trace.some(x=>x.event==='review.changes_required'));
 assert.ok(result.trace.some(x=>x.event==='review.approved'));
 assert.ok(result.observedEvents.some(x=>x.event==='planner.retry'));
 assert.ok(result.observedEvents.some(x=>x.event==='planner.completed'));
 assert.ok(result.observedEvents.some(x=>x.event==='job.merge.failed'));
 assert.ok(result.observedEvents.some(x=>x.event==='job.merge.succeeded'));
});

test('terminal FAILED Plan is recovered through Graph-authorized Troubleshooter events before original objective converges',async()=>{
 const {runReplay}=await import('./l3-replay.mjs');
 const {terminalPlannerCombinedScenario}=await import('./l3-planner-terminal-combined.mjs');
 const result=await runReplay(terminalPlannerCombinedScenario);
 assert.equal(result.outcome,'PASS',result.errors.join('; '));
 assert.equal(result.plannerCalls,2);
 assert.equal(result.actual.plans[0].status,'FAILED');
 assert.equal(result.actual.plans[0].attempt,1);
 assert.equal(result.actual.plans[1].status,'SUCCEEDED');
 assert.equal(result.actual.jobState,'COMPLETED');
 assert.equal(result.externalGitAttempts,2);
 assert.equal(result.trace[0].jobState,'ACTIVE');
 assert.equal(result.trace[0].planStatuses[0].status,'FAILED');
 assert.ok(result.trace[1].after.some(t=>t.id==='recover-plan-1'&&t.state==='QUEUED'));
 assert.ok(result.trace[4].after.some(t=>t.id==='recover-plan-1'&&t.state==='SUCCEEDED'));
 assert.ok(result.trace[5].planStatuses.some(p=>p.id==='plan-2'&&p.status==='SUCCEEDED'));
 assert.ok(result.observedEvents.some(e=>e.event==='planner.failed'));
 assert.ok(result.observedEvents.some(e=>e.event==='planner.completed'));
 assert.ok(result.observedEvents.some(e=>e.event==='job.merge.failed'));
 assert.ok(result.observedEvents.some(e=>e.event==='job.merge.succeeded'));
 assert.equal(result.actionTraces.every(e=>e.outcome==='Verified'),true);
});

test('terminal FAILED Plan cannot be recovered by unverified Troubleshooter claim',async()=>{
 const {runReplay}=await import('./l3-replay.mjs');
 const {terminalPlannerCombinedScenario}=await import('./l3-planner-terminal-combined.mjs');
 const scenario={...terminalPlannerCombinedScenario,id:'planner-recovery-unverified',
  steps:[
   {type:'planner.settle',expectStatus:'FAILED'},
   {type:'reconcile'},
   {type:'mock.claim',taskId:'recover-plan-1',executionId:'unverified-recovery'},
   {type:'task.started',taskId:'recover-plan-1',executionId:'unverified-recovery'},
   {type:'task.completed',taskId:'recover-plan-1',executionId:'unverified-recovery',data:{verified:false,evidence:'No actual repair'}},
   {type:'restart'},{type:'reconcile'},
  ],
  expected:{jobState:'ACTIVE',plans:{'plan-1':'FAILED'}}};
 const result=await runReplay(scenario);
 assert.equal(result.outcome,'PASS',result.errors.join('; '));
 assert.equal(result.actual.plans.length,1,'fabricated completion cannot start replacement Plan');
 assert.equal(result.actual.tasks['recover-plan-1'],'SUCCEEDED');
 assert.equal(result.plannerCalls,1);
});

test('Plan-specific Troubleshooter human escalation retains failed Plan, notification receipt and authoritative recovery',async()=>{
 const {runReplay}=await import('./l3-replay.mjs');
 const {terminalPlannerCombinedScenario}=await import('./l3-planner-terminal-combined.mjs');
 const scenario={...terminalPlannerCombinedScenario,id:'planner-human-escalation-recovery',
  steps:[
   {type:'planner.settle',expectStatus:'FAILED'},
   {type:'reconcile'},
   {type:'task.escalate',taskId:'plan-1',recoveryTaskId:'recover-plan-1'},
   {type:'restart'},{type:'reconcile'},
   {type:'mock.notification.delivered',taskId:'plan-1',recoveryTaskId:'recover-plan-1'},
   {type:'human.unblock',taskId:'plan-1',recoveryTaskId:'recover-plan-1',response:'Provider authorization verified'},
   {type:'mock.claim',taskId:'recover-plan-1',executionId:'plan-escalation-recovery'},
   {type:'task.started',taskId:'recover-plan-1',executionId:'plan-escalation-recovery'},
   {type:'task.completed',taskId:'recover-plan-1',executionId:'plan-escalation-recovery',
    data:{verified:true,evidence:'Model connection tested and recovered after human authorization'}},
   {type:'planner.await-success'},
  ],
  expected:{jobState:'ACTIVE',plans:{'plan-1':'FAILED','plan-2':'SUCCEEDED'}}};
 const result=await runReplay(scenario);
 assert.equal(result.outcome,'PASS',result.errors.join('; '));
 assert.equal(result.trace[2].escalations[0]?.notificationStatus,'pending');
 assert.equal(result.trace[3].planStatuses[0]?.status,'FAILED');
 assert.equal(result.trace[4].escalations[0]?.notificationStatus,'pending');
 assert.equal(result.trace[5].escalations[0]?.notificationStatus,'delivered');
 assert.equal(result.trace[6].escalations[0]?.status,'responded');
 assert.equal(result.actual.plans[0]?.status,'FAILED');
 assert.equal(result.actual.plans[1]?.status,'SUCCEEDED');
 assert.equal(result.actual.jobState,'ACTIVE');
 assert.equal(result.observedEvents.filter(e=>e.event==='escalation.requested').length,1);
});

// L3 deterministic production-ingress sequence: Plan A -> Task A -> Plan B -> Task B -> satisfied -> Review.
test('L3 objective-only Job replans through two completed Tasks and restarts before final Review', async () => {
 const {runReplay}=await import('./l3-replay.mjs');
 const result=await runReplay({
  id:'objective-only-sequential-plan',reviewEnabled:true,autoMerge:true,headSha:'head-1',mergeOutcomes:['succeeded'],tasks:[],
  plannerScript:{results:[
   {objective_status:'in_progress',assessment:'First implement A',next_tasks:[{id:'a',title:'Implement and verify stage A outcome',input:'Implement and verify stage A',output:{kind:'task_pr'},storySize:'S'}],unblocks:[]},
   {objective_status:'in_progress',assessment:'Next implement B',next_tasks:[{id:'b',title:'Implement and verify stage B outcome',input:'Implement and verify stage B',output:{kind:'task_pr'},storySize:'S'}],unblocks:[]},
   {objective_status:'satisfied',assessment:'Both results verified',next_tasks:[],unblocks:[]},
  ]},
  steps:[
   {type:'planner.settle'},
   {type:'mock.claim',taskId:'@planned',executionId:'task-a'},
   {type:'task.started',taskId:'@planned',executionId:'task-a'},
   {type:'task.completed',taskId:'@planned',executionId:'task-a'},
   {type:'restart'},
   {type:'planner.await-success',planId:'plan-2'},
   {type:'mock.claim',taskId:'@planned',executionId:'task-b'},
   {type:'task.started',taskId:'@planned',executionId:'task-b'},
   {type:'task.completed',taskId:'@planned',executionId:'task-b'},
   {type:'planner.await-success',planId:'plan-3'},
   {type:'mock.claim',taskId:'@review',executionId:'review'},
   {type:'review.started',taskId:'@review',executionId:'review',data:{head_sha:'head-1'}},
   {type:'review.approved',taskId:'@review',executionId:'review',data:{head_sha:'head-1'}},
   {type:'reconcile'},
  ],
  expected:{jobState:'COMPLETED',plans:{'plan-1':'SUCCEEDED','plan-2':'SUCCEEDED','plan-3':'SUCCEEDED'},localMergeStatus:'succeeded'},
 });
 assert.equal(result.outcome,'PASS',result.errors.join('; '));
 assert.equal(result.plannerCalls,3);
 assert.equal(result.actual.plans.length,3,'each round has one durable identity');
 assert.deepEqual(result.actual.plans.map(plan=>plan.objectiveStatus),['in_progress','in_progress','satisfied']);
 assert.ok(result.trace.some(step=>step.event==='restart'));
 assert.equal(result.actual.jobState,'COMPLETED');
});
