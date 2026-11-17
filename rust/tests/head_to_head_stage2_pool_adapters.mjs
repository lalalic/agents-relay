// Node provenance: src/adapters.ts and src/pool.ts; compare freshly ported Rust
// source against original Node on isolated deterministic worker/pool fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  buildCodexArgs,chatGptTabClosePolicy,parseDriverJson
} from '../../dist/adapters.js';
import {
  compareJobPriority,runnableManagedJobs,activeWorkerSlots,
  needsLifecycleReconciliation
} from '../../dist/pool.js';
const root=resolve(import.meta.dirname,'../..');
const graphDirectory=join(root,'workflow');
const executable=join(root,'rust/target/debug/relay-rust2-parity');
const scratch=mkdtempSync(join(tmpdir(),'rust2-stage2-pool-adapters-'));
test.after(()=>rmSync(scratch,{recursive:true,force:true}));
let seed=0x67dca93e;
function random(){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;}
function pick(items){return items[random()%items.length];}
const fixtures=[];
function add(op,props,node){
  let expected;
  try{expected={ok:true,value:JSON.parse(JSON.stringify(node()))};}
  catch(e){expected={ok:false,error:e.message};}
  fixtures.push({request:{op,...props},expected});
}
for(let i=0;i<350;i++){
 const route={
  provider:pick(['codex','openai','',undefined]),
  model:pick(['gpt-5.6-codex','gpt-6','',undefined]),
  profile:pick(['work','',null,undefined]),
  reasoning:pick(['low','medium','high','',undefined]),
  cwd:pick(['/tmp/repo','/tmp/has space','',undefined])
 };
 const input=pick(['plain','中文。','emoji 🧪','line1\nline2','--help','', '\\q"$&']);
 add('stage2BuildCodexArgs',{route,input},()=>buildCodexArgs(route,input));
}
const policies=[undefined,'','never','after-start','after-terminal','bad','NEVER','abort',null,3,false];
for(let i=0;i<150;i++){
 const value=pick(policies),fallback=pick(['after-start','after-terminal','never']);
 add('stage2TabClosePolicy',{value,fallback},
   ()=>chatGptTabClosePolicy(value,fallback));
}
const receipts=[
 {operation:'submit',status:'submitted',thread_id:'abc'},
 {operation:'new-turn',status:'submitted',other:true},
 {mode:'new-thread',status:'submitted',thread_id:'abcdef'},
 {result:{mode:'new-turn',status:'submitted',extra:7}},
 {output:{data:{mode:'new-thread',status:'submitted'}}},
 {stdout:JSON.stringify({operation:'submit',status:'submitted'})},
 {operation:'submit',status:'failed'},
 {result:{operation:'submit',status:'failed'}},
 {},
 null,
];
for(let i=0;i<210;i++){
 const record=pick(receipts);
 let output=pick(['','warning: probe\n','diagnostic line\r\n']);
 output+=(random()%4===0?'{bad json}\n':'')+JSON.stringify(record);
 if(random()%5===0){output+='\n'+JSON.stringify({type:'info'});}
 add('stage2ParseDriverJson',{output},()=>parseDriverJson(output));
}
const identifiers=['a','A','ab','b','B','a2','a10','z','Z','é','É','中文',''];
const dates=['2026-11-01T12:00:00.000Z','2026-11-02T00:00:00.000Z','','bad'];
function randomJob(id){
 return {
  id,title:'job-'+id,repository:'toy',projectRoot:'/tmp/toy',
  state:pick(['ACTIVE','DRAFT','COMPLETED','CANCELLED']),
  createdAt:pick(dates),updatedAt:pick(dates),
  priority:pick(['P0','P1','P2','P3',undefined]),
  tasks:[],plans:[],headSha:null,reviewEnabled:false,localMerge:null,
  review:null
 };
}
for(let i=0;i<270;i++){
 const a=randomJob(pick(identifiers)),b=randomJob(pick(identifiers));
 add('stage2CompareJobPriority',{a,b},()=>Math.sign(compareJobPriority(a,b)));
}
for(let i=0;i<110;i++){
 const items=Array.from({length:random()%10},()=>({job:randomJob(pick(identifiers))}));
 add('stage2RunnableManagedJobs',{items},()=>runnableManagedJobs(items));
}
const states=['DRAFT','QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED','BLOCKED'];
function task(id){
 const state=pick(states),executionId=pick([null,'exec',null,null]);
 return {id:String(id),jobId:'101',kind:pick(['work','planner']),
  title:pick(['Worker','Coordinator','Final Review']),
  state,agentName:pick(['worker','reviewer','troubleshooter','final-review']),
  adapter:pick(['codex','chatgpt','orchestrator','script']),
  leaseOwner:pick(['daemon-1','',null]),leaseExpiresAt:pick([null,dates[0],dates[1]]),
  executionId,pausedExecution:pick([null,null,{reason:'pause'}]),
  dependencies:pick([[],[],['999']]),dagNode:pick([null,null,{nodeId:'a',parentTaskId:'42'}]),
  attempt:pick([0,1,2]),maxAttempts:3,
  timeoutMs:30000,createdAt:pick(dates),updatedAt:pick(dates),
 };
}
function populatedJob(){
 const job=randomJob('101');
 job.state=pick(['ACTIVE','ACTIVE','DRAFT','COMPLETED']);
 job.tasks=Array.from({length:1+(random()%6)},(_,index)=>task(index+1));
 job.plans=Array.from({length:random()%3},(_,i)=>({
   id:'p'+i,status:pick(['PLANNING','SUCCEEDED','FAILED']),
   executionId:pick([null,'plan-exec']),leaseOwner:pick([null,'daemon-1']),
   pausedExecutionId:null
 }));
 job.review=pick([null,{outcome:'pending',taskId:'7',headSha:'sha'}]);
 job.reviewEnabled=pick([true,false]);
 job.headSha=pick([null,'sha']);
 return job;
}
for(let i=0;i<430;i++){
 const job=populatedJob();
 add('stage2ActiveWorkerSlots',{job},()=>activeWorkerSlots(job));
}
for(let i=0;i<150;i++){
 const job=populatedJob();
 // Avoid triggering non-idempotent Planner and Troubleshooter materialization.
 job.reviewEnabled=false;
 job.tasks=job.tasks.map(t=>({...t,
   state:pick(['QUEUED','RUNNING','SUCCEEDED']),
   agentName:'worker',kind:'work',error:null,parentTaskId:null,
   dependencies:[],dagNode:null,executionId:pick([null,'live']),
   leaseExpiresAt:pick([null,'2026-11-01T00:00:00.000Z','2026-11-20T00:00:00.000Z']),
   routing:{provider:'codex',model:'gpt-6'}
 }));
 job.plans=[];
 const now=Date.parse('2026-11-17T12:00:00.000Z');
 add('stage2NeedsLifecycleReconciliation',{job,now,graphDirectory},
   ()=>needsLifecycleReconciliation(job,now));
}
test('Stage2 new Pool/Adapter ports compare exactly to original Node values and errors',()=>{
 const input=fixtures.map(f=>JSON.stringify(f.request)).join('\n')+'\n';
 const result=spawnSync(executable,[],{
  cwd:root,input,encoding:'utf8',timeout:180000,maxBuffer:20*1024*1024,
  env:{...process.env,AGENTS_RELAY_STORE_DIR:join(scratch,'stores')}
 });
 assert.equal(result.status,0,result.stderr||result.error?.message);
 const actual=result.stdout.trim().split('\n').map(v=>JSON.parse(v));
 assert.equal(actual.length,fixtures.length,'every native request must produce one response');
 const failures=[];
 for(let i=0;i<fixtures.length;i++){
  const f=fixtures[i];
  try{assert.deepEqual(actual[i],f.expected);}
  catch(e){failures.push({index:i,request:f.request,node:f.expected,rust:actual[i]});}
 }
 if(failures.length){
   const summaries=failures.slice(0,10).map(({index,request,node,rust})=>({
     index,op:request.op,value:request.value,
     ids:request.op==='stage2CompareJobPriority'?[request.a.id,request.b.id]:undefined,
     node:node.value?.map?.(j=>j.id) ?? node,
     rust:rust.value?.map?.(j=>j.id) ?? rust,
   }));
   assert.fail(`${failures.length} Node/Rust mismatches: ${JSON.stringify(summaries,null,2)}`);
 }

});
