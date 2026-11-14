import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {SQLiteRelayStore} from '../../dist/relay-store.js';
import {allocateEntityId} from '../../dist/job-task-id-sequence.js';

const binary=resolve(import.meta.dirname,'../target/debug/examples/interop_fixture');
function fixtureCall(action,db,id,stamp,key) {
  const result=spawnSync(binary,[action,db,id,stamp,key],{
    encoding:'utf8',env:{...process.env,RELAY_RUST_EXPERIMENTAL_TEST_ONLY:'isolated-test'},maxBuffer:4*1024*1024,
  });
  assert.equal(result.status,0,result.stderr);
  return JSON.parse(result.stdout);
}
const initial='2026-11-13T20:00:00.000Z';
const task=id=>({jobId:'91',id,parentTaskId:null,dependencies:[],capabilities:[],adapter:'orchestrator',input:'test',state:'QUEUED',attempt:0,maxAttempts:2,leaseOwner:null,leaseExpiresAt:null,executionId:null,threadId:null,result:null,error:null,timeoutMs:1000,createdAt:initial,updatedAt:initial,continuation:null,continuationDeliveredAt:null});

test('TypeScript Job -> Rust atomic snapshot+event -> TypeScript Job+event -> Rust Inbox+IDs',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'relay-rust-authority-'));
  const db=join(dir,'relay.sqlite');
  writeFileSync(join(dir,'.relay-rust-authority-isolated-test'),'only a disposable test fixture');
  let store;
  try {
    store=new SQLiteRelayStore(db);
    await store.saveJob({id:'91',title:'Rust SQLite authority fixture',repository:'example',projectRoot:dir,
      prNumber:0,state:'ACTIVE',reviewEnabled:false,continuation:null,createdAt:initial,updatedAt:initial,tasks:[task('101')]});
    store.close();store=null;
    const stamp='2099-01-01T01:00:00.000Z';
    const committed=fixtureCall('commit',db,'91',stamp,'isolated-rust-event');
    assert.equal(committed.job.tasks[0].state,'RUNNING');
    assert.equal(committed.job.updatedAt,stamp);
    const actual=fixtureCall('pending',db,'91',stamp,'unused');
    assert.equal(actual.length,1);
    assert.equal(actual[0].key,'isolated-rust-event');
    assert.equal(actual[0].payload.event_id,actual[0].key);
    assert.equal(actual[0].payload.type,'task.started');
    assert.deepEqual(fixtureCall('inbox',db,'91',stamp,'isolated-rust-event'),{applied:true});
    assert.deepEqual(fixtureCall('inbox',db,'91',stamp,'isolated-rust-event'),{applied:false});
    const ids=fixtureCall('ids',db,'91',stamp,'a-child-task-id');
    assert.equal(ids.taskId,'102');
    assert.equal(fixtureCall('ids',db,'91',stamp,'a-child-task-id').taskId,'102');
    const storesDir=join(dir,'stores');
    assert.equal(allocateEntityId(storesDir,'myrepo','task','a-child-task-id'),'102',
      'TypeScript must dedupe the Rust-created idempotency key');
    assert.equal(allocateEntityId(storesDir,'myrepo','task','another-task-id'),'103',
      'TypeScript must continue Rust sequence without gaps/duplicate IDs');
    store=new SQLiteRelayStore(db);
    const fromTypeScript=await store.loadJob('91');
    assert.equal(fromTypeScript.tasks[0].state,'RUNNING');
    assert.equal(fromTypeScript.updatedAt,stamp);
    const direct=new DatabaseSync(db);
    const event=direct.prepare('SELECT event_id,payload_json,state FROM workflow_event_outbox WHERE event_key=?').get('isolated-rust-event');
    assert.equal(event.event_id,'task.started');assert.equal(event.state,'pending');
    assert.equal(JSON.parse(event.payload_json).event_id,'isolated-rust-event');
    direct.close();
    console.log('Cross-language authority verified: TS writes -> Rust atomic commit/outbox/inbox/ID -> TS reads');
  } finally {store?.close();rmSync(dir,{recursive:true,force:true});}
});

