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
 const unsubscribe=await bus.subscribeAll(event=>{observations.push(event.type)});
 const runtime=new Reconciler(store,{owner:'planner-l3',adapters:[],eventBus:bus,maxConcurrent:0,noGitHub:true,projectPathForJob:()=>process.cwd(),planner:{plan:async()=>{
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
  assert.equal(current.plans?.[0]?.status,'SUCCEEDED',JSON.stringify({plan:current.plans?.[0],events:observations}));
  assert.equal(current.plans?.[0]?.attempt,2);
  assert.ok(current.plans?.[0]?.generatedTaskIds?.length>0,'real Plan must record generated Task IDs');
  assert.ok(current.plans[0].generatedTaskIds.every(id=>current.tasks.some(item=>item.id===id)),JSON.stringify({plans:current.plans,tasks:current.tasks}));
  assert.ok(observations.includes('planner.retry'));
  assert.ok(observations.includes('planner.completed'));
  assert.notEqual(current.state,'COMPLETED','Planner success cannot prematurely close unfinished objective');
 }finally{await runtime.close();await unsubscribe();sqlite.close();env.cleanup();}
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
