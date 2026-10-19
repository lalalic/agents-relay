import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

// Explicit opt-in: run against A's COMPILED implementation, not copied or
// reimplemented logic. Never build or mutate A's dirty worktree from B.
const dist=process.env.RELAY_A_DIST;
const fixture=async run=>{
 const root=mkdtempSync(join(tmpdir(),'relay-ledger-cross-'));
 const db=new DatabaseSync(join(root,'store.sqlite'));
 db.exec('CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL)');
 const snapshot=(generation=2,patch={})=>db.prepare('INSERT OR REPLACE INTO job_snapshot VALUES(?,?,?)').run('job-1',JSON.stringify({pause:{generation},tasks:[{id:'task-1',state:'RUNNING',executionId:'exec-1',leaseOwner:'owner-1',attempt:2,leaseExpiresAt:'2099-01-01T00:00:00.000Z',...patch}]}),new Date().toISOString());
 snapshot();
 try{await run({db,snapshot,root});}finally{db.close();rmSync(root,{recursive:true,force:true});}
};
const id={jobId:'job-1',taskId:'task-1',leaseOwner:'owner-1',attempt:2,executionId:'exec-1',generation:2,graph:'job-lifecycle.mmd',actionId:'effect.deliverLocalMerge',attemptKey:'job-1/task-1/exec-1/g2/merge'};
const authorized={accepted:true,source:'ACTIVE',target:'ACTIVE',actions:[{id:id.actionId,input:{transport:'event',id:'approved',payload:{}},emittedEvents:[]}]};
const load=()=>import(pathToFileURL(join(dist,'workflow/action-ledger.js')).href);

test('A ledger: reject stale generation, lease, execution, owner, attempt and invalid clock', {skip:!dist},async()=>{
 const {WorkflowActionLedger}=await load();
 await fixture(async({db,snapshot})=>{
  const ledger=new WorkflowActionLedger(db);
  const reserve=(changes={},time='2026-10-19T20:00:00.000Z')=>ledger.reserveForRunningTask({...id,...changes},authorized,'merged',time);
  for(const changes of [{generation:3},{executionId:'old'},{leaseOwner:'stale'},{attempt:1}])assert.throws(()=>reserve(changes),/fenced/);
  snapshot(5);assert.throws(()=>reserve(),/fenced/);
  snapshot(2,{leaseExpiresAt:'2026-10-19T19:00:00.000Z'});assert.throws(()=>reserve(),/fenced/);
  snapshot(2,{leaseExpiresAt:'not-a-date'});assert.throws(()=>reserve(),/fenced/);
  snapshot();assert.throws(()=>reserve({},'not-a-date'),/fenced/);
  assert.equal(ledger.trace(id.attemptKey),null);
 });
});
test('A ledger: exact replay idempotent; same key with different identity fails closed', {skip:!dist},async()=>{
 const {WorkflowActionLedger}=await load();
 await fixture(async({db})=>{
  const ledger=new WorkflowActionLedger(db);
  assert.equal(ledger.reserveForRunningTask(id,authorized,'merged'),true);
  assert.equal(ledger.reserveForRunningTask(id,authorized,'merged'),false);
  assert.throws(()=>ledger.reserveForRunningTask({...id,graph:'review-lifecycle.mmd'},authorized,'merged'),/collision/);
  assert.throws(()=>ledger.reserveForRunningTask(id,authorized,'other-condition'),/collision/);
 });
});
test('A ledger: crash/reopen preserves Unknown and prevents duplicate effect execution', {skip:!dist},async()=>{
 const {WorkflowActionLedger}=await load();
 const root=mkdtempSync(join(tmpdir(),'relay-ledger-reopen-'));
 const filename=join(root,'store.sqlite');
 let db=new DatabaseSync(filename);
 try{
  db.exec('CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL)');
  db.prepare('INSERT INTO job_snapshot VALUES(?,?,?)').run(id.jobId,JSON.stringify({pause:{generation:2},tasks:[{id:id.taskId,state:'RUNNING',executionId:id.executionId,leaseOwner:id.leaseOwner,attempt:id.attempt,leaseExpiresAt:'2099-01-01T00:00:00.000Z'}]}),new Date().toISOString());
  let ledger=new WorkflowActionLedger(db);
  assert.equal(ledger.reserveForRunningTask(id,authorized,'merged'),true);
  db.close();db=new DatabaseSync(filename);ledger=new WorkflowActionLedger(db);
  assert.equal(ledger.trace(id.attemptKey).outcome,'Unknown');
  assert.equal(ledger.reserveForRunningTask(id,authorized,'merged'),false);
  // Action must not execute again after restart; real outbox and publish
  // crash windows require the future production runtime wiring.
 }finally{db.close();rmSync(root,{recursive:true,force:true});}
});
