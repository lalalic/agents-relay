import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import {SQLiteRelayStore} from '../../dist/relay-store.js';
import {dispatchTaskLifecycleSync} from '../../dist/workflow/lifecycle.js';
const exe=resolve(import.meta.dirname,'../target/debug/agents-relay-rust');
const stamp='2026-11-13T20:00:00.000Z';
const observed='2026-11-13T20:01:00.000Z';
function recovery(db,active='inactive',time=observed){
 const response=spawnSync(exe,['scheduler','recovery','--db',db,'--job-id','91','--task-id','101','--now',time,'--owner-activity',active],{encoding:'utf8'});
 assert.equal(response.status,0,response.stderr);return JSON.parse(response.stdout);
}
test('Rust recovery inspection agrees with canonical TS Task Graph, never marks unverified worker succeeded',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-rust-recovery-'));
 const db=join(dir,'relay.sqlite');let store;
 try{
  store=new SQLiteRelayStore(db);
  const task={jobId:'91',id:'101',parentTaskId:null,dependencies:[],capabilities:[],adapter:'script',input:'work',
   state:'RUNNING',attempt:1,maxAttempts:3,leaseOwner:'relayd-test',leaseExpiresAt:stamp,
   executionId:'ex1',threadId:null,result:null,error:null,timeoutMs:120000,createdAt:stamp,updatedAt:stamp,
   continuation:null,continuationDeliveredAt:null,executionHistory:[{id:'ex1',attempt:1,startedAt:stamp}]};
  await store.saveJob({id:'91',title:'Recovery inspection',repository:'example',projectRoot:dir,prNumber:0,
   state:'ACTIVE',reviewEnabled:false,continuation:null,createdAt:stamp,updatedAt:stamp,tasks:[task]});
  await store.recordExecutionProcess({jobId:'91',taskId:'101',executionId:'ex1',leaseOwner:'relayd-test',
   host:execFileSync('/bin/hostname',{encoding:'utf8'}).trim(),pid:2147483000,pgid:2147483000,startToken:'unused',observedAt:stamp});
  await store.finishExecutionProcess('91','101','ex1',stamp);
  store.close();store=null;
  const result=recovery(db);
  assert.equal(result.processProbe,'gone');
  assert.equal(result.assessment.status,'eligible');
  const observedDecision=dispatchTaskLifecycleSync({...task},'lease.expired',{retryAvailable:true});
  assert.equal(observedDecision.accepted,true);
  assert.equal(result.assessment.target,observedDecision.target);
  assert.deepEqual(result.assessment.actions.map(a=>a.id),observedDecision.actions);
  assert.equal(result.assessment.target,'FAILED');
  assert.equal(recovery(db,'active').assessment.status,'blocked');
  assert.equal(recovery(db,'inactive','2026-11-13T19:00:00.000Z').assessment,null);
  store=new SQLiteRelayStore(db);
  assert.equal((await store.loadJob('91')).tasks[0].state,'RUNNING',
   'inspection never mutates production-like authoritative SQLite state');
  console.log('Recovery parity: exact Process probe -> Graph failure plan -> TS transition actions; no state mutation');
 }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});
