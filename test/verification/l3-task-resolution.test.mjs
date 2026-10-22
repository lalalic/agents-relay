import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {SQLiteRelayStore} from '../../dist/relay-store.js';
import {LocalAuthorityDurableStore} from '../../dist/local-authority-store.js';
import {InMemoryStore} from '../../dist/store.js';
import {Reconciler} from '../../dist/reconciler.js';
import {createIsolatedEnvironment} from './harness.mjs';

test('force-restate rejects an unproved unknown outcome without changing FAILED history',async()=>{
 const env=createIsolatedEnvironment('relay-force-clean-negative-');
 const jobId='force-clean-negative-l3',at=new Date().toISOString();
 const failed={id:'unknown-failure',jobId,parentTaskId:null,dependencies:[],capabilities:[],input:'uncertain attempt',state:'FAILED',attempt:1,maxAttempts:2,leaseOwner:null,leaseExpiresAt:null,executionId:null,executionHistory:[{id:'unknown-execution',attempt:1,startedAt:at}],threadId:null,result:null,error:'worker exited without a terminal event',failureReason:'worker_outcome_unknown',timeoutMs:10000,createdAt:at,updatedAt:at,continuation:null,continuationDeliveredAt:null};
 const target={...failed,id:'target',state:'SUCCEEDED',failureReason:undefined,error:null,executionHistory:[]};
 const job={id:jobId,title:'Force cleanup negative',objective:'Keep unknown outcome unresolved',repository:'local/isolated',prNumber:0,state:'ACTIVE',executionMode:'fixed',autoMerge:false,reviewEnabled:false,createdAt:at,updatedAt:at,tasks:[failed,target],plans:[]};
 const sqlite=new SQLiteRelayStore(join(env.storeDir,'relay.sqlite'),jobId);const store=new LocalAuthorityDurableStore(sqlite,new InMemoryStore(),undefined,true);await store.saveJob(job);
 const runtime=new Reconciler(store,{owner:'force-clean-negative',adapters:[],maxConcurrent:0,noGitHub:true,projectPathForJob:()=>process.cwd(),planner:{plan:async context=>({objective_status:'satisfied',assessment:'claimed classification without proof',next_tasks:[],history_cleanup:[{taskId:'unknown-failure',outcome:'superseded',targetTaskId:'target',evidence:'worker exited without a terminal event',reason:'claimed replaced'}]})}});
 try{
  await assert.rejects(runtime.planJob(jobId,undefined,true),/unknown execution outcome\. Keep it unresolved/);
  const current=await sqlite.loadJob(jobId);
  assert.equal(current.tasks[0].state,'FAILED');assert.equal(current.tasks[0].resolutionClassification,undefined);
  assert.equal(current.plans[0].status,'PLANNING','failed Plan Apply preserves the active execution for a corrected retry');
  assert.equal(current.plans[0].executionId !== null, true);
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
