import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { InMemoryStore } from '../dist/store.js';
import { RepositoryWorkerPool, activeWorkerSlots } from '../dist/pool.js';
import { MemoryEventBus, eventFor } from '../dist/events.js';

const stamp='2026-11-11T14:00:00Z';
const base={repository:'local/agent-graph',state:'ACTIVE',createdAt:stamp,updatedAt:stamp,
  autoMerge:true,reviewEnabled:false,prNumber:0,priority:'P2',plans:[],pause:false};
const task=(id,state,extra={})=>({id,jobId:'dag',state,createdAt:stamp,updatedAt:stamp,
  kind:'work',adapter:'script',dependencies:[],parentTaskId:null,
  executionId:null,leaseOwner:null,leaseExpiresAt:null,...extra});
const root=()=>task('coordinator','RUNNING',{title:'Coordinator',agentGraph:'flowchart TD\nA[agent:first] --> B[agent:second]',
  result:{data:{dag:{version:1,graphHash:'stable'}}}});
const child=(id,state,extra={})=>task(id,state,{parentTaskId:'coordinator',
  dagNode:{nodeId:id,parentTaskId:'coordinator',graphHash:'stable',executor:'script'},...extra});
const overview=job=>({job,githubState:'UNKNOWN',draft:false,mergedAt:null,closedAt:null});
const leased=(id)=>({executionId:`execution-${id}`,leaseOwner:'relay',leaseExpiresAt:'2099-01-01T00:00:00Z'});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async(fn,msg)=>{for(let i=0;i<100;i++){const value=await fn();if(value)return value;await sleep(3)}throw Error('Timeout: '+msg)};

test('Coordinator occupies no Worker slot; DAG branches count their real leased Workers',()=>{
 const job={...base,id:'dag',tasks:[root(),child('A','RUNNING',leased('A')),
   child('B','RUNNING',leased('B')),child('C','AWAITING_DECISION')]};
 assert.equal(activeWorkerSlots(job),2);
 assert.equal(activeWorkerSlots({...job,tasks:[root(),child('A','SUCCEEDED'),child('B','AWAITING_DECISION')]}),0);
 const ordinary={...base,id:'normal',tasks:[task('work','RUNNING',leased('work'))]};
 assert.equal(activeWorkerSlots(ordinary),1,'non-DAG jobs retain old one-slot accounting');
});

test('DAG terminal wake goes directly into its Job Reconciler with capacity before global scheduler',async()=>{
 const dag={...base,id:'dag',tasks:[root(),child('A','SUCCEEDED'),child('B','QUEUED')]};
 const unrelated={...base,id:'other',priority:'P0',tasks:[task('other-task','QUEUED',{jobId:'other'})]};
 const stores=new Map([['dag',new InMemoryStore(dag)],['other',new InMemoryStore(unrelated)]]);
 const calls=[];
 const inventory=async()=>Promise.all([...stores].map(async([id,store])=>overview(await store.load(id))));
 const pool=new RepositoryWorkerPool(2,(_store,capacity)=>({
  reconcile:async id=>{calls.push({id,capacity})},
 }),inventory,async id=>stores.has(id)?{job:await stores.get(id).load(id),store:stores.get(id)}:null);
 await pool.reconcileLocalJob('dag','task.completed');
 assert.deepEqual(calls[0],{id:'dag',capacity:2},'DAG successor must launch before priority-based global queue');
 assert.equal(calls.some(c=>c.id==='other'),true,'unrelated Jobs may still use remaining pool slots');
});

test('DAG direct continuation respects an occupied global Worker slot',async()=>{
 const dag={...base,id:'dag',tasks:[root(),child('A','SUCCEEDED'),child('B','QUEUED')]};
 const other={...base,id:'other',tasks:[task('other-task','RUNNING',{jobId:'other',...leased('other')})]};
 const stores=new Map([['dag',new InMemoryStore(dag)],['other',new InMemoryStore(other)]]);
 const calls=[];
 const inventory=async()=>Promise.all([...stores].map(async([id,store])=>overview(await store.load(id))));
 const pool=new RepositoryWorkerPool(1,(_store,capacity)=>({reconcile:async id=>calls.push([id,capacity])}),
  inventory,async id=>stores.has(id)?{job:await stores.get(id).load(id),store:stores.get(id)}:null);
 await pool.reconcileLocalJob('dag','task.completed');
 assert.deepEqual(calls,[['dag',0]],'No capacity must leave the successor durably queued');
});

