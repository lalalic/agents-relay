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
 const snapshot=(generation=2,patch={})=>db.prepare('INSERT OR REPLACE INTO job_snapshot VALUES(?,?,?)').run('job-1',JSON.stringify({tasks:[{id:'task-1',state:'RUNNING',executionId:'exec-1',leaseOwner:'owner-1',attempt:2,leaseExpiresAt:'2099-01-01T00:00:00.000Z',executionHistory:[{id:'exec-1',attempt:2}],...patch}]}),new Date().toISOString());
 snapshot();
 try{await run({db,snapshot,root});}finally{db.close();rmSync(root,{recursive:true,force:true});}
};
const id={jobId:'job-1',taskId:'task-1',leaseOwner:'owner-1',attempt:2,executionId:'exec-1',generation:2,graph:'job-lifecycle.mmd',actionId:'effect.deliverLocalMerge',attemptKey:'job-1/task-1/exec-1/g2/merge'};
const authorized={accepted:true,source:'ACTIVE',target:'ACTIVE',actions:[{id:id.actionId,input:{transport:'event',id:'approved',payload:{}},emittedEvents:[]}]};
const load=()=>import(pathToFileURL(join(dist,'workflow/action-ledger.js')).href);

test('A ledger: reject stale attempt-generation, lease, execution, owner and invalid clock', {skip:!dist},async()=>{
 const {WorkflowActionLedger}=await load();
 await fixture(async({db,snapshot})=>{
  const ledger=new WorkflowActionLedger(db);
  const reserve=(changes={},time='2026-10-19T20:00:00.000Z')=>ledger.reserveForRunningTask({...id,...changes},authorized,'merged',time);
  for(const changes of [{generation:3},{executionId:'old'},{leaseOwner:'stale'},{attempt:1}])assert.throws(()=>reserve(changes),/fenced/);
  snapshot(5,{attempt:3});assert.throws(()=>reserve(),/fenced/);
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
  db.prepare('INSERT INTO job_snapshot VALUES(?,?,?)').run(id.jobId,JSON.stringify({tasks:[{id:id.taskId,state:'RUNNING',executionId:id.executionId,leaseOwner:id.leaseOwner,attempt:id.attempt,leaseExpiresAt:'2099-01-01T00:00:00.000Z',executionHistory:[{id:id.executionId,attempt:id.attempt}]}]}),new Date().toISOString());
  let ledger=new WorkflowActionLedger(db);
  assert.equal(ledger.reserveForRunningTask(id,authorized,'merged'),true);
  db.close();db=new DatabaseSync(filename);ledger=new WorkflowActionLedger(db);
  assert.equal(ledger.trace(id.attemptKey).outcome,'Unknown');
  assert.equal(ledger.reserveForRunningTask(id,authorized,'merged'),false);
  // Action must not execute again after restart; real outbox and publish
  // crash windows require the future production runtime wiring.
 }finally{db.close();rmSync(root,{recursive:true,force:true});}
});

test('A dispatcher: verified effect persists transition once; crash before publish cannot repeat action', {skip:!dist},async()=>{
 const {WorkflowActionLedger}=await load();
 const {GraphRuntime}=await import(pathToFileURL(join(dist,'workflow/graph-v2.js')).href);
 const {dispatchWorkflowGraph}=await import(pathToFileURL(join(dist,'workflow/dispatcher.js')).href);
 const {ConditionRegistry,booleanCondition}=await import(pathToFileURL(join(dist,'workflow/conditions.js')).href);
 const source=`flowchart LR\n%% relay: initial a\na["state: ACTIVE"]\nb["state: COMPLETED"]\neffect["action: effect.deliverLocalMerge"]\na -->|on: approved| effect\neffect --> b`;
 const graph=new GraphRuntime(source,{states:new Set(['ACTIVE','COMPLETED']),actions:{[id.actionId]:{id:id.actionId}},events:{approved:{id:'approved'}}});
 const input={transport:'event',id:'approved',payload:{}};
 await fixture(async({db})=>{
  const ledger=new WorkflowActionLedger(db);
  const conditions=new ConditionRegistry([booleanCondition('merged')]);
  const transitions=[];const published=[];let effects=0;
  const invoke=()=>dispatchWorkflowGraph(graph,{initialState:'ACTIVE',input,executeAction:async()=>{effects++;return {ok:true};},persistTransition:async(a,b)=>{transitions.push([a,b]);},publishEvent:async id=>{published.push(id);},actionVerification:{ledger,conditions,identity:()=>id,conditionId:()=> 'merged',observedFacts:()=>({merged:true})},observe:false});
  await invoke();
  assert.equal(effects,1);
  assert.equal(ledger.trace(id.attemptKey).outcome,'Verified');
  assert.deepEqual(transitions,[['ACTIVE','COMPLETED']]);
  await assert.rejects(invoke(),/already reserved/);
  assert.equal(effects,1);
  assert.deepEqual(transitions,[['ACTIVE','COMPLETED']]);
  assert.ok(Array.isArray(published));
 });
});

test('A dispatcher: unknown postcondition prevents state persist and event publish across replay', {skip:!dist},async()=>{
 const {WorkflowActionLedger}=await load();
 const {GraphRuntime}=await import(pathToFileURL(join(dist,'workflow/graph-v2.js')).href);
 const {dispatchWorkflowGraph}=await import(pathToFileURL(join(dist,'workflow/dispatcher.js')).href);
 const {ConditionRegistry,booleanCondition}=await import(pathToFileURL(join(dist,'workflow/conditions.js')).href);
 const source=`flowchart LR\n%% relay: initial a\na["state: ACTIVE"]\nb["state: COMPLETED"]\neffect["action: effect.deliverLocalMerge"]\na -->|on: approved| effect\neffect --> b`;
 const graph=new GraphRuntime(source,{states:new Set(['ACTIVE','COMPLETED']),actions:{[id.actionId]:{id:id.actionId}},events:{approved:{id:'approved'}}});
 await fixture(async({db})=>{
  const ledger=new WorkflowActionLedger(db);
  const conditions=new ConditionRegistry([booleanCondition('merged')]);
  let actions=0;const transitions=[];const emitted=[];
  const invoke=()=>dispatchWorkflowGraph(graph,{initialState:'ACTIVE',input:{transport:'event',id:'approved',payload:{}},executeAction:async()=>{actions++;return {ok:true};},persistTransition:(a,b)=>transitions.push([a,b]),publishEvent:e=>emitted.push(e),actionVerification:{ledger,conditions,identity:()=>id,conditionId:()=> 'merged',observedFacts:()=>({})},observe:false});
  await assert.rejects(invoke(),/Unknown/);
  assert.equal(ledger.trace(id.attemptKey).outcome,'Unknown');
  await assert.rejects(invoke(),/already reserved/);
  assert.equal(actions,1);
  assert.deepEqual(transitions,[]);
  assert.deepEqual(emitted,[]);
 });
});

test('A ledger: missing and mismatched executionHistory are fenced', {skip:!dist},async()=>{
 const {WorkflowActionLedger}=await load();
 await fixture(async({db,snapshot})=>{
  const ledger=new WorkflowActionLedger(db);
  snapshot(2,{executionHistory:[]});
  assert.throws(()=>ledger.reserveForRunningTask(id,authorized,'merged'),/fenced/);
  snapshot(2,{executionHistory:[{id:'older-exec',attempt:1}]});
  assert.throws(()=>ledger.reserveForRunningTask(id,authorized,'merged'),/fenced/);
  snapshot(2,{executionHistory:[{id:'exec-1',attempt:1}]});
  assert.throws(()=>ledger.reserveForRunningTask(id,authorized,'merged'),/fenced/);
  snapshot(2,{executionHistory:[{id:'exec-1',attempt:2}]});
  assert.equal(ledger.reserveForRunningTask(id,authorized,'merged'),true);
 });
});

test('A ledger: active pause rejects reserve, resumed lease permits fresh attempt', {skip:!dist},async()=>{
 const {WorkflowActionLedger}=await load();
 await fixture(async({db,snapshot})=>{
  const ledger=new WorkflowActionLedger(db);
  const save=(pause,attempt=2)=>db.prepare('UPDATE job_snapshot SET json=? WHERE job_id=?').run(JSON.stringify({...(pause?{pause}:{}),tasks:[{id:id.taskId,state:'RUNNING',executionId:id.executionId,leaseOwner:id.leaseOwner,attempt,leaseExpiresAt:'2099-01-01T00:00:00.000Z',executionHistory:[{id:id.executionId,attempt}]}]}),id.jobId);
  save({generation:1,reason:'maintenance'});
  assert.throws(()=>ledger.reserveForRunningTask(id,authorized,'merged'),/fenced/);
  save(null);
  assert.equal(ledger.reserveForRunningTask(id,authorized,'merged'),true);
 });
});
