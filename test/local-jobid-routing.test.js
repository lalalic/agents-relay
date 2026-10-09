import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { InMemoryStore } from '../dist/store.js';
import { RepositoryWorkerPool } from '../dist/pool.js';
import { MemoryEventBus, eventFor } from '../dist/events.js';

const stamp = '2026-10-09T10:00:00.000Z';
const scheduled = {
  id:'local-no-pr', title:'No remote binding', repository:'local/work', prNumber:0,
  state:'ACTIVE', executionMode:'autonomous', createdAt:stamp, updatedAt:stamp,
  continuation:null, tasks:[], autoMerge:false, reviewEnabled:false,
  schedule:{cron:'0 * * * *',timezone:'UTC',nextRunAt:stamp,missedRunPolicy:'run',
    concurrencyPolicy:'skip',lastScheduledSlot:null,currentRunSlot:null,lastRunAt:null},
};
function fixture(job=scheduled) {
  const store=new InMemoryStore(job);
  const calls=[];let githubCalls=0;
  const client={request:async()=>{githubCalls++;throw Error('GitHub must not run');},
    graphql:async()=>{githubCalls++;throw Error('GitHub must not run');}};
  const overview={job,githubState:'UNKNOWN',draft:false,mergedAt:null,closedAt:null};
  const pool=new RepositoryWorkerPool(2,
    (_store,capacity)=>({
      reconcile:async id=>{ calls.push(['reconcile',id,capacity]); },
      recoverStartupOrphans:async id=>{calls.push(['startup',id]);return await store.load(id);},
      applyEvent:async event=>{calls.push(['event',event.type]);return {applied:true,reconcile:true};},
    }),
    async()=>[overview],
    async id=>id===job.id ? {job:await store.load(id),store} : null);
  return {store,calls,pool,getGithubCalls:()=>githubCalls,overview};
}
test('no-PR scheduled Job claims SQLite schedule and reconciles by immutable jobId',async()=>{
  const f=fixture();const now=new Date('2026-10-09T10:05:00.000Z');
  await f.pool.scheduleTickSignal(undefined,scheduled,now);
  assert.deepEqual(f.calls,[['reconcile','local-no-pr',0]]);
  const result=await f.store.load(scheduled.id);
  assert.equal(result.schedule.lastScheduledSlot,stamp);
  assert.equal(result.schedule.lastRunAt,now.toISOString());
  assert.equal(f.getGithubCalls(),0);
});
test('no-PR startup recovery and discovered work use local store resolution only',async()=>{
  const work={jobId:scheduled.id,id:'worker',state:'QUEUED',dependencies:[],attempt:0,
    leaseOwner:null,leaseExpiresAt:null,executionId:null,adapter:'orchestrator',input:'local',
    parentTaskId:null,createdAt:stamp,updatedAt:stamp};
  const root={...scheduled,schedule:undefined,tasks:[work]};
  const f=fixture(root);
  await f.pool.reconcileKnown([f.overview]);
  assert.deepEqual(f.calls.map(item=>item[0]),['startup','reconcile']);
  assert.equal(f.getGithubCalls(),0);
});
test('no-PR targeted worker event resolves Job ID without GitHub PR metadata',async()=>{
  const f=fixture({...scheduled,schedule:undefined});
  const bus=new MemoryEventBus();const stop=await f.pool.watch(bus);
  try {
    await bus.publish(eventFor(scheduled.id,'worker',null,'task.completed','succeeded',
      'local worker completed','orchestrator',{taskId:'worker'}));
    for(let tries=0;tries<100&&!f.calls.some(item=>item[0]==='reconcile');tries++)
      await new Promise(resolve=>setTimeout(resolve,2));
    assert.equal(f.calls.some(item=>item[0]==='event'),true);
    assert.equal(f.calls.some(item=>item[0]==='reconcile'),true);
    assert.equal(f.getGithubCalls(),0);
  } finally {await stop();}
});

