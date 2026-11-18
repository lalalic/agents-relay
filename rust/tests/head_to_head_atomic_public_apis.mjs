// Direct public Node API vs real native Rust SQLite entrypoints.
// No live jobs, provider traffic, shared stores, or duplicate workflow engine.
// Normalizes only wall-clock timestamps introduced during mutation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {applyManagedTaskUpdate} from '../../dist/task-update.js';
import {failInteractiveReview} from '../../dist/interactive-request.js';
import {dispatchTaskAction} from '../../dist/task-actions.js';
import {unblockTask} from '../../dist/unblock.js';
const root=resolve(import.meta.dirname,'../..');
const binary=join(root,'rust/target/debug/relay-rust2-api-parity');
const iso='2026-11-17T19:00:00.000Z';
const task=()=>({
 id:'11',jobId:'25',state:'DRAFT',kind:'work',title:'Task',
 agentName:'builder',adapter:'script',priority:'P2',storySize:'M',
 attempt:0,maxAttempts:3,dependencies:[],capabilities:[],
 input:'Original',output:{kind:'file',path:'out.txt'},
 leaseOwner:null,leaseExpiresAt:null,executionId:null,error:null,
 createdAt:iso,updatedAt:iso,
});
function job(t=task()){return {id:'25',repository:'local-api',prNumber:0,projectRoot:'/tmp/local-api',
 title:'Local',state:'ACTIVE',priority:'P2',createdAt:iso,updatedAt:iso,plans:[],tasks:[t]};}
