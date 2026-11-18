// Real Node ReconcilerRuntimeBase.applyEvent vs native Graph/SQLite host.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {ReconcilerRuntimeBase} from '../../dist/reconciler-runtime.js';
const root=resolve(import.meta.dirname,'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');
const date='2026-11-17T10:00:00.000Z';
const task=(state='QUEUED')=>({id:'t1',jobId:'41',kind:'work',agentName:'worker',
 adapter:'codex',title:'Work',state,executionId:'e1',leaseOwner:'relay',
 leaseExpiresAt:'2026-11-19T00:00:00.000Z',attempt:1,maxAttempts:3,
 dependencies:[],createdAt:date,updatedAt:date,
 executionHistory:[{id:'e1',startedAt:date,attempt:1}]});
const job=()=>({id:'41',repository:'fixture',prNumber:0,state:'ACTIVE',
 headSha:null,reviewEnabled:false,tasks:[task()],plans:[],
 createdAt:date,updatedAt:date});
const event=(type,source='system')=>({version:1,
 event_id:`evt-${type}`,job_id:'41',task_id:'t1',type,timestamp:date,
 status:'running',message:'Event',source:{id:source},data:{}});
const source='job/41/task/t1/execution/e1';
const cases=[
 {events:[event('unknown')]},
 {events:[event('github.webhook')]},
 {events:[event('job.wake')]},
 {events:[event('task.started',source)]},
 {events:[event('task.started','job/41/task/t1/execution/other')]},
 {events:[event('task.progress',source)]},
 {events:[event('task.progress','job/41/task/t1/execution/wrong')]},
 {events:[event('task.failed',source)]},
 {events:[event('task.completed',source)]},
 {events:[event('task.completed','job/41/task/t1/execution/wrong')]},
 {events:[event('task.blocked',source)]},
 {events:[event('task.interactive_waiting',source)]},
 {events:[event('job.wake'),event('unknown'),event('github.webhook')]},
 ];
class Fixture extends ReconcilerRuntimeBase {
 constructor(store){super(store,{owner:'relay',adapters:[]});}
 async reconcile(){return this.store.load('41');}
 async applyReviewEvent(){return {applied:false,reconcile:false,reason:'review.ignored'};}
}
function normalize(value){
 if(Array.isArray(value))return value.map(normalize);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value)
   .map(([key,v])=>[key,/At$/.test(key)&&typeof v==='string'&&/^20\d\d-/.test(v)?'<time>':normalize(v)]));
 return value;
}
async function node(f){
 let current=job(),calls=[],errors=[],outcomes=[];
 const store={
  load:async(id)=>{calls.push(['load',id]);return structuredClone(current);},
  saveTask:async value=>{
   calls.push(['saveTask',value.id]);
   const idx=current.tasks.findIndex(task=>task.id===value.id);
   if(idx>=0)current.tasks[idx]=structuredClone(value);
  },
  mutateJob:async(id,fn)=>{
   calls.push(['mutate',id]);current=structuredClone(await fn(structuredClone(current)));
   return structuredClone(current);
  }
 };
 const instance=new Fixture(store);
 for(const event of f.events){
  try{outcomes.push(await instance.applyEvent(event));}
  catch(error){errors.push(error.message);}
 }
 await instance.close();
 return normalize(JSON.parse(JSON.stringify({job:current,errors,outcomes})));
}
function rust(fixtures){
 const result=spawnSync(binary,[],{cwd:root,encoding:'utf8',timeout:120000,
  input:fixtures.map(f=>JSON.stringify({op:'apiRuntimeBase',root,
    job:job(),directApply:true,...f})).join('\n')+'\n'});
 assert.equal(result.status,0,result.stderr||result.error?.message);
 return result.stdout.trim().split('\n').map(JSON.parse).map(v=>normalize(v.value));
}
function firstDiff(a,b,path='root'){
 if(typeof a!==typeof b||a===null||b===null)return JSON.stringify(a)===JSON.stringify(b)?null:{path,expected:a,actual:b};
 if(typeof a!=='object')return Object.is(a,b)?null:{path,expected:a,actual:b};
 for(const key of [...new Set([...Object.keys(a),...Object.keys(b)])].sort()){
  if(!(key in a)||!(key in b))return {path:`${path}.${key}`,expected:a[key],actual:b[key]};
  const diff=firstDiff(a[key],b[key],`${path}.${key}`);if(diff)return diff;
 }return null;
}
test('ReconcilerRuntimeBase.applyEvent Graph, generation and EventHandlingResult',async()=>{
 const actual=rust(cases);
 const expected=[];for(const f of cases)expected.push(await node(f));
 const failures=[];
 for(let i=0;i<cases.length;i++){
  const a={job:actual[i].job,errors:actual[i].errors,outcomes:actual[i].outcomes};
  const b=expected[i];
  try{assert.deepEqual(a,b)}catch{failures.push({i,difference:firstDiff(b,a)});}
 }
 assert.deepEqual(failures,[],JSON.stringify(failures,null,2));
 console.log('Verified',cases.length,'ReconcilerRuntimeBase direct applyEvent Node/Rust cases');
});
