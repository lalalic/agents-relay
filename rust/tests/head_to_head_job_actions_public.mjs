// All 4 original Node public Job Activate/Cancel API symbols, including the
// two durable action IDs; exact Graph decisions, side effects and failure gates.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {applyJobActivateAction,applyJobCancelAction,JOB_ACTIVATE_ACTION,JOB_CANCEL_ACTION} from '../../dist/job-actions.js';
const root=resolve(import.meta.dirname,'../..');const bin=resolve(root,'rust/target/debug/relay-rust2-parity');
const at='2026-11-18T00:00:00.000Z';
function job(state,taskState,planState){return {id:'17',repository:'fixture',title:'Graph Job',
  state,priority:'P2',prNumber:0,createdAt:at,updatedAt:at,
  tasks:[{id:'2',jobId:'17',kind:'work',agentName:'builder',state:taskState,
    attempt:1,maxAttempts:2,leaseOwner:taskState==='RUNNING'?'host':null,
    leaseExpiresAt:taskState==='RUNNING'?'2099-01-01T00:00:00.000Z':null,
    executionId:taskState==='RUNNING'?'gen-1':null,updatedAt:at,createdAt:at}],
  plans:[{id:'plan-1',status:planState,updatedAt:at,createdAt:at,
    leaseOwner:planState==='PLANNING'?'owner':null,
    leaseExpiresAt:planState==='PLANNING'?'2099-01-01T00:00:00.000Z':null,
    executionId:planState==='PLANNING'?'gen-2':null}]};}
function norm(value){if(typeof value==='string' && /^20\d\d-\d\d-\d\dT/.test(value))return '<time>';
 if(Array.isArray(value))return value.map(norm);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,v])=>[key,norm(v)]));return value;}
async function node(req){
 let current=structuredClone(req.job);
 const store={mutateJob:async(_id,mutate)=>{current=structuredClone(await mutate(structuredClone(current)));return current},
  savePlan:async()=>{},saveTask:async()=>{},saveJob:async job=>{current=job}};
 try{let value;
 if(req.action==='activate')value=await applyJobActivateAction(current);
 else value=await applyJobCancelAction(store,current,req.reason);
 return {ok:true,value:norm(value)};
 }catch(error){return {ok:false,error:error.message}}
}
const cases=[];
for(const state of ['DRAFT','ACTIVE','PAUSED','COMPLETED','CANCELLED','FAILED'])
 for(const taskState of ['DRAFT','QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED'])
  for(const planState of ['PLANNING','SUCCEEDED'])
   for(const action of ['activate','cancel'])
    cases.push({op:'certJobActions',action,reason:'cancel fixture',job:job(state,taskState,planState)});
test('Node/Rust durable Job action ids, activate/cancel, 144 state+Task/Plan negative scenarios',async()=>{
 assert.equal(JOB_ACTIVATE_ACTION,'job.activate');assert.equal(JOB_CANCEL_ACTION,'job.cancel');
 const expected=await Promise.all(cases.map(node));
 const proc=spawnSync(bin,[],{cwd:root,input:cases.map(JSON.stringify).join('\n')+'\n',encoding:'utf8',timeout:90000,maxBuffer:20e6});
 assert.equal(proc.status,0,proc.stderr||proc.error?.message);
 const result=proc.stdout.trim().split('\n').map(JSON.parse);assert.equal(result.length,cases.length);
 for(let i=0;i<cases.length;i++){
  const actual={...result[i]};if(actual.ok)actual.value=norm(actual.value);
  assert.deepEqual(actual,expected[i],`Case ${i}: ${JSON.stringify(cases[i])}\nRust=${JSON.stringify(actual)} Node=${JSON.stringify(expected[i])}`);
 }
 console.log(`Direct original Node/Rust Job activate/cancel parity: ${cases.length} Graph cases`);
});
