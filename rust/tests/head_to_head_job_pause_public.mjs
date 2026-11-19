// Actual Node src/job-pause.ts against the exact native Rust reducer.
// Covers Graph pause, terminal refusals, idempotent resume and durable facts.
// Never opens the live Relay DB; both stores are disposable in-memory snapshots.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {pauseJob,resumeJob} from '../../dist/job-pause.js';
const root=resolve(import.meta.dirname,'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');
const initialStamp='2026-11-18T00:00:00.000Z';
const nowPattern=/20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
function normalize(value){
  // Node and Rust clocks differ, but identical fields and lifecycle results must match.
  return JSON.parse(JSON.stringify(value).replace(nowPattern,'NOW'));
}
let seed=0x7ed491;
function rand(){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;}
const choice=xs=>xs[rand()%xs.length];
const scenarios=[];
for(let n=0;n<160;n++){
  const state=choice(['DRAFT','ACTIVE','ACTIVE','COMPLETED','CANCELLED']);
  const tasks=Array.from({length:rand()%6},(_,i)=>{
    const taskState=choice(['DRAFT','QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED']);
    return {id:String(i+1),jobId:'17',agentName:'developer',
      kind:choice(['work','work','planner']),state:taskState,
      attempt:rand()%6,maxAttempts:rand()%5,
      executionId:rand()%3===0?null:'exec-'+i,
      leaseOwner:'fixture',leaseExpiresAt:initialStamp,
      input:'work',updatedAt:initialStamp,createdAt:initialStamp};
  });
  const plans=Array.from({length:rand()%4},(_,i)=>({
    id:String(i+100),jobId:'17',
    status:choice(['PLANNING','SUCCEEDED','FAILED','PENDING']),
    executionId:rand()%2===0?'plan-ex-'+i:null,
    leaseOwner:'planner',leaseExpiresAt:initialStamp,updatedAt:initialStamp}));
  const job={id:'17',repository:'fixture',projectRoot:'/tmp/fixture',
    state,tasks,plans,createdAt:initialStamp,updatedAt:initialStamp};
  if(rand()%5===0){job.pause={generation:1,requestedAt:initialStamp};}
  scenarios.push({op:'certJobPauseResume',method:choice(['pause','pause','resume']),job});
}
for(const state of ['ACTIVE','DRAFT','COMPLETED','CANCELLED']){
  scenarios.push({op:'certJobPauseResume',method:'pause',
    job:{id:'17',state,tasks:[],plans:[]}});
  scenarios.push({op:'certJobPauseResume',method:'resume',
    job:{id:'17',state,tasks:[],plans:[],pause:{generation:1,requestedAt:initialStamp}}});
}
async function nodeResponse(f){
  let current=structuredClone(f.job);
  const store={mutateJob:async(id,mutate)=>{
    assert.equal(id,'17');current=mutate(current);return structuredClone(current);
  }};
  try{
    const result=await (f.method==='pause' ? pauseJob(store,'17'):resumeJob(store,'17'));
    return {ok:true,value:normalize(result)};
  }catch(error){return {ok:false,error:error.message};}
}
test('168 original Node/Rust Graph and SQLite job pause/resume outcome fixtures',async()=>{
  const expected=[];
  for(const f of scenarios)expected.push(await nodeResponse(f));
  const result=spawnSync(binary,[],{cwd:root,
    input:scenarios.map(JSON.stringify).join('\n')+'\n',
    encoding:'utf8',maxBuffer:20*1024*1024,timeout:90000});
  assert.equal(result.status,0,result.stderr||result.error?.message);
  const rust=result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(rust.length,expected.length);
  const errors=[];
  for(let i=0;i<rust.length;i++){
    const value=rust[i].ok?{ok:true,value:normalize(rust[i].value)}:rust[i];
    try{assert.deepEqual(value,expected[i]);}
    catch{errors.push({i,method:scenarios[i].method,
      initial:scenarios[i].job,expected:expected[i],actual:value});}
  }
  assert.deepEqual(errors.slice(0,3),[],`${errors.length} mismatched pause/resume cases`);
  console.log('Verified',scenarios.length,'original Node/Rust pause and resume cases');
});
