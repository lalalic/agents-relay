// Direct ReconcilerRuntimeBase original Node class vs Rust Graph-host port.
// No live Relay Job or event service; exact observed event and Store effects.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {ReconcilerRuntimeBase} from '../../dist/reconciler-runtime.js';
const root=resolve(import.meta.dirname,'../..');
const bin=join(root,'rust/target/debug/relay-rust2-parity');
const time='2026-11-18T08:00:00.000Z';
const task=(state='RUNNING',executionId='e1')=>({
 id:'t1',jobId:'41',kind:'work',title:'Work',adapter:'codex',agentName:'worker',
 state,attempt:1,maxAttempts:3,executionId,leaseOwner:'relay',
 leaseExpiresAt:'2026-11-19T08:00:00.000Z',dependencies:[],
 createdAt:time,updatedAt:time
});
const job=(taskState)=>({id:'41',repository:'fixture',prNumber:0,
 state:'ACTIVE',title:'Fixture',createdAt:time,updatedAt:time,
 tasks:taskState?[task(taskState)]:[],plans:[],reviewEnabled:false,
 headSha:null,pause:null});
const ev=(type,job_id='41')=>({type,job_id,task_id:'t1',
 event_id:`event-${type}`,timestamp:time,
 status:'succeeded',message:'Done',source:{id:'system'},data:{}});
const cases=[
 {job:job(),events:[]},
 {job:job(),events:[ev('github.webhook')]},
 {job:job(),events:[ev('job.wake')]},
 {job:job(),events:[ev('other.event')]},
 {job:job(),events:[ev('github.webhook'),ev('other.event'),ev('job.wake')]},
 {job:job(),events:[ev('job.wake'),ev('job.wake')]},
 {job:job(),watch:true,events:[ev('job.wake')]},
 {job:job(),watch:true,events:[ev('other.event'),ev('github.webhook')]},
 {job:job(),watch:true,events:[ev('job.wake')],afterUnsubscribe:ev('job.wake')},
 {job:job(),watch:true,events:[ev('job.wake','another')]},
 {job:job(),events:[],wake:true},
 {job:job(),events:[],reconcile:true},
 {job:job(),events:[],wake:true,reconcile:true},
 {job:job('RUNNING'),events:[],binding:{jobId:'41',task:task('RUNNING'),executionId:'e1'}},
 {job:job('QUEUED'),events:[],binding:{jobId:'41',task:task('QUEUED'),executionId:'e1'}},
 {job:job('RUNNING'),events:[],binding:{jobId:'41',task:task('RUNNING'),executionId:'e-wrong'}},
 {job:job('RUNNING'),events:[],binding:{jobId:'41',task:task('RUNNING'),executionId:'e1'} ,wake:true},
];
const compact=(x)=>JSON.parse(JSON.stringify(x));
const normalize=x=>{
 if(Array.isArray(x))return x.map(normalize);
 if(x&&typeof x==='object')return Object.fromEntries(Object.entries(x)
  .map(([key,value])=>[key,/At$/.test(key)&&typeof value==='string'&&/^20\d\d-/.test(value)?'<time>':normalize(value)]));
 return x;
};
function rust(fixtures){
 const result=spawnSync(bin,[],{cwd:root,encoding:'utf8',timeout:120000,
  input:fixtures.map(f=>JSON.stringify({op:'apiRuntimeBase',root,...f})).join('\n')+'\n'});
 assert.equal(result.status,0,result.stderr||result.error?.message);
 return result.stdout.trim().split('\n').map(JSON.parse).map(entry=>normalize(entry.value));
}
class FixtureRuntime extends ReconcilerRuntimeBase {
 constructor(store,options,calls){super(store,options);this.calls=calls;}
 async reconcile(jobId){this.calls.push(['reconcile',jobId]);return this.store.loadUnsafe();}
 async applyReviewEvent(){return {applied:false,reconcile:false,reason:'review.ignored'};}
}
async function node(f){
 let current=structuredClone(f.job),handler=null;
 const calls=[],errors=[];
 const store={
  loadUnsafe:()=>structuredClone(current),
  load:async id=>{calls.push(['load',id]);return structuredClone(current);},
  loadJob:async id=>{calls.push(['loadJob',id]);return structuredClone(current);},
  mutateJob:async(id,operation)=>{
   calls.push(['mutate',id]);
   const next=await operation(structuredClone(current));
   current=structuredClone(next);
   return structuredClone(current);
  }
 };
 const eventBus=f.watch?{subscribe:async(id,callback)=>{
  handler=async event=>{if(event.job_id===id)await callback(event);};
  return async()=>{handler=null;};
 }}:undefined;
 const instance=new FixtureRuntime(store,{owner:'relay',adapters:[],eventBus,
  emit:async event=>calls.push(['emit',event.type])},calls);
 let unsub=await instance.watch('41');
 for(const e of f.events){
  try{if(f.watch){await handler?.(e);}else await instance.handleEvent(e);}
  catch(error){errors.push(error.message);}
 }
 await instance.idle();
 await unsub();
 if(f.afterUnsubscribe)await handler?.(f.afterUnsubscribe);
 await instance.idle();
 let direct=null;
 if(f.wake)direct=await instance.wake('41');
 if(f.reconcile)direct=await instance.reconcile('41');
 if(f.binding){try{
  const binding=await instance.bindInteractiveInvocation(
   f.binding.jobId,f.binding.task,f.binding.executionId);
  assert.ok(binding.decision instanceof Promise);
 }catch(error){errors.push(error.message);}}
 await instance.idle();
 await instance.close();
 return normalize(compact({calls,job:current,errors,direct,outcomes:[]}));
}
function firstDiff(a,b,path='root'){
 if(typeof a!==typeof b||a===null||b===null)return JSON.stringify(a)===JSON.stringify(b)?null:{path,expected:a,actual:b};
 if(typeof a!=='object')return Object.is(a,b)?null:{path,expected:a,actual:b};
 for(const key of [...new Set([...Object.keys(a),...Object.keys(b)])].sort()){
  if(!(key in a)||!(key in b))return {path:`${path}.${key}`,expected:a[key],actual:b[key]};
  const diff=firstDiff(a[key],b[key],`${path}.${key}`);
  if(diff)return diff;
 }
 return null;
}
test('ReconcilerRuntimeBase real Node vs Rust EventBus, wake, abstract Reconciler and interactive binding',async()=>{
 const expected=[];
 for(const fixture of cases)expected.push(await node(fixture));
 const actual=rust(cases);
 const diffs=[];
 for(let i=0;i<cases.length;i++){
  try{assert.deepEqual(actual[i],expected[i]);}
  catch{diffs.push({i,firstDiff:firstDiff(expected[i],actual[i])});}
 }
 assert.deepEqual(diffs,[],JSON.stringify(diffs,null,2));
 console.log('Verified',cases.length,'Runtime Base Node/Rust scenarios');
});
