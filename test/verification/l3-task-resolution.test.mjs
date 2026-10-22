import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync, mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:net';
import {SQLiteRelayStore} from '../../dist/relay-store.js';
import {LocalAuthorityDurableStore} from '../../dist/local-authority-store.js';
import {InMemoryStore} from '../../dist/store.js';
import {Reconciler} from '../../dist/reconciler.js';
import {openLocalManagedStore} from '../../dist/local-managed-store.js';
import {pendingTroubleshooterTasks} from '../../dist/troubleshooter.js';
import {createService} from '../../dist/cli.js';
import {createIsolatedEnvironment} from './harness.mjs';

const execFileAsync=promisify(execFile);
const root=fileURLToPath(new URL('../../',import.meta.url));
const cli=join(root,'dist/cli.js');

test('L3 guarded cleanup and Plan receipt survive SQLite restart',async()=>{
 const env=createIsolatedEnvironment('relay-resolution-l3-');
 const stores=join(env.storeDir,'stores');mkdirSync(stores,{recursive:true});
 const jobId='resolution-clean-l3';
 const at=new Date().toISOString();
 const failed={id:'failed-old',jobId,parentTaskId:null,dependencies:[],capabilities:[],adapter:'orchestrator',input:'old implementation',state:'FAILED',attempt:1,maxAttempts:2,leaseOwner:null,leaseExpiresAt:null,executionId:null,executionHistory:[{id:'known-failed-execution',attempt:1,startedAt:at}],threadId:null,result:null,error:'semantic gap',failureReason:'task_failure',timeoutMs:10000,createdAt:at,updatedAt:at,continuation:null,continuationDeliveredAt:null};
 const failedDuringPlan={...failed,id:'failed-during-plan',input:'invalid task contract'};
 const failedReview={...failed,id:'failed-review',agentName:'reviewer',reviewHeadSha:'old-head',input:'stale review'};
 const replacement={...failed,id:'replacement',input:'verified replacement',state:'SUCCEEDED',error:null,failureReason:undefined,executionHistory:[]};
 const job={id:jobId,title:'Resolution classification test',objective:'Preserve and classify a failed attempt',repository:'local/isolated',prNumber:0,state:'DRAFT',executionMode:'fixed',autoMerge:false,reviewEnabled:false,continuation:null,createdAt:at,updatedAt:at,tasks:[failed,failedDuringPlan,failedReview,replacement]};
 let sqlite=openLocalManagedStore('local/isolated',0,{directory:stores,noGitHub:true,jobId}).relay; await sqlite.saveJob(job); sqlite.close();
 let service;
 const priorStore=process.env.AGENTS_RELAY_STORE_DIR, priorNoGithub=process.env.AGENTS_RELAY_NO_GITHUB;
 try {
  process.env.AGENTS_RELAY_STORE_DIR=stores; process.env.AGENTS_RELAY_NO_GITHUB='1';
  const probe=createServer(); await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve)); const port=probe.address().port; await new Promise(resolve=>probe.close(resolve));
  service=await createService(['--no-github','--events','none','--repo','local/isolated','--id',jobId,'--store-dir',stores,'--port',String(port),'--interval','600000','--refresh-ms','600000']);
  const args=[cli,'task','classify','--repo','local/isolated','--id',jobId,'--task-id','failed-old','--classification','superseded','--target-task-id','replacement','--evidence','replacement has verified implementation','--reason','old failed attempt has been replaced','--host','127.0.0.1','--port',String(port),'--events','none','--no-github'];
  const cliResult=await execFileAsync(process.execPath,args,{cwd:root,timeout:12000,env:{...process.env,AGENTS_RELAY_STORE_DIR:stores,AGENTS_RELAY_NO_GITHUB:'1'}});
  const output=JSON.parse(cliResult.stdout);
  assert.equal(output.state,'FAILED','classification is not a lifecycle transition');
  assert.equal(output.resolutionClassification.kind,'superseded');
  const generatedTroubleshooter=pendingTroubleshooterTasks({...job,state:'ACTIVE'})[0];
  assert.equal(generatedTroubleshooter.title,'Troubleshoot');
  assert.equal(generatedTroubleshooter.parentTaskId,'failed-old');
  const dashboard=await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(dashboard.status,200);
  assert.match(await dashboard.text(),/Resolution evidence/);
  await service.stop(); service=undefined;
  sqlite=openLocalManagedStore('local/isolated',0,{directory:stores,noGitHub:true,jobId}).relay;
  let current=await sqlite.loadJob(jobId);
  service=await createService(['--no-github','--events','none','--repo','local/isolated','--id',jobId,'--store-dir',stores,'--port',String(port),'--interval','600000','--refresh-ms','600000']);
  assert.deepEqual(current.tasks[0].resolutionClassification,{kind:'superseded',targetTaskId:'replacement',evidence:'replacement has verified implementation',reason:'old failed attempt has been replaced',updatedAt:current.tasks[0].resolutionClassification.updatedAt});
  const originalFailure={state:current.tasks[0].state,executionHistory:current.tasks[0].executionHistory,error:current.tasks[0].error};
  const store=new LocalAuthorityDurableStore(sqlite,new InMemoryStore(),undefined,true);
  let runtime;
  runtime=new Reconciler(store,{owner:'resolution-clean-l3',adapters:[],maxConcurrent:0,noGitHub:true,projectPathForJob:()=>process.cwd(),planner:{plan:async context=>{
   const {planId,executionId}=context.planExecution;
   assert.equal(context.forceRestate,true);
   assert.deepEqual(context.restateTaskIds,['failed-during-plan','failed-review']);
   const classifyArgs=[cli,'task','classify','--repo','local/isolated','--id',jobId,'--task-id','failed-during-plan','--classification','invalid','--target-task-id','replacement','--evidence','its declared output contract was malformed','--reason','the failed task definition cannot produce the required output','--host','127.0.0.1','--port',String(port),'--events','none','--no-github'];
   await execFileAsync(process.execPath,classifyArgs,{cwd:root,timeout:12000,env:{...process.env,AGENTS_RELAY_STORE_DIR:stores,AGENTS_RELAY_NO_GITHUB:'1'}});
   const cancelArgs=[cli,'task','cancel','--repo','local/isolated','--id',jobId,'--task-id','failed-review','--host','127.0.0.1','--port',String(port),'--events','none','--no-github'];
   await execFileAsync(process.execPath,cancelArgs,{cwd:root,timeout:12000,env:{...process.env,AGENTS_RELAY_STORE_DIR:stores,AGENTS_RELAY_NO_GITHUB:'1'}});
   const proposal={objective_status:'satisfied',assessment:'Prior failed work was classified or the obsolete failed review cancelled with durable evidence; no Task was marked successful.',next_tasks:[],unblocks:[],history_cleanup:[{taskId:'failed-during-plan',outcome:'invalid',targetTaskId:'replacement',evidence:'its declared output contract was malformed',reason:'the failed task definition cannot produce the required output'},{taskId:'failed-review',outcome:'cancelled_review',evidence:'the review was tied to an obsolete artifact version',reason:'the review target is stale and no longer actionable'}]};
   await runtime.applyPlannerTree(jobId,planId,executionId,proposal);
   return {objective_status:'satisfied',assessment:'applied by CLI action',next_tasks:[],unblocks:[],history_cleanup:proposal.history_cleanup,cliApplied:true};
  }}});
  try {
   await assert.rejects(runtime.planJob(jobId,undefined,true),/Force Restate validation failed after durable Plan apply and reconciliation/);
   current=await sqlite.loadJob(jobId);
   assert.equal(current.tasks[0].state,originalFailure.state);
   assert.deepEqual(current.tasks[0].executionHistory,originalFailure.executionHistory);
   assert.equal(current.tasks[0].error,originalFailure.error);
   assert.equal(current.tasks[0].resolutionClassification.kind,'superseded');
   assert.equal(current.tasks[1].resolutionClassification.kind,'invalid');
   assert.equal(current.tasks[1].state,'FAILED','clean planning classifies history without claiming Task success');
   assert.equal(current.tasks[2].state,'CANCELLED','the guarded task command cancels failed review work');
   assert.equal(current.plans[0].status,'FAILED','invalid convergence is durably failed');
   assert.match(current.plans[0].error,/Force Restate validation failed/);
   const recovery=current.tasks.find(task=>task.agentName==='troubleshooter'&&task.recoveryPlanId===current.plans[0].id);
   assert.ok(recovery,'Planner Orchestration creates durable recovery after rejection');
   const recoveryId=recovery.id;
   await runtime.reconcile(jobId);
   current=await sqlite.loadJob(jobId);
   assert.equal(current.tasks.filter(task=>task.recoveryPlanId===current.plans[0].id).length,1,'reconciliation reuses the same recovery after replay');
   assert.equal(current.tasks.find(task=>task.recoveryPlanId===current.plans[0].id).id,recoveryId);
   await service.stop();service=undefined;sqlite.close();
   sqlite=openLocalManagedStore('local/isolated',0,{directory:stores,noGitHub:true,jobId}).relay;
   current=await sqlite.loadJob(jobId);
   assert.equal(current.plans[0].forceRestate,true,'force mode survives SQLite restart');
   assert.deepEqual(current.plans[0].plannerResult.history_cleanup,[{taskId:'failed-during-plan',outcome:'invalid',targetTaskId:'replacement',evidence:'its declared output contract was malformed',reason:'the failed task definition cannot produce the required output'},{taskId:'failed-review',outcome:'cancelled_review',evidence:'the review was tied to an obsolete artifact version',reason:'the review target is stale and no longer actionable'}]);
  } finally {await runtime.close();}
  sqlite.close();
 } finally {
  await service?.stop();
  try{sqlite.close();}catch{}
  if(priorStore===undefined)delete process.env.AGENTS_RELAY_STORE_DIR;else process.env.AGENTS_RELAY_STORE_DIR=priorStore;
  if(priorNoGithub===undefined)delete process.env.AGENTS_RELAY_NO_GITHUB;else process.env.AGENTS_RELAY_NO_GITHUB=priorNoGithub;
  env.cleanup();
 }
});

