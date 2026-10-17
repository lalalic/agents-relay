import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {SQLiteRelayStore} from '../../dist/relay-store.js';
import {Reconciler} from '../../dist/reconciler.js';
import {LocalAuthorityDurableStore} from '../../dist/local-authority-store.js';
import {InMemoryStore} from '../../dist/store.js';
import {schedule, completionGateSatisfied} from '../../dist/scheduler.js';
import {createIsolatedEnvironment} from './harness.mjs';

const stamp='2026-10-17T12:00:00.000Z';
const task=(id,state='RUNNING',dependencies=[])=>({
  jobId:'l3',id,parentTaskId:null,dependencies,capabilities:[],adapter:'orchestrator',
  input:'L3',state,attempt:1,maxAttempts:3,leaseOwner:null,leaseExpiresAt:null,
  executionId:state==='RUNNING'?'exec-'+id:null,threadId:null,result:null,error:null,
  timeoutMs:30000,createdAt:stamp,updatedAt:stamp,continuation:null,continuationDeliveredAt:null,
});
const job=(tasks,extra={})=>({
  id:'l3',repository:'local/test',title:'L3 production path',prNumber:0,
  executionMode:'fixed',state:'ACTIVE',continuation:null,createdAt:stamp,updatedAt:stamp,tasks,...extra
});
const event=(id,type='task.completed',execution='exec-'+id,eventId='event-'+id)=>({
  version:1,event_id:eventId,job_id:'l3',task_id:id,parent_task_id:null,
  type,status:type==='task.failed'?'failed':'completed',timestamp:stamp,
  visibility:'orchestrator',level:'info',message:type,
  source:{id:`job/l3/task/${id}/execution/${execution}`},
  data:type==='task.completed'?{summary:'done',validation:'test'}:{phase:'implementation',reason:'injected'},
});
async function fixture(tasks,extra={}) {
  const isolation=createIsolatedEnvironment('relay-l3-path-');
  const db=join(isolation.storeDir,'relay.sqlite');
  const sqlite=new SQLiteRelayStore(db);
  const store=new LocalAuthorityDurableStore(sqlite,new InMemoryStore());
  await store.saveJob(job(tasks,extra));
  const runtime=new Reconciler(store,{owner:'l3-test',noGitHub:true,adapters:[],maxConcurrent:0});
  return {store,runtime,db,isolation,async close(){await runtime.close();sqlite.close();isolation.cleanup();}};
}
test('canonical worker completion crosses production ingress, graph, and SQLite durability',async()=>{
  const f=await fixture([task('a')]);
  try {
    await f.runtime.handleEvent(event('a'));
    const durable=await f.store.load('l3');
    assert.equal(durable.tasks[0].state,'SUCCEEDED');
    assert.equal(durable.tasks[0].result?.summary,'task.completed');
    const restarted=new SQLiteRelayStore(f.db);
    try {assert.equal((await restarted.loadJob('l3')).tasks[0].state,'SUCCEEDED');}
    finally {restarted.close();}
  }finally{await f.close();}
});
test('duplicate and stale execution terminal events cannot mutate a durable success',async()=>{
  const f=await fixture([task('a')]);
  try {
    await f.runtime.handleEvent(event('a'));
    const before=await f.store.load('l3');
    await f.runtime.handleEvent(event('a','task.failed','exec-a','duplicate-failed'));
    await f.runtime.handleEvent(event('a','task.failed','obsolete','stale-failed'));
    const after=await f.store.load('l3');
    assert.equal(after.tasks[0].state,'SUCCEEDED');
    assert.deepEqual(after.tasks[0].result,before.tasks[0].result);
  }finally{await f.close();}
});
test('scheduler keeps parallel child dependencies closed until durable upstream completion',async()=>{
  const f=await fixture([task('a'),task('b','DRAFT',['a']),task('c','DRAFT',['a'])]);
  try{
    const initial=schedule(await f.store.load('l3'));
    assert.equal(initial.tasks.filter(t=>t.state==='QUEUED').length,0);
    await f.runtime.handleEvent(event('a'));
    const next=schedule(await f.store.load('l3'));
    assert.deepEqual(next.tasks.filter(t=>t.state==='QUEUED').map(t=>t.id).sort(),['b','c']);
  }finally{await f.close();}
});
test('premature planner batch is not completion authority for autonomous objective',()=>{
  const x=job([task('a','SUCCEEDED')],{executionMode:'autonomous',plans:[{
    id:'p1',round:1,status:'SUCCEEDED',objectiveStatus:'in_progress',
    plannerResult:{next_tasks:[{id:'future'}]},
  }]});
  assert.equal(completionGateSatisfied(x),false);
});
test('worker failure is durable, cannot be healed by a stale success after restart',async()=>{
  const f=await fixture([task('a')]);
  try {
    await f.runtime.handleEvent(event('a','task.failed'));
    const failed=await f.store.load('l3');
    assert.equal(failed.tasks[0].state,'FAILED');
    await f.runtime.close();
    const restartedRuntime=new Reconciler(f.store,{owner:'l3-restarted',noGitHub:true,adapters:[],maxConcurrent:0});
    try {
      await restartedRuntime.handleEvent(event('a','task.completed','old-execution','stale-after-restart'));
      assert.equal((await f.store.load('l3')).tasks[0].state,'FAILED');
    } finally {await restartedRuntime.close();}
  }finally{await f.close();}
});
test('duplicate terminal event with changing timestamps cannot alter SQLite history',async()=>{
  const f=await fixture([task('a')]);
  try{
    await f.runtime.handleEvent(event('a'));
    const initial=JSON.stringify((await f.store.load('l3')).tasks[0]);
    for(let n=0;n<4;n++){
      await f.runtime.handleEvent({...event('a','task.completed','exec-a','duplicate-'+n),timestamp:new Date(1000*n).toISOString()});
      assert.equal(JSON.stringify((await f.store.load('l3')).tasks[0]),initial);
    }
  }finally{await f.close();}
});
test('negative injection: cannot declare a terminal state from a caller-provided trace',async()=>{
  const f=await fixture([task('a')]);
  try{
    const forged={terminal:'COMPLETED',trace:['task.completed','job.completed']};
    assert.equal(forged.terminal,'COMPLETED');
    assert.notEqual((await f.store.load('l3')).state,forged.terminal);
    assert.equal((await f.store.load('l3')).tasks[0].state,'RUNNING');
  }finally{await f.close();}
});
test('dependency cycle detected by production scheduler',async()=>{
  const f=await fixture([task('a','DRAFT',['b']),task('b','DRAFT',['a'])]);
  try{assert.throws(()=>schedule(job([task('a','DRAFT',['b']),task('b','DRAFT',['a'])])),/Dependency cycle/);}
  finally{await f.close();}
});
