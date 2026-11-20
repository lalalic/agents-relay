// Original Node public createDashboardActions/workspaceTaskCreate and
// applyManagedTaskUpdate vs real native Rust DaemonServices task_command.
// Each implementation owns a disposable independent Git/SQLite fixture;
// no production relay, repository, or external provider is consulted.
import test from 'node:test';import assert from 'node:assert/strict';
import{mkdtempSync,mkdirSync,rmSync}from'node:fs';
import{join,resolve}from'node:path';import{tmpdir}from'node:os';
import{execFileSync,spawnSync}from'node:child_process';
import{SQLiteRelayStore}from'../../dist/relay-store.js';
import{LocalAuthorityDurableStore}from'../../dist/local-authority-store.js';
import{InMemoryStore}from'../../dist/store.js';
import{createDashboardActions}from'../../dist/relayd-dashboard-actions.js';
import{applyManagedTaskUpdate}from'../../dist/task-update.js';
const root=resolve(import.meta.dirname,'../..');
const bin=join(root,'rust/target/debug/relay-rust2-parity');
const temp=mkdtempSync(join(tmpdir(),'rust2-dashboard-diff-'));
test.after(()=>rmSync(temp,{recursive:true,force:true}));
const timestamp='2026-11-19T00:00:00.000Z';
function fixture(name){const base=join(temp,name),stores=join(base,'stores'),project=join(base,'mockrepo');
 mkdirSync(stores,{recursive:true});mkdirSync(project);
 execFileSync('git',['init','-q','--initial-branch=main',project]);
 return{base,stores,project};}
async function seed(f){const store=new SQLiteRelayStore(join(f.base,'relay.sqlite'),'15');
 await store.saveJob({id:'15',title:'Dashboard task job',repository:'mockrepo',prNumber:0,
 projectRoot:f.project,state:'ACTIVE',plans:[],createdAt:timestamp,updatedAt:timestamp,
 tasks:[{id:'7',jobId:'15',title:'Retry target',kind:'work',adapter:'script',
 state:'FAILED',attempt:2,maxAttempts:2,dependencies:[],input:'original',
 createdAt:timestamp,updatedAt:timestamp}]});store.close();}
function task(){return{id:'',jobId:'15',title:'New task',kind:'work',agentName:'developer',
 state:'DRAFT',attempt:0,maxAttempts:3,adapter:'script',input:'create once',
 output:{kind:'file',path:'out.txt'},dependencies:[],createdAt:timestamp,updatedAt:timestamp};}
function relay(f){const db=new SQLiteRelayStore(join(f.base,'relay.sqlite'),'15');
 const port=new LocalAuthorityDurableStore(db,new InMemoryStore(),undefined,true);
 const actions=createDashboardActions({getOverviews:()=>[{job:{id:'15',repository:'mockrepo',prNumber:0}}],
 requireLocalJobBinding:async()=>({store:port}),pool:{reconcileLocalJob:async()=>{}},
 dashboardJobAction:()=>()=>{},makeReconciler:()=>{},concurrency:1,
 dashboardJobSetState:()=>()=>{},refreshAll:async()=>{},
 applyJobActivateAction:()=>{},bus:{},dashboardTaskAction:()=>()=>{},
 dashboardTaskSetState:()=>()=>{},storeDirectory:f.stores});
 return{db,port,actions};}
function rust(f,body){const cmd={op:'batchAPublicParity',method:'dashboardTaskCommandNative',
 storeDirectory:f.stores,input:body};
 const result=spawnSync(bin,[],{cwd:root,input:JSON.stringify(cmd)+'\n',encoding:'utf8',timeout:30000});
 assert.equal(result.status,0,result.stderr);
 const outer=JSON.parse(result.stdout.trim());assert.equal(outer.ok,true,JSON.stringify(outer));
 return outer.value;}