test('force-restate rejects an unproved unknown outcome without changing FAILED history',async()=>{
 const env=createIsolatedEnvironment('relay-force-clean-negative-');
 const jobId='force-clean-negative-l3',at=new Date().toISOString();
 const failed={id:'unknown-failure',jobId,parentTaskId:null,dependencies:[],capabilities:[],input:'uncertain attempt',state:'FAILED',attempt:1,maxAttempts:2,leaseOwner:null,leaseExpiresAt:null,executionId:null,executionHistory:[{id:'unknown-execution',attempt:1,startedAt:at}],threadId:null,result:null,error:'worker exited without a terminal event',failureReason:'worker_outcome_unknown',timeoutMs:10000,createdAt:at,updatedAt:at,continuation:null,continuationDeliveredAt:null};
 const target={...failed,id:'target',state:'SUCCEEDED',failureReason:undefined,error:null,executionHistory:[]};
 const job={id:jobId,title:'Force cleanup negative',objective:'Keep unknown outcome unresolved',repository:'local/isolated',prNumber:0,state:'ACTIVE',executionMode:'fixed',autoMerge:false,reviewEnabled:false,createdAt:at,updatedAt:at,tasks:[failed,target],plans:[]};
 const sqlite=new SQLiteRelayStore(join(env.storeDir,'relay.sqlite'),jobId);const store=new LocalAuthorityDurableStore(sqlite,new InMemoryStore(),undefined,true);await store.saveJob(job);
 const runtime=new Reconciler(store,{owner:'force-clean-negative',adapters:[],maxConcurrent:0,noGitHub:true,projectPathForJob:()=>process.cwd(),planner:{plan:async context=>({objective_status:'satisfied',assessment:'claimed classification without proof',next_tasks:[],history_cleanup:[{taskId:'unknown-failure',outcome:'superseded',targetTaskId:'target',evidence:'worker exited without a terminal event',reason:'claimed replaced'}]})}});
 try{
  await assert.rejects(runtime.planJob(jobId,undefined,true),/Unknown execution outcome for unknown-failure must remain unresolved/);
  const current=await sqlite.loadJob(jobId);
  assert.equal(current.tasks[0].state,'FAILED');assert.equal(current.tasks[0].resolutionClassification,undefined);
  assert.equal(current.plans[0].status,'FAILED','invalid Planner claim fails its round without a fake success');
 }finally{await runtime.close();sqlite.close();env.cleanup();}
});

