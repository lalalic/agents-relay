import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {SQLiteRelayStore} from '../../dist/relay-store.js';
import {DatabaseSync} from 'node:sqlite';
const bin=resolve(import.meta.dirname,'../target/debug/examples/native_scheduler_fixture');
const t0='2026-11-13T20:00:00.000Z';
async function fixture(mode){
 const dir=mkdtempSync(join(tmpdir(),'relay-rust-authority-'));
 const db=join(dir,'relay.sqlite');
 writeFileSync(join(dir,'.relay-rust-authority-isolated-test'),'test-only');
 let store;
 try{
  store=new SQLiteRelayStore(db);
  await store.saveJob({id:'91',title:'native-script-fixture',repository:'isolated',projectRoot:dir,
   state:'ACTIVE',prNumber:0,createdAt:t0,updatedAt:t0,reviewEnabled:true,
   tasks:[{jobId:'91',id:'101',title:'Script Worker',kind:'work',parentTaskId:null,dependencies:[],
    adapter:'script',capabilities:['script'],input:'Fixture work',state:'QUEUED',
    attempt:0,maxAttempts:3,leaseOwner:null,leaseExpiresAt:null,executionId:null,threadId:null,
    error:null,result:null,timeoutMs:15000,createdAt:t0,updatedAt:t0}]});
  store.close();store=null;
  const result=spawnSync(bin,[db,mode],{encoding:'utf8',timeout:9000,
   env:{...process.env,RELAY_RUST_EXPERIMENTAL_TEST_ONLY:'isolated-test'}});
  assert.equal(result.status,0,result.stderr);
  const output=JSON.parse(result.stdout);
  store=new SQLiteRelayStore(db);
  const job=await store.loadJob('91');
  assert.equal(job.tasks.length,1);
  assert.equal(job.tasks[0].state,mode==='complete'?'SUCCEEDED':'FAILED');
  assert.equal(job.state,'ACTIVE','Review must not be bypassed by Script completion');
  assert.equal(output.report.taskState,job.tasks[0].state);
  assert.equal(output.report.worker.exitCode,0);
  assert.equal(output.report.verified,mode==='complete');
  assert.equal(output.attempt.outcome,'Verified','launch postcondition differs from Task completion');
  assert.equal(output.events.length,1);
  assert.equal(output.events[0].eventId,mode==='complete'?'task.completed':'task.failed');
  assert.ok(output.process.endedAt,'physical Worker process must end');
  assert.equal(readFileSync(join(dir,'native.stdout'),'utf8').length>0,true);
  const sqlite=new DatabaseSync(db);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM workflow_action_trace').get().n,1);
  sqlite.close();
  if(mode==='complete'){
   assert.equal(job.tasks[0].result.data.status,'COMPLETED');
   assert.deepEqual(job.tasks[0].result.data.output,{artifact:'verified'});
  }else{
   assert.equal(job.tasks[0].result,null,'exit-zero/forged output must not produce success result');
   assert.match(job.tasks[0].error,/evidence|execution identity/,
    'failed Task keeps durable diagnostic reason for Troubleshooter');
  }
  console.log('Native Script physical E2E',mode,job.tasks[0].state,output.report.worker.pid);
 }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
}
test('native Script: claim -> real PID -> verified evidence -> graph-completed Task, still requires Final Review',async()=>fixture('complete'));
test('native Script: exit 0 without evidence is FAILED rather than false completion',async()=>fixture('no-proof'));
test('native Script: completion evidence from old execution is rejected',async()=>fixture('wrong-execution'));