const project=job=>({id:job.id,state:job.state,createdTaskId:job.createdTaskId,
 tasks:job.tasks.map(t=>({id:t.id,jobId:t.jobId,title:t.title,kind:t.kind,state:t.state,
 adapter:t.adapter,attempt:t.attempt,maxAttempts:t.maxAttempts,input:t.input,
 output:t.output,dependencies:t.dependencies}))});
async function originalCreate(api,body){try{return{ok:true,value:await api.actions.workspaceTaskCreate(
  body.jobId,structuredClone(body.task),body.idempotencyKey)}}catch(e){return{ok:false,error:e.message}}}
async function originalUpdate(api,body){try{return{ok:true,value:await applyManagedTaskUpdate(
 api.port,body.jobId,body.taskId,structuredClone(body.task),body.expectedUpdatedAt)}}
 catch(e){return{ok:false,error:e.message}}}
async function current(f){const store=new SQLiteRelayStore(join(f.base,'relay.sqlite'),'15');
 try{return await store.loadJob('15');}finally{store.close();}}
test('original Node/Rust real Dashboard Task creation and persistent idempotent retry',async()=>{
 const a=fixture('node-create'),b=fixture('rust-create');await seed(a);await seed(b);
 const api=relay(a);try{
 const body={jobId:'15',action:'create',task:task(),idempotencyKey:'same-task-definition'};
 for(let round=0;round<2;round++){
  const node=await originalCreate(api,body),native=rust(b,body);
  assert.equal(node.ok,true,JSON.stringify(node));assert.equal(native.ok,true,JSON.stringify(native));
  assert.deepEqual(project(native.value),project(node.value),`positive create round ${round}`);
  assert.deepEqual(project(await current(b)),project(await current(a)));
 }
 for(const bad of [
  {...body,task:{...task(),input:'other-definition'}},
  {...body,task:{...task(),id:'900'}},
  {...body,task:{...task(),jobId:'different'}},
 ]){
  const node=await originalCreate(api,bad),native=rust(b,bad);
  assert.equal(node.ok,false);assert.equal(native.ok,false);
  assert.equal(native.error,node.error,`negative ${JSON.stringify(bad.task)}`);
  assert.deepEqual(project(await current(b)),project(await current(a)));
 }
 }finally{api.db.close();}
});
test('original Node/Rust Task update with optimistic version and illegal self dependency',async()=>{
 const a=fixture('node-update'),b=fixture('rust-update');await seed(a);await seed(b);
 const api=relay(a);try{
 const base=(await current(a)).tasks[0];
 const proposal={...base,input:'New Task input',maxAttempts:5};
 const body={action:'update',jobId:'15',taskId:'7',task:proposal,
  expectedUpdatedAt:timestamp};
 const node=await originalUpdate(api,body),native=rust(b,body);
 assert.equal(node.ok,true,JSON.stringify(node));assert.equal(native.ok,true,JSON.stringify(native));
 assert.deepEqual(project(native.value),project(node.value));
 assert.deepEqual(project(await current(b)),project(await current(a)));
 for(const invalid of [
  body,
  {...body,expectedUpdatedAt:node.value.tasks[0].updatedAt,
   task:{...proposal,dependencies:['7']}},
 ]){
  // The two runtimes own independent wall-clock SQLite versions: use
  // each implementation's own committed updatedAt on post-write cases.
  const rustInput={...invalid,expectedUpdatedAt:invalid.expectedUpdatedAt===timestamp
   ?timestamp:(await current(b)).tasks[0].updatedAt};
  const nodeInvalid=await originalUpdate(api,invalid),nativeInvalid=rust(b,rustInput);
  assert.equal(nodeInvalid.ok,false,JSON.stringify(nodeInvalid));
  assert.equal(nativeInvalid.ok,false,JSON.stringify(nativeInvalid));
  assert.equal(nativeInvalid.error,nodeInvalid.error);
  assert.deepEqual(project(await current(b)),project(await current(a)));
 }
 }finally{api.db.close();}
});
