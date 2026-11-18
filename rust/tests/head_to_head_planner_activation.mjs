import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const wt=resolve(import.meta.dirname,'../..');
const {activateCommittedPlannerWork,PlannerApplyValidationError}=await import(pathToFileURL(wt+'/dist/planner-runtime.js'));
const fixture=[];let seed=0x133715;function rnd(){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;}
const pick=x=>x[rnd()%x.length];
for(let i=0;i<250;i++){
 const n=rnd()%4;const tasks=Array.from({length:n},(_,k)=>({id:String(k),state:pick(['QUEUED','DRAFT','COMPLETED','FAILED','RUNNING','AWAITING_DECISION'])}));
 const job={id:'J'+i,state:pick(['DRAFT','ACTIVE','COMPLETED','CANCELLED','PAUSED']),updatedAt:'2026-11-17T22:00:00.000Z',tasks};
 fixture.push({op:'activation',job});
}
for(const phase of ['candidate','history_consistency','forward_convergence','fencing'])
 for(const issues of [[],['missing'],['bad "quote"','unicode 测试'],['line\nbreak','slash\\path']])
  for(const retryable of [undefined,true,false])fixture.push({op:'error',phase,issues,retryable});
function normalize(record,original){
 const value=structuredClone(record);
 if(value?.job?.updatedAt!==original?.job?.updatedAt)value.job.updatedAt='NORMALIZED';
 return JSON.parse(JSON.stringify(value));
}
async function original(f){
 if(f.op==='error'){
  const err=new PlannerApplyValidationError(f.phase,f.issues,f.retryable);
  return {name:err.name,code:err.code,phase:err.phase,retryable:err.retryable,
   issues:err.issues,message:err.message};
 }
 const job=structuredClone(f.job);
 let outcome;
 try{outcome={ok:true,value:activateCommittedPlannerWork(job)};}
 catch(error){outcome={ok:false,error:error.message};}
 return {outcome,job};
}
const expected=[];for(const f of fixture)expected.push(normalize(await original(f),f));
const bin=wt+'/rust/target/debug/relay-rust2-parity';
const run=spawnSync(bin,[],{input:fixture.map(f=>JSON.stringify({...f,method:f.op,op:'plannerRuntimePublicParity'})).join('\n')+'\n',encoding:'utf8',timeout:120000,maxBuffer:30*1024*1024});
assert.equal(run.status,0,run.stderr);
const actual=run.stdout.trim().split('\n').map(JSON.parse).map(x=>x.ok?x.value:x);
assert.equal(actual.length,fixture.length);
const mismatches=[];
for(let i=0;i<fixture.length;i++){
 const result=normalize(actual[i],fixture[i]);
 try{assert.deepEqual(result,expected[i]);}
 catch{mismatches.push({index:i,fixture:fixture[i],node:expected[i],rust:result});}
}
if(mismatches.length){
 console.log('MISMATCHES',mismatches.length);
 for(const d of mismatches.slice(0,7))console.log('DIFF',JSON.stringify(d).slice(0,4400));
 process.exitCode=1;
}else console.log('DIRECT_NODE_RUST_PLANNER_ACTIVATION_PASS',fixture.length);
