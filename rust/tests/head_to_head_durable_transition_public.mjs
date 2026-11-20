// Real original Node public DurableTaskTransitionRuntime vs native Rust port,
// using the same workflow/task-lifecycle.mmd and isolated in-memory Store
// adapters. Persistence is checked separately in native SQLite integration.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {DurableTaskTransitionRuntime} from '../../dist/workflow/durable-transition.js';
const root=resolve(import.meta.dirname,'../..');
const bin=join(root,'rust/target/debug/relay-rust2-parity');
const stamp='2026-11-19T00:00:00.000Z';
const future='2099-06-20T12:00:00.000Z';
const job=(state,updatedAt=stamp)=>({
 id:'17',repository:'fixture',prNumber:0,projectRoot:'/tmp/fixture',
 state:'ACTIVE',plans:[],tasks:[{id:'2',jobId:'17',title:'Task',kind:'work',
  agentName:'developer',state,attempt:1,maxAttempts:2,
  leaseOwner:null,leaseExpiresAt:null,executionId:null,
  updatedAt,createdAt:stamp,dependencies:[]}]
});
const cases=[
 {job:job('DRAFT'),event:'release'},
 {job:job('DRAFT'),event:'cancel'},
 {job:job('DRAFT'),event:'bogus'},
 {job:job('QUEUED'),event:'task.started'},
 {job:job('QUEUED'),event:'fail'},
 {job:job('QUEUED'),event:'worker.delivery_failed'},
 {job:job('RUNNING'),event:'task.completed',facts:{sourceDeliveryVerified:true}},
 {job:job('RUNNING'),event:'cancel'},
 {job:job('FAILED'),event:'retry',facts:{retryAvailable:true}},
 {job:job('SUCCEEDED'),event:'task.completed'},
 {job:job('DRAFT'),event:'release',eligible:false},
 {job:job('RUNNING'),event:'cancel',saveError:'SQLite write denied'},
 {job:job('QUEUED',future),event:'task.started'},
 {job:job('QUEUED',future),event:'task.started',mutate:false},
 {job:job('RUNNING'),method:'updateFact',requiredState:'RUNNING'},
 {job:job('QUEUED'),method:'updateFact',requiredState:'RUNNING'},
 {job:job('RUNNING',future),method:'updateFact',requiredState:'RUNNING'},
 {job:job('RUNNING'),method:'updateFact',requiredState:'RUNNING',saveError:'SQLite write denied'},
 {job:job('RUNNING'),method:'updateFact',requiredState:'RUNNING',mutate:false},
 {job:job('QUEUED'),event:'cancel',taskId:'missing'},
];
function clean(value){
 if(Array.isArray(value))return value.map(clean);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value)
  .filter(([,v])=>v!==undefined).map(([k,v])=>[k,clean(v)]));
 if(typeof value==='string'&&/^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d/.test(value)&&value!==stamp&&value!==future)return '<timestamp>';
 return value;
}
async function original(c){
 let saved=structuredClone(c.job);
 const store={
  load:async()=>structuredClone(saved),
  saveTask:async(task)=>{
   if(c.saveError)throw Error(c.saveError);
   saved.tasks[saved.tasks.findIndex(v=>v.id===task.id)]=structuredClone(task);
  },
  mutateJob:async(_id,mutator)=>{
   const next=mutator(structuredClone(saved));
   saved=structuredClone(next);
   return structuredClone(saved);
  }
 };
 const runtime=new DurableTaskTransitionRuntime(store);
 let value;
 try{
  if(c.method==='updateFact')
   value=await runtime.updateFact('17',c.taskId??'2',
    task=>c.eligible!==false&&task.state===(c.requiredState??'RUNNING'),
    task=>{if(c.mutate!==false)task.result={status:'finished'};});
  else value=await runtime.apply('17',c.taskId??'2',c.event??'cancel',{
   eligible:()=>c.eligible!==false,
   facts:()=>c.facts??{},
   mutate:async(_job,task,decision)=>{
    if(c.mutate!==false&&decision.accepted)task.result={status:'finished'};
   }
  });
  return clean({ok:true,value,saved});
 }catch(e){return clean({ok:false,error:e.message,saved});}
}
function native(c){
 const r=spawnSync(bin,[],{cwd:root,encoding:'utf8',timeout:10000,
 input:JSON.stringify({op:'certDurableTransition',jobId:'17',taskId:'2',...c})+'\n'});
 assert.equal(r.status,0,r.stderr);
 const decoded=JSON.parse(r.stdout.trim());
 assert.equal(decoded.ok,true,JSON.stringify(decoded));
 return clean(decoded.value);
}
test('DurableTaskTransitionRuntime apply and updateFact original Node/Rust direct parity',async()=>{
 for(let i=0;i<cases.length;i++){
  const c=cases[i];
  assert.deepEqual(native(c),await original(c),JSON.stringify({i,event:c.event,method:c.method,state:c.job.tasks[0].state}));
 }
});