function storeFactory(snapshot){
 let state=structuredClone(snapshot);
 return {
  get snapshot(){return structuredClone(state);},
  load:async()=>structuredClone(state),
  mutateJob:async(_id, mutate)=>{const next=await mutate(structuredClone(state));state=structuredClone(next);return structuredClone(state);},
  saveTask:async t=>{state.tasks=state.tasks.map(v=>v.id===t.id?structuredClone(t):v);},
  headSha:async()=>null,
 };
}
const fixtures=[];
function add(op,t,patch={}){fixtures.push({op,job:job(t),taskId:'11',...patch});}
for(const change of [
 {input:'Changed'}, {priority:'P0'}, {capabilities:['network','filesystem']},
 {maxAttempts:5}, {dependencies:[]}, {timeoutMs:60000},
 {projectName:'A'},{adapter:'chatgpt'}
]){
 const old=task();add('apiTaskUpdateSqlite',old,{
  proposed:{...old,...change},expectedUpdatedAt:iso});
}
for(const mode of ['stale','selfDependency','wrongId','wrongJob','attemptRoute','belowBudget','active','terminal','invalidState','queued']){
 const old=task();const proposed=structuredClone(old);
 if(mode==='selfDependency')proposed.dependencies=['11'];
 if(mode==='wrongId')proposed.id='wrong';
 if(mode==='wrongJob')proposed.jobId='elsewhere';
 if(mode==='attemptRoute'){old.attempt=1;proposed.attempt=1;proposed.adapter='chatgpt';}
 if(mode==='belowBudget'){old.attempt=2;proposed.maxAttempts=1;}
 if(mode==='active'){old.state='RUNNING';old.executionId='bound';proposed.state='RUNNING';proposed.executionId='bound';}
 if(mode==='terminal'){old.state='SUCCEEDED';proposed.state='SUCCEEDED';}
 if(mode==='invalidState')proposed.state='FAILED';
 if(mode==='queued')proposed.state='QUEUED';
 add('apiTaskUpdateSqlite',old,{proposed,expectedUpdatedAt:mode==='stale'?'old':iso});
}
for(const state of ['RUNNING','AWAITING_DECISION','DRAFT']){
 for(const executionId of ['gen-1','old-gen']){
  const old=task();old.state=state;old.executionId='gen-1';
  old.interactiveInvocation={invocationId:'gen-1',executionId:'gen-1',revision:'gen-1',status:'awaiting_decision',boundAt:iso};
  add('apiFailInteractiveSqlite',old,{executionId,reason:'delivery unreachable'});
 }
}
for(const state of ['FAILED','DRAFT','QUEUED','RUNNING','SUCCEEDED','CANCELLED']){
 for(const id of ['task.retry','task.cancel','task.release','task.hold','task.queue','unknown']){
  const old=task();old.state=state;
  add('apiTaskActionSqlite',old,{action:{id,jobId:'25',taskId:'11'}});
 }
}
for(const state of ['BLOCKED','DRAFT','QUEUED','FAILED']){
 for(const agentName of ['builder','troubleshooter']){
  const old=task();old.state=state;old.agentName=agentName;
  old.blockedBaseline={blockedAt:iso,reason:'blocked'};
  add('apiUnblockSqlite',old,{reason:'human request'});
 }
}
async function nodeRun(f){
 const store=storeFactory(f.job);
 try{
  if(f.op==='apiTaskUpdateSqlite'){
   const out=await applyManagedTaskUpdate(store,f.job.id,f.taskId,f.proposed,f.expectedUpdatedAt);
   return {ok:true,value:{task:out.tasks.find(t=>t.id===f.taskId)}};
  }
  if(f.op==='apiFailInteractiveSqlite'){
   const out=await failInteractiveReview(store,f.job.id,f.taskId,f.executionId,f.reason);
   return {ok:true,value:{requeued:out.requeued,task:store.snapshot.tasks.find(t=>t.id===f.taskId)}};
  }
  if(f.op==='apiTaskActionSqlite'){
   const out=await dispatchTaskAction(store,f.action);
   return {ok:true,value:{task:out.task}};
  }
  const t=store.snapshot.tasks.find(t=>t.id===f.taskId);
  const out=await unblockTask({store,job:structuredClone(f.job),task:t,trigger:{source:'cli',reason:f.reason}});
  return {ok:true,value:{replanning:out.replanning,task:store.snapshot.tasks.find(t=>t.id===f.taskId)}};
 }catch(error){return {ok:false,error:error?.message??String(error)};}
}
function scrub(value){
 if(Array.isArray(value))return value.map(scrub);
 if(value && typeof value==='object'){
  return Object.fromEntries(Object.entries(value).filter(([key,v])=>v!==undefined).map(([key,v])=>[
   key,/^(updatedAt|boundAt|at)$/.test(key)?'<TIME>':
     key==='comments' && Array.isArray(v)?v.map(c=>({...scrub(c),id:'<RANDOM>',createdAt:'<TIME>'})):scrub(v)
  ]));
 }
 return value;
}
test('public Node/Rust SQLite Task update, action, unblock and review failure contracts',async()=>{
 const expected=[];for(const fixture of fixtures)expected.push(await nodeRun(fixture));
 const process=spawnSync(binary,[],{cwd:root,input:fixtures.map(JSON.stringify).join('\n')+'\n',
  encoding:'utf8',timeout:120000,maxBuffer:20*1024*1024});
 assert.equal(process.status,0,process.stderr||process.error?.message);
 const actual=process.stdout.trim().split('\n').map(JSON.parse);
 assert.equal(actual.length,fixtures.length);
 const differences=[];
 for(let i=0;i<fixtures.length;i++){
  try{assert.deepEqual(scrub(actual[i]),scrub(expected[i]));}
  catch{differences.push({case:i,op:fixtures[i].op,fixture:fixtures[i],
   node:scrub(expected[i]),rust:scrub(actual[i])});}
 }
 if(differences.length)console.error(JSON.stringify(differences.map(v=>({case:v.case,op:v.op,node:v.node,rust:v.rust})),null,2));
 assert.equal(differences.length,0,`${differences.length} actual Node/Rust mismatches`);
 console.log(`Verified ${fixtures.length} public Node/Rust API cases with real SQLite Rust effects`);
});
