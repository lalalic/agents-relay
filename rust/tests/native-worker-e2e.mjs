import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {SQLiteRelayStore} from '../../dist/relay-store.js';
const exe=resolve(import.meta.dirname,'../target/debug/examples/native_pipeline_fixture');
const time='2026-11-13T20:00:00.000Z';
const task={jobId:'91',id:'101',parentTaskId:null,dependencies:[],capabilities:[],adapter:'script',input:'test',
  state:'DRAFT',attempt:0,maxAttempts:2,leaseOwner:null,leaseExpiresAt:null,executionId:null,threadId:null,
  result:null,error:null,timeoutMs:5000,createdAt:time,updatedAt:time,continuation:null,continuationDeliveredAt:null};

test('real Rust Task pipeline uses canonical Graph + SQLite lease + worker + Event Outbox; TS observes success',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'relay-rust-authority-'));
  const db=join(dir,'relay.sqlite');writeFileSync(join(dir,'.relay-rust-authority-isolated-test'),'isolated');
  let store;
  try {
    store=new SQLiteRelayStore(db);
    await store.saveJob({id:'91',title:'real local Script Worker fixture',repository:'example',projectRoot:dir,
      prNumber:0,state:'ACTIVE',reviewEnabled:false,continuation:null,createdAt:time,updatedAt:time,tasks:[structuredClone(task)]});
    store.close();store=null;
    const response=spawnSync(exe,[db],{encoding:'utf8',timeout:12000,
      env:{...process.env,RELAY_RUST_EXPERIMENTAL_TEST_ONLY:'isolated-test'}});
    assert.equal(response.status,0,response.stderr);
    const result=JSON.parse(response.stdout);
    assert.equal(result.state,'SUCCEEDED');
    assert.equal(result.exitCode,0);
    assert.equal(result.actionOutcome,'Verified');
    assert.equal(result.stdout,'rust-worker-output');
    assert.equal(result.stderr,'rust-worker-stderr');
    assert.equal(result.process.endedAt,'2099-01-01T00:00:04.000Z');
    assert.equal(result.process.pid,result.pid);
    assert.equal(result.events.length,1);
    assert.equal(result.events[0].eventId,'task.completed');
    store=new SQLiteRelayStore(db);
    const actual=await store.loadJob('91');
    assert.equal(actual.tasks[0].state,'SUCCEEDED');
    assert.equal(actual.tasks[0].executionId,'ex-rust-1');
    const raw=new DatabaseSync(db);
    assert.equal(raw.prepare('SELECT outcome FROM workflow_action_trace WHERE attempt_key=?').get('91/101/ex-rust-1/launch').outcome,'Verified');
    assert.equal(raw.prepare('SELECT count(*) AS n FROM workflow_event_outbox WHERE state=?').get('pending').n,1);
    raw.close();
    console.log('Real native Rust Task E2E: DRAFT -> QUEUED -> RUNNING -> SUCCEEDED + verified effect + TS read');
  } finally {store?.close();rmSync(dir,{recursive:true,force:true});}
});