test('planner.completed wakes queued work immediately without periodic reconcile',async()=>{
  const work={jobId:'planner-wake',id:'work',state:'QUEUED',dependencies:[],attempt:0,maxAttempts:3,
    leaseOwner:null,leaseExpiresAt:null,executionId:null,adapter:'orchestrator',input:'local',output:{kind:'task_pr'},
    parentTaskId:null,createdAt:stamp,updatedAt:stamp};
  const root={...scheduled,id:'planner-wake',schedule:undefined,tasks:[work]};
  const store=new InMemoryStore(root);const calls=[];
  const pool=new RepositoryWorkerPool(1,
    (_store,capacity)=>({applyEvent:async()=>({applied:false,reconcile:false}),reconcile:async id=>{calls.push([id,capacity]);}}),
    async()=>[{job:await store.load(root.id),githubState:'UNKNOWN',draft:false,mergedAt:null,closedAt:null}],
    async id=>id===root.id?{job:await store.load(id),store}:null);
  const bus=new MemoryEventBus();const stop=await pool.watch(bus);
  try{
    await bus.publish(eventFor(root.id,'plan-1',null,'planner.completed','succeeded','planner done','orchestrator'));
    for(let i=0;i<100&&calls.length===0;i++)await new Promise(resolve=>setTimeout(resolve,2));
    assert.deepEqual(calls,[[root.id,0],[root.id,1]]);
  }finally{await stop();}
});

test('worker terminal wake releases global capacity to another queued Job without timer',async()=>{
  const runningTask={jobId:'job-a',id:'a',state:'RUNNING',dependencies:[],attempt:1,maxAttempts:3,
    leaseOwner:'relay',leaseExpiresAt:'2099-01-01T00:00:00.000Z',executionId:'exec-a',adapter:'orchestrator',input:'a',output:{kind:'task_pr'},
    parentTaskId:null,createdAt:stamp,updatedAt:stamp};
  const queuedTask={jobId:'job-b',id:'b',state:'QUEUED',dependencies:[],attempt:0,maxAttempts:3,
    leaseOwner:null,leaseExpiresAt:null,executionId:null,adapter:'orchestrator',input:'b',output:{kind:'task_pr'},
    parentTaskId:null,createdAt:stamp,updatedAt:stamp};
  const a={...scheduled,id:'job-a',schedule:undefined,tasks:[runningTask]};
  const b={...scheduled,id:'job-b',schedule:undefined,tasks:[queuedTask]};
  const stores=new Map([['job-a',new InMemoryStore(a)],['job-b',new InMemoryStore(b)]]);const calls=[];
  const inventory=async()=>Promise.all([...stores].map(async([id,store])=>({job:await store.load(id),githubState:'UNKNOWN',draft:false,mergedAt:null,closedAt:null})));
  const pool=new RepositoryWorkerPool(1,
    (store,capacity)=>({
      applyEvent:async event=>{if(event.type==='task.completed'){const job=await store.load(event.job_id);const task=job.tasks.find(t=>t.id===event.task_id);task.state='SUCCEEDED';task.executionId=null;task.leaseOwner=null;task.leaseExpiresAt=null;await store.saveTask(task);return {applied:true,reconcile:true};}return {applied:false,reconcile:false};},
      reconcile:async id=>{calls.push([id,capacity]);},
    }),inventory,async id=>stores.has(id)?{job:await stores.get(id).load(id),store:stores.get(id)}:null);
  await pool.reconcile();
  assert.equal(calls.some(([id])=>id==='job-b'),false,'queued Job must not exceed occupied global capacity');
  const bus=new MemoryEventBus();const stop=await pool.watch(bus);
  try{
    await bus.publish(eventFor('job-a','a',null,'task.completed','succeeded','a done','orchestrator'));
    for(let i=0;i<100&&!calls.some(([id])=>id==='job-b');i++)await new Promise(resolve=>setTimeout(resolve,2));
    assert.equal(calls.some(([id,capacity])=>id==='job-b'&&capacity===1),true,'freed slot must dispatch queued Job immediately');
  }finally{await stop();}
});
