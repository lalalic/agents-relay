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
  assert.deepEqual(f.calls,[['reconcile','local-no-pr',2]]);
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
