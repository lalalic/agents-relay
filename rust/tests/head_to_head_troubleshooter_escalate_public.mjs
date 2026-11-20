// Original src/troubleshooter-fallback.ts escalateExhaustedTroubleshooters
// versus native Rust public API using canonical Graph reduction in both.
// Only isolated in-memory Jobs: no provider, live SQLite or HTTP calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {escalateExhaustedTroubleshooters} from '../../dist/troubleshooter-fallback.js';
const root=resolve(import.meta.dirname,'../..');
const bin=resolve(root,'rust/target/debug/relay-rust2-parity');
const stamp='2026-11-19T00:00:00.000Z';
const original=()=>({
 id:'7',jobId:'15',title:'Worker failed',kind:'work',
 agentName:'implementation',adapter:'script',state:'FAILED',
 attempt:3,maxAttempts:3,dependencies:[],error:'remote service unavailable',
 executionId:null,leaseOwner:null,leaseExpiresAt:null,
 createdAt:stamp,updatedAt:stamp,input:'Original work'
});
const recovery=(id='8')=>({
 id,jobId:'15',title:'Troubleshooter',kind:'work',
 agentName:'troubleshooter',adapter:'codex',state:'FAILED',
 attempt:3,maxAttempts:3,parentTaskId:'7',dependencies:[],
 error:'worker_process_failed',input:'Diagnose failure',
 executionId:null,leaseOwner:null,leaseExpiresAt:null,
 createdAt:stamp,updatedAt:stamp
});
const job=(over={})=>({
 id:'15',repository:'fixture',state:'ACTIVE',
 title:'Restore actual worker',reviewEnabled:false,plans:[],
 tasks:[original(),recovery()],createdAt:stamp,updatedAt:stamp,
 ...over
});
const fixtures=[
 {name:'basic failed work',job:job()},
 {name:'idempotent after already escalated',job:job({
  tasks:[original(),{...recovery(),state:'BLOCKED',
   escalation:{id:'existing-human-esc',status:'pending',fingerprint:'stable'}}]})},
 {name:'not yet exhausted',job:job({tasks:[original(),{...recovery(),attempt:2}]})},
 {name:'not failed original',job:job({tasks:[{...original(),state:'RUNNING'},recovery()]})},
 {name:'blocked on same job',job:job({tasks:[{
  ...original(),resolution:{path:'same_job_dependency',state:'active'}},recovery()]})},
 {name:'terminal cancelled Job',job:job({state:'CANCELLED'})},
 {name:'terminal completed Job',job:job({state:'COMPLETED'})},
 {name:'no recovery',job:job({tasks:[original()]})},
 {name:'Plan recovery',job:job({tasks:[{
  ...recovery(),parentTaskId:undefined,recoveryPlanId:'plan-1'}],
  plans:[{id:'plan-1',status:'FAILED',error:'planner provider unavailable'}]})},
 {name:'FAILED Plan already recovered',job:job({tasks:[{
  ...recovery(),parentTaskId:undefined,recoveryPlanId:'plan-1'}],
  plans:[{id:'plan-1',status:'SUCCEEDED'}]})},
 {name:'two independent failed recoveries',job:job({
  tasks:[original(),recovery(),{
   ...original(),id:'9',title:'Second failed work',error:'second provider unavailable'},
   {...recovery('10'),parentTaskId:'9',error:'worker_start_timeout'}]})},
 {name:'only PLAN failed but original succeeded',job:job({
  tasks:[{...original(),state:'SUCCEEDED'},{
   ...recovery(),recoveryPlanId:'plan-2'}],
  plans:[{id:'plan-2',status:'FAILED',error:'Plan failed'}]})}
];
function normalize(value){
 const recur=(v)=>{
  if(Array.isArray(v))return v.map(recur);
  if(v&&typeof v==='object')
   return Object.fromEntries(Object.entries(v).filter(([,item])=>item!==undefined)
    .map(([key,item])=>[key,recur(item)]));
  if(typeof v==='string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(v))return '<timestamp>';
  if(typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v))
   return '<uuid>';
  return v;
 };
 return recur(value);
}
async function originalRuntime(fixture){
 let current=structuredClone(fixture.job);
 const store={
  load:async()=>structuredClone(current),
  mutateJob:async(_jobId,update)=>{
   current=structuredClone(await update(structuredClone(current)));
   return structuredClone(current);
  }
 };
 try{
  const escalated=await escalateExhaustedTroubleshooters(store,'15');
  return normalize({ok:true,value:{escalated,job:current}});
 }catch(error){return normalize({ok:false,error:error.message});}
}
function nativeRuntime(fixture){
 const proc=spawnSync(bin,[],{cwd:root,encoding:'utf8',timeout:20000,
  input:JSON.stringify({
   op:'escalateExhaustedTroubleshooters',root,job:fixture.job
  })+'\n'});
 assert.equal(proc.status,0,proc.stderr);
 return normalize(JSON.parse(proc.stdout.trim()));
}
test('original Node/Rust full exhausted Troubleshooter escalation public method',async()=>{
 for(const fixture of fixtures){
  const expected=await originalRuntime(fixture);
  const actual=nativeRuntime(fixture);
  assert.deepEqual(actual,expected,fixture.name);
 }
});
