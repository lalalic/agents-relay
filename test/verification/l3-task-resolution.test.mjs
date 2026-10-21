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

test('L3 classification CLI survives SQLite restart and force-clean replans atomically',async()=>{
 const env=createIsolatedEnvironment('relay-resolution-l3-');
 const stores=join(env.storeDir,'stores');mkdirSync(stores,{recursive:true});
 const jobId='resolution-clean-l3';
 const at=new Date().toISOString();
 const failed={id:'failed-old',jobId,parentTaskId:null,dependencies:[],capabilities:[],adapter:'orchestrator',input:'old implementation',state:'FAILED',attempt:1,maxAttempts:2,leaseOwner:null,leaseExpiresAt:null,executionId:null,executionHistory:[{id:'known-failed-execution',attempt:1,startedAt:at}],threadId:null,result:null,error:'semantic gap',failureReason:'task_failure',timeoutMs:10000,createdAt:at,updatedAt:at,continuation:null,continuationDeliveredAt:null};
 const failedDuringPlan={...failed,id:'failed-during-plan',input:'invalid task contract'};
 const replacement={...failed,id:'replacement',input:'verified replacement',state:'SUCCEEDED',error:null,failureReason:undefined,executionHistory:[]};
 const job={id:jobId,title:'Resolution classification test',objective:'Preserve and classify a failed attempt',repository:'local/isolated',prNumber:0,state:'DRAFT',executionMode:'fixed',autoMerge:false,reviewEnabled:false,continuation:null,createdAt:at,updatedAt:at,tasks:[failed,failedDuringPlan,replacement]};
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
  assert.deepEqual(current.tasks[0].resolutionClassification,{kind:'superseded',targetTaskId:'replacement',evidence:'replacement has verified implementation',reason:'old failed attempt has been replaced',updatedAt:current.tasks[0].resolutionClassification.updatedAt});
  const originalFailure={state:current.tasks[0].state,executionHistory:current.tasks[0].executionHistory,error:current.tasks[0].error};
  const store=new LocalAuthorityDurableStore(sqlite,new InMemoryStore(),undefined,true);
  let runtime;
  runtime=new Reconciler(store,{owner:'resolution-clean-l3',adapters:[],maxConcurrent:0,noGitHub:true,projectPathForJob:()=>process.cwd(),planner:{plan:async context=>{
   const {planId,executionId}=context.planExecution;
   await runtime.applyPlannerTree(jobId,planId,executionId,{objective_status:'satisfied',assessment:'The remaining work is complete; prior failure is classified with durable replacement evidence.',next_tasks:[],unblocks:[]});
   return {objective_status:'satisfied',assessment:'applied by CLI action',next_tasks:[],unblocks:[],cliApplied:true};
  }}});
  try {
   const planned=await runtime.planJob(jobId,undefined,[{taskId:'failed-during-plan',kind:'invalid',targetTaskId:'replacement',evidence:'its declared output contract was malformed',reason:'this historical Task definition is invalid'}]);
   assert.equal(planned.round.status,'SUCCEEDED');
   assert.equal(planned.job.plans.at(-1).id,'plan-1');
   current=await sqlite.loadJob(jobId);
   assert.equal(current.tasks[0].state,originalFailure.state);
   assert.deepEqual(current.tasks[0].executionHistory,originalFailure.executionHistory);
   assert.equal(current.tasks[0].error,originalFailure.error);
   assert.equal(current.tasks[0].resolutionClassification.kind,'superseded');
   assert.equal(current.tasks[1].resolutionClassification.kind,'invalid');
   assert.equal(current.tasks[1].state,'FAILED','clean planning classifies history without claiming Task success');
   assert.equal(current.plans[0].status,'SUCCEEDED');
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
