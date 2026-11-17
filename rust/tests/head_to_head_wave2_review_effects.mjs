// Differential of mutations/callback fences against actual Node sources, isolated fixtures only.
// No Job/Relay production state touched and no Codex execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {settleReviewRevisionRound} from '../../dist/review-revision-settlement.js';
import {staleReviewRevisions} from '../../dist/review-revision-stale.js';
import {fallbackFailedTroubleshooters} from '../../dist/troubleshooter-fallback.js';
import {createFailedPlanRecovery} from '../../dist/planner-recovery.js';
const root=process.cwd();
const bin=resolve(root,'rust/target/debug/relay-rust2-parity');
const clone=structuredClone;
function rust(op,payload){const r=spawnSync(bin,[],{input:JSON.stringify({op,...payload})+'\n',encoding:'utf8'});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout.trim())}
function normalize(value){
 if(typeof value==='string' && /^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value))return '<timestamp>';
 if(Array.isArray(value))return value.map(normalize);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined).map(([k,v])=>[k,normalize(v)]));
 return value;
}
async function store(initial){
 let job=clone(initial);
 return {load:async()=>clone(job),mutateJob:async (_id,mutate)=>{job=mutate(job);return clone(job)},saveTask:async task=>{const at=job.tasks.findIndex(t=>t.id===task.id);if(at>=0)job.tasks[at]=clone(task)},current:()=>clone(job)};
}
test('review settlement: reviewer head/round/revision status fenced by Graph',async()=>{
 for(const kind of ['missing','review-approved','targeted-unverified','targeted-verified','limit-reached']){
   const j={id:'1',state:'ACTIVE',review:{outcome:'changes_required',revisionDisposition:'targeted',taskId:'r',headSha:'h'},
     tasks:[{id:'r',state:'SUCCEEDED',kind:'work',agentName:'reviewer',comments:[]},{id:'t',state:'SUCCEEDED',kind:'work'}],
     reviewRevisionRequests:[{reviewTaskId:'r',revisionTaskId:'t',status:'verified',requestId:'q',findings:[{summary:'failed'}]}],
     reviewRevisionRounds:[{reviewTaskId:'r',status:'changes_required',recordedAt:'2026-01-01',requestIds:['q']}]};
   if(kind==='missing')j.review.taskId='missing';
   if(kind==='review-approved')j.review.outcome='approved';
   if(kind==='targeted-unverified')j.reviewRevisionRequests[0].status='failed';
   if(kind==='limit-reached')for(let i=0;i<6;i++)j.reviewRevisionRounds.push({reviewTaskId:'r'+i,status:'changes_required',recordedAt:'2026-01-01',requestIds:['q']});
   const s=await store(j);let error;
   try{await settleReviewRevisionRound(s,j)}catch(e){error=e.message}
   const rv=rust('settleReviewRevisionRound',{root,job:j});
   if(error){assert.deepEqual(rv,{ok:false,error},kind);continue;}
   assert.equal(rv.ok,true,rv.error);
   assert.deepEqual(normalize(rv.value.job),normalize(s.current()),kind);
 }
});
test('stale targeted revisions: generation fences and cancel callback order',async()=>{
 for(const kind of ['head-changed','execution-changed','unaffected','active-generation-blocked']){
   const j={id:'1',state:'ACTIVE',review:{taskId:'r',headSha:'h'},
     tasks:[{id:'r',state:'RUNNING',executionId:'review-current'},
       {id:'child',state:'RUNNING',executionId:'exec-child',executionHistory:[],leaseOwner:'owner',leaseExpiresAt:'2026-01-01'}],
     reviewRevisionRequests:[{reviewTaskId:'r',reviewHeadSha:'h',reviewExecutionId:'review-old',
       revisionTaskId:'child',requestId:'q',status:'running'}]};
   const active=kind==='execution-changed'?'review-current':kind==='active-generation-blocked'?'review-obsolete':undefined;
   const head=kind==='unaffected'?'other':'h';
   const s=await store(j),cancelled=[];
   await staleReviewRevisions(s,j,'r',head,(taskId,executionId)=>cancelled.push({taskId,executionId}),active);
   const rv=rust('staleReviewRevisions',{root,job:j,reviewTaskId:'r',headSha:head,activeExecutionId:active});
   assert.equal(rv.ok,true,rv.error);
   assert.deepEqual(normalize(rv.value.job),normalize(s.current()),kind);
   assert.deepEqual(rv.value.cancelled,cancelled,kind);
 }
});
test('bounded troubleshooter fallback: no retry without matching runtime failure + plan/task barrier',async()=>{
 for(const kind of ['normal','unrelated-error','still-running','no-parent','completed-fallback','failed-plan']){
   const recovery={id:'recovery',agentName:'troubleshooter',state:'FAILED',attempt:3,maxAttempts:3,
     input:kind==='completed-fallback'?'[Relay execution fallback attempted]':'Investigate',parentTaskId:'original',
     error:kind==='unrelated-error'?'logical mismatch':'worker_process_failed',leaseOwner:null,leaseExpiresAt:null,
     executionId:null,workerSelection:{workerId:'a'}};
   const j={id:'1',state:'ACTIVE',tasks:[{id:'original',state:kind==='no-parent'?'SUCCEEDED':'FAILED',agentName:'worker',kind:'work'},recovery],plans:[]};
   if(kind==='still-running')j.tasks[0].resolution={path:'same_job_dependency',state:'active'};
   if(kind==='failed-plan'){j.tasks=j.tasks.slice(1);j.plans=[{id:'p',status:'FAILED'}];j.tasks[0].recoveryPlanId='p';}
   const s=await store(j),node=await fallbackFailedTroubleshooters(s,'1');
   const rv=rust('fallbackFailedTroubleshooters',{root,job:j});
   assert.equal(rv.ok,true,rv.error);
   assert.deepEqual(rv.value.queued,node,kind);
   assert.deepEqual(normalize(rv.value.job),normalize(s.current()),kind);
 }
});
test('planner recovery: source SQLite sequence, generated Task fields, safe idempotence',()=>{
 const base=mkdtempSync(join(tmpdir(),'rust2-review-allocator-'));
 const old=process.env.AGENTS_RELAY_STORE_DIR;
 try{
   for(let i=0;i<4;i++){
     const nodeStore=join(base,'node'+i,'stores'),rustStore=join(base,'rust'+i,'stores');
     mkdirSync(nodeStore,{recursive:true});mkdirSync(rustStore,{recursive:true});
     process.env.AGENTS_RELAY_STORE_DIR=nodeStore;
     const job={id:'1',state:'ACTIVE',repository:'fixture-repo',title:'Fixture',tasks:[]};
     const plan={id:'plan1',status:'FAILED',error:i%2?'network error':null,assessment:'planner no response'};
     const expected=createFailedPlanRecovery(clone(job),plan);
     const actual=rust('createFailedPlanRecovery',{root,storeDir:rustStore,job,plan});
     assert.equal(actual.ok,true,actual.error);
     assert.deepEqual(normalize(actual.value),normalize(expected),'case '+i);
   }
 }finally{if(old===undefined)delete process.env.AGENTS_RELAY_STORE_DIR;else process.env.AGENTS_RELAY_STORE_DIR=old;rmSync(base,{recursive:true,force:true})}
});
