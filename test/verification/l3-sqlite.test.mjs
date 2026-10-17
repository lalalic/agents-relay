import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {createIsolatedEnvironment} from './harness.mjs';
import {SQLiteRelayStore} from '../../dist/relay-store.js';
import {schedule, transitionTaskEvent} from '../../dist/scheduler.js';

const stamp='2026-10-17T00:00:00.000Z';
const task=(id,dependencies=[])=>({jobId:'481-sim',id,parentTaskId:null,dependencies,capabilities:[],adapter:'orchestrator',input:'test',state:dependencies.length?'DRAFT':'QUEUED',attempt:0,maxAttempts:2,leaseOwner:null,leaseExpiresAt:null,executionId:null,threadId:null,result:null,error:null,timeoutMs:0,createdAt:stamp,updatedAt:stamp,continuation:null,continuationDeliveredAt:null});
const job=tasks=>({id:'481-sim',title:'isolated graph sqlite replay',repository:'local/isolated',prNumber:0,executionMode:'fixed',state:'ACTIVE',continuation:null,createdAt:stamp,updatedAt:stamp,tasks});

test('graph transitions, dependency scheduler and restart derive authority from isolated SQLite',async()=>{
  const env=createIsolatedEnvironment('relay-l3-sqlite-');
  const path=join(env.storeDir,'sim.sqlite');
  let db;
  try {
    db=new SQLiteRelayStore(path);
    await db.saveJob(job([task('a'),task('b',['a']),task('c',['a'])]));
    let state=await db.loadJob('481-sim');
    assert.equal(state.tasks[1].state,'DRAFT');
    await transitionTaskEvent(state.tasks[0],'task.started');
    await transitionTaskEvent(state.tasks[0],'task.completed');
    await db.saveJob(state);
    db.close();db=null;
    db=new SQLiteRelayStore(path);
    state=schedule(await db.loadJob('481-sim'));
    assert.equal(state.tasks[0].state,'SUCCEEDED');
    assert.deepEqual(state.tasks.slice(1).map(t=>t.state),['QUEUED','QUEUED']);
    await db.saveJob(state);
    const persisted=await db.loadJob('481-sim');
    assert.deepEqual(persisted.tasks.map(t=>t.state),['SUCCEEDED','QUEUED','QUEUED']);
    assert.equal(persisted.state,'ACTIVE');
  } finally {db?.close();env.cleanup();}
});

test('graph rejects second and stale terminal transition without corrupting sqlite',async()=>{
  const env=createIsolatedEnvironment('relay-l3-stale-');
  let db;
  try {
    db=new SQLiteRelayStore(join(env.storeDir,'state.sqlite'));
    const state=job([task('a')]);
    await transitionTaskEvent(state.tasks[0],'task.started');
    await transitionTaskEvent(state.tasks[0],'task.completed');
    await db.saveJob(state);
    await assert.rejects(transitionTaskEvent(state.tasks[0],'task.completed'),/No enabled workflow transition/);
    assert.equal((await db.loadJob(state.id)).tasks[0].state,'SUCCEEDED');
  } finally {db?.close();env.cleanup();}
});

test('unfinished autonomous objective cannot complete after one planner batch',async()=>{
  const {completionGateSatisfied}=await import('../../dist/scheduler.js');
  const state={...job([task('worker')]),executionMode:'autonomous',plans:[{id:'plan-1',round:1,status:'SUCCEEDED',objectiveStatus:'in_progress',plannerResult:{next_tasks:[{id:'next'}]}}]};
  state.tasks[0].state='SUCCEEDED';
  assert.equal(completionGateSatisfied(state),false);
  assert.equal(state.state,'ACTIVE');
});

test('deliberately broken causal dependency scenario fails rather than passing',async()=>{
  const state=job([task('prerequisite'),task('dependent',['prerequisite'])]);
  const observed=schedule(state);
  assert.notEqual(observed.tasks[1].state,'QUEUED','a blocked dependent cannot start');
  assert.throws(()=>assert.equal(observed.tasks[1].state,'QUEUED'),/QUEUED/);
});