test('legacy forceCleanHistory Plan state is safely read as forceRestate and rewritten on mutation',async()=>{
 const env=createIsolatedEnvironment('relay-force-restate-migration-');
 const dbPath=join(env.storeDir,'relay.sqlite');
 const sqlite=new SQLiteRelayStore(dbPath,'legacy-restate');
 const at=new Date().toISOString();
 const legacy={id:'legacy-restate',title:'Migration',repository:'local/isolated',prNumber:0,state:'ACTIVE',executionMode:'fixed',createdAt:at,updatedAt:at,tasks:[],plans:[{jobId:'legacy-restate',id:'plan-1',round:1,source:'model-planner',previousPlanId:null,trigger:{source:'manual'},status:'SUCCEEDED',assessment:'old',generatedTaskIds:[],forceCleanHistory:true,cleanHistoryTaskIds:['old-failed'],createdAt:at,updatedAt:at}]};
 await sqlite.createJobIfAbsent(legacy);
 const loaded=await sqlite.loadJob('legacy-restate');
 assert.equal(loaded.plans[0].forceRestate,true);assert.deepEqual(loaded.plans[0].restateTaskIds,['old-failed']);
 assert.equal('forceCleanHistory' in loaded.plans[0],false);
 const updated=await sqlite.mutateJob('legacy-restate',current=>current);
 assert.equal(updated.plans[0].forceRestate,true);assert.equal('forceCleanHistory' in updated.plans[0],false);
 sqlite.close();env.cleanup();
});