test('Rust fixture denies missing opt-in and test-only marker',()=>{
  const dir=mkdtempSync(join(tmpdir(),'relay-rust-authority-'));
  const db=join(dir,'relay.sqlite');
  try {
    const sql=new DatabaseSync(db);sql.exec('CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT,updated_at TEXT)');sql.close();
    const rejected=spawnSync(binary,['ids',db,'91',initial,'key'],{encoding:'utf8',env:{...process.env,RELAY_RUST_EXPERIMENTAL_TEST_ONLY:'isolated-test'}});
    assert.notEqual(rejected.status,0);
    assert.match(rejected.stderr,/refusing non-isolated/);
    writeFileSync(join(dir,'.relay-rust-authority-isolated-test'),'test marker');
    const disabled=spawnSync(binary,['ids',db,'91',initial,'key'],{encoding:'utf8',env:{...process.env,RELAY_RUST_EXPERIMENTAL_TEST_ONLY:''}});
    assert.notEqual(disabled.status,0);
    assert.match(disabled.stderr,/not an isolated/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('TypeScript unified outbox -> Rust claim/complete -> TypeScript receipt and retry exclusion',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'relay-rust-authority-'));
  const db=join(dir,'relay.sqlite');writeFileSync(join(dir,'.relay-rust-authority-isolated-test'),'isolated');
  let store;
  try {
    store=new SQLiteRelayStore(db,'91');
    await store.saveJob({id:'91',title:'Unified Rust projection test',repository:'example',projectRoot:dir,
      prNumber:0,state:'ACTIVE',reviewEnabled:false,continuation:null,createdAt:initial,updatedAt:initial,tasks:[task('101')]});
    await store.enqueueProjection({idempotencyKey:'external-merge-1',operation:'merge_pull_request',
      payload:{operation:'merge_pull_request',value:{jobId:'91'}},priority:50});
    assert.equal(await store.pendingProjectionCount(),1);
    store.close();store=null;
    const stamp='2099-01-01T01:00:00.000Z';
    const claimed=fixtureCall('projection-claim',db,'91',stamp,'unused');
    assert.equal(claimed.length,1);
    assert.equal(claimed[0].operation,'merge_pull_request');
    assert.equal(claimed[0].operationKey,'external-merge-1');
    assert.equal(claimed[0].priority,50);
    // A TS Reconciler must not also claim the already Rust-owned operation.
    store=new SQLiteRelayStore(db,'91');
    assert.deepEqual(await store.claimDueProjections(10,new Date(stamp)),[]);
    store.close();store=null;
    const result=fixtureCall('projection-complete',db,'91',stamp,JSON.stringify(claimed[0]));
    assert.deepEqual(result,{completed:claimed[0].id});
    const invalid=spawnSync(binary,['projection-complete',db,'91',stamp,JSON.stringify(claimed[0])],{
      encoding:'utf8',env:{...process.env,RELAY_RUST_EXPERIMENTAL_TEST_ONLY:'isolated-test'},
    });
    assert.notEqual(invalid.status,0,'stale claimant must not submit a second receipt');
    store=new SQLiteRelayStore(db,'91');
    assert.equal(await store.pendingProjectionCount(),0);
    const direct=new DatabaseSync(db);
    const row=direct.prepare('SELECT status,operation_key,detail_json FROM projection_receipt WHERE scope_job_id=? AND operation_key=?')
      .get('91','external-merge-1');
    assert.equal(row.status,'succeeded');
    assert.equal(row.operation_key,'external-merge-1');
    assert.equal(JSON.parse(row.detail_json).status,'committed');
    direct.close();
    console.log('Unified projection parity: TS enqueue -> Rust claim/complete -> TS receipt');
  } finally {store?.close();rmSync(dir,{recursive:true,force:true});}
});