test('real Task completion event immediately continues DAG from SQLite result without timer',async()=>{
 const dag={...base,id:'dag',tasks:[root(),child('A','RUNNING',leased('A')),child('B','QUEUED')]};
 const store=new InMemoryStore(dag),bus=new MemoryEventBus(),calls=[];
 const pool=new RepositoryWorkerPool(1,(_store,capacity)=>({
  applyEvent:async event=>{
   if(event.type==='task.completed'){
    const j=await store.load('dag');const t=j.tasks.find(x=>x.id===event.task_id);
    t.state='SUCCEEDED';t.executionId=null;t.leaseOwner=null;t.leaseExpiresAt=null;
    await store.saveTask(t);return {applied:true,reconcile:true};
   }
   return {applied:false,reconcile:false};
  },
  reconcile:async id=>calls.push([id,capacity]),
 }),async()=>[overview(await store.load('dag'))],
 async id=>id==='dag'?{job:await store.load(id),store}:null);
 const stop=await pool.watch(bus);
 try{
  await bus.publish(eventFor('dag','A','coordinator','task.completed','succeeded','Agent A finished','orchestrator'));
  await until(()=>calls.length>0,'DAG successor');
  assert.deepEqual(calls[0],['dag',1]);
  assert.equal((await store.load('dag')).tasks.find(t=>t.id==='A').state,'SUCCEEDED');
 }finally{await stop()}
});

test('interactive human approval/revision resumes DAG directly without polling or second scheduler',async()=>{
 const dag={...base,id:'dag',tasks:[root(),child('A','AWAITING_DECISION')]};
 const store=new InMemoryStore(dag),bus=new MemoryEventBus(),calls=[];
 const pool=new RepositoryWorkerPool(1,(_store,capacity)=>({
  applyEvent:async event=>{
   if(event.type==='task.interactive_decision'){
    const j=await store.load('dag');const t=j.tasks.find(x=>x.id==='A');
    t.state='QUEUED';await store.saveTask(t);
    return {applied:true,reconcile:true};
   }
   return {applied:false,reconcile:false};
  },reconcile:async id=>calls.push([id,capacity]),
 }),async()=>[overview(await store.load('dag'))],
 async id=>id==='dag'?{job:await store.load(id),store}:null);
 const stop=await pool.watch(bus);
 try{
  await bus.publish(eventFor('dag','A','coordinator','task.interactive_decision','running','Approved','orchestrator'));
  await until(()=>calls.length>0,'Review resume');
  assert.deepEqual(calls[0],['dag',1]);
  assert.equal((await store.load('dag')).tasks.find(t=>t.id==='A').state,'QUEUED');
 }finally{await stop()}
});


test('cancelled Job with stale execution metadata never consumes DAG continuation capacity',async()=>{
 const dag={...base,id:'dag',tasks:[root(),child('A','SUCCEEDED'),child('B','QUEUED')]};
 const cancelled={...base,id:'cancelled',state:'CANCELLED',tasks:[task('stale','RUNNING',{jobId:'cancelled',...leased('stale')})]};
 const stores=new Map([['dag',new InMemoryStore(dag)],['cancelled',new InMemoryStore(cancelled)]]);
 const calls=[];
 const inventory=async()=>Promise.all([...stores].map(async([id,store])=>overview(await store.load(id))));
 const pool=new RepositoryWorkerPool(1,(_store,capacity)=>({reconcile:async id=>calls.push([id,capacity])}),
  inventory,async id=>stores.has(id)?{job:await stores.get(id).load(id),store:stores.get(id)}:null);
 await pool.reconcileLocalJob('dag','task.completed');
 assert.deepEqual(calls[0],['dag',1],'stale terminal Job cannot throttle a live DAG');
});
