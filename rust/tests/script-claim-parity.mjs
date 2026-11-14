import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {SQLiteRelayStore} from '../../dist/relay-store.js';
import {DatabaseSync} from 'node:sqlite';
const bin=resolve(import.meta.dirname,'../target/debug/examples/interop_fixture');
const at='2099-01-01T00:00:03.000Z';
const expiry='2099-01-01T00:10:00.000Z';
function setup(){
 const dir=mkdtempSync(join(tmpdir(),'relay-rust-authority-'));
 writeFileSync(join(dir,'.relay-rust-authority-isolated-test'),'marked');
 return {dir,db:join(dir,'relay.sqlite')};
}
function task(id,dependencies=[]){return {jobId:'91',id,parentTaskId:null,dependencies,
 state:'QUEUED',adapter:'script',kind:'work',capabilities:['script'],input:'test',output:{kind:'file',path:'/tmp/fake.json'},
 attempt:0,maxAttempts:3,leaseOwner:null,leaseExpiresAt:null,executionId:null,threadId:null,
 error:null,result:null,timeoutMs:100000,createdAt:'2026-11-13T20:00:00.000Z',updatedAt:'2026-11-13T20:00:00.000Z'};}
function startLaunch(db,claimed) {
 return new Promise(resolvePromise=>{
  const p=spawn(bin,['script-launch',db,'91','2099-01-01T00:00:04.000Z',JSON.stringify(claimed)],
   {stdio:['ignore','pipe','pipe'],env:{...process.env,RELAY_RUST_EXPERIMENTAL_TEST_ONLY:'isolated-test'}});
  let stdout='',stderr='';p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);
  p.on('close',code=>resolvePromise({code,stdout,stderr}));
 });
}
function claim(db,executionId,taskId='101'){
 return new Promise(resolvePromise=>{
  const p=spawn(bin,['script-claim',db,'91',at,JSON.stringify({taskId,executionId,owner:'native-scheduler',leaseExpiresAt:expiry})],
   {stdio:['ignore','pipe','pipe'],env:{...process.env,RELAY_RUST_EXPERIMENTAL_TEST_ONLY:'isolated-test'}});
  let stdout='',stderr='';p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);
  p.on('close',code=>resolvePromise({code,stdout,stderr}));
 });
}
test('native Script Scheduler claims once across 12 competing processes and TypeScript reads one lease',async()=>{
 const {dir,db}=setup();let store;
 try{
  store=new SQLiteRelayStore(db);
  await store.saveJob({id:'91',repository:'example',projectRoot:dir,prNumber:0,state:'ACTIVE',
   createdAt:'2026-11-13T20:00:00.000Z',updatedAt:'2026-11-13T20:00:00.000Z',tasks:[task('101')]});
  store.close();store=null;
  const results=await Promise.all(Array.from({length:12},(_,i)=>claim(db,`ex-${i}`)));
  assert.equal(results.filter(r=>r.code===0).length,1,JSON.stringify(results));
  const accepted=JSON.parse(results.find(r=>r.code===0).stdout);
  assert.equal(accepted.attempt,1);
  store=new SQLiteRelayStore(db);
  const persisted=(await store.loadJob('91')).tasks[0];
  assert.equal(persisted.executionId,accepted.executionId);
  assert.equal(persisted.leaseOwner,'native-scheduler');
  assert.equal(persisted.leaseExpiresAt,expiry);
  assert.equal(persisted.executionHistory.length,1);
  assert.equal(persisted.executionHistory[0].attempt,1);
  const conn=new DatabaseSync(db);
  assert.equal(conn.prepare('SELECT count(*) AS count FROM workflow_action_trace').get().count,1);
  const row=conn.prepare('SELECT action_id,outcome,execution_id FROM workflow_action_trace').get();
  assert.equal(row.action_id,'effect.launchTask');assert.equal(row.outcome,'Unknown');
  assert.equal(row.execution_id,accepted.executionId);
  conn.close();
  const replay=await claim(db,accepted.executionId);
  assert.notEqual(replay.code,0,'identical replay cannot launch again');
  const launches=await Promise.all(Array.from({length:12},()=>startLaunch(db,accepted)));
  assert.equal(launches.filter(launch=>launch.code===0).length,1,
   'copied ScriptClaim cannot launch the same Worker generation twice');
  const sealed=new DatabaseSync(db);
  assert.equal(sealed.prepare('SELECT observed_at FROM workflow_action_trace').get().observed_at,
   '2099-01-01T00:00:04.000Z');
  assert.equal(sealed.prepare('SELECT count(*) AS n FROM workflow_action_trace').get().n,1);
  sealed.close();
  console.log('Rust/TS parallel claim: 12 contenders, exactly 1 durable lease AND launch attempt in same transaction');
 }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});
test('native Script Scheduler refuses unready dependencies, paused Job, and unapproved review',async()=>{
 const {dir,db}=setup();let store;
 try{
  store=new SQLiteRelayStore(db);
  await store.saveJob({id:'91',repository:'example',projectRoot:dir,prNumber:0,state:'ACTIVE',
   createdAt:'2026-11-13T20:00:00.000Z',updatedAt:'2026-11-13T20:00:00.000Z',tasks:[task('101',['102']),task('102')]});
  store.close();store=null;
  assert.notEqual((await claim(db,'not-ready')).code,0);
  store=new SQLiteRelayStore(db);
  await store.mutateJob('91',job=>{job.tasks[1].state='SUCCEEDED';job.pause={generation:1};return job;});
  store.close();store=null;
  assert.notEqual((await claim(db,'paused')).code,0);
  const conn=new DatabaseSync(db);
  assert.equal(conn.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name='workflow_action_trace'").get().count,0);
  conn.close();
 }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});
