import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {SQLiteRelayStore} from '../../dist/relay-store.js';
import {decideReviewLifecycle} from '../../dist/workflow/review-v2.js';
import {reviewWorkSettled,reviewPlanReady} from '../../dist/review-replan.js';
const exe=resolve(import.meta.dirname,'../target/debug/agents-relay-rust');
const stamp='2026-11-13T20:00:00.000Z';
function task(id,agentName,state){return {jobId:'91',id,kind:'work',agentName,parentTaskId:null,dependencies:[],
 state,adapter:'script',capabilities:[],input:'run',attempt:0,maxAttempts:3,leaseOwner:null,
 leaseExpiresAt:null,executionId:null,error:null,result:null,timeoutMs:30000,createdAt:stamp,updatedAt:stamp};}
function basic(dir){return {id:'91',repository:'example',projectRoot:dir,prNumber:0,state:'ACTIVE',
 createdAt:stamp,updatedAt:stamp,reviewEnabled:true,plans:[],tasks:[task('101','editor','SUCCEEDED')]};}
function inspect(db){
 const result=spawnSync(exe,['review','inspect','--db',db,'--job-id','91','--verified-local-head','sha-verified'],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
}
const variants=[
 ['ready',j=>j,true],
 ['still executing',j=>{j.tasks[0].state='RUNNING';return j;},false],
 ['plan still planning',j=>{j.plans=[{status:'PLANNING'}];return j;},false],
 ['cancelled Job',j=>{j.state='CANCELLED';return j;},false],
 ['review disabled',j=>{j.reviewEnabled=false;return j;},false],
 ['active Reviewer',j=>{j.review={outcome:'pending',headSha:'sha-verified',taskId:'102'};
   j.tasks.push({...task('102','job-acceptance-reviewer','RUNNING'),reviewHeadSha:'sha-verified'});return j;},false],
 ['approved head already reviewed',j=>{j.review={outcome:'approved',headSha:'sha-verified',taskId:'102'};
   j.tasks.push({...task('102','reviewer','SUCCEEDED'),reviewHeadSha:'sha-verified'});return j;},false],
 ['approved old head cannot silently re-review',j=>{j.review={outcome:'approved',headSha:'sha-old',taskId:'102'};
   j.tasks.push({...task('102','reviewer','SUCCEEDED'),reviewHeadSha:'sha-old'});return j;},false],
 ['STALE head, allowed to review new immutable head',j=>{j.review={outcome:'stale',headSha:'sha-old',taskId:'102'};
   j.tasks.push({...task('102','reviewer','CANCELLED'),reviewHeadSha:'sha-old'});return j;},true],
 ['FAILED work awaiting Troubleshooter creation',j=>{j.tasks[0].state='FAILED';j.tasks[0].attempt=1;return j;},false],
 ['FAILED work with active Troubleshooter',j=>{j.tasks[0].state='FAILED';j.tasks[0].attempt=1;
   j.tasks.push({...task('102','troubleshooter','RUNNING'),parentTaskId:'101',recoveryForAttempt:1});return j;},false],
 ['changes required without review fix plan',j=>{j.review={outcome:'changes_required',headSha:'sha-verified',taskId:'102'};
   j.tasks.push({...task('102','reviewer','SUCCEEDED'),reviewHeadSha:'sha-verified'});return j;},false],
];
test('Rust Final Review graph gates agree with TypeScript action selection on 12 deterministic durable states',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-rust-review-parity-'));const db=join(dir,'relay.sqlite');let store;
 try{
  store=new SQLiteRelayStore(db);
  for(const [label,alter,allowed] of variants){
   const snapshot=alter(basic(dir));
   await store.saveJob(snapshot);
   const native=inspect(db);
   assert.equal(native.allowed,allowed,label);
   assert.equal(native.facts.reviewWorkSettled,reviewWorkSettled(snapshot),label+' settled fact parity');
   assert.equal(native.facts.reviewPlanReady,reviewPlanReady(snapshot),label+' plan fact parity');
   const outcome=snapshot.review?.outcome;
   const ts=decideReviewLifecycle(outcome,'reconcile',native.facts);
   assert.equal(native.source,outcome?.toUpperCase()??'NONE',label);
   assert.deepEqual(native.actions.map(action=>action.id),(ts.actions??[]).map(action=>action.id??action),label+' action parity');
   if(ts.accepted)assert.equal(native.target,ts.target,label+' target parity');
   else assert.equal(native.target,null,label+' rejected parity');
   assert.ok(!native.actions.some(action=>action.id==='review.requestMerge'),'no fabricated merge action');
  }
  console.log('Final Review Graph parity: 12 cases, verified immutable head, no duplicate reviewer or fabricated merge');
 }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});
