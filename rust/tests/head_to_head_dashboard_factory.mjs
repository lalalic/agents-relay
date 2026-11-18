// Node authoritative createDashboardActions factory vs Rust one-backend
// call ordering, missing/targeted Job refusal, and remote side effect gates.
// No real daemon, browser, provider, Job, GitHub or production SQLite.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {createDashboardActions} from '../../dist/relayd-dashboard-actions.js';
const root=resolve(import.meta.dirname,'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');
const job={id:'41',repository:'example',prNumber:12,state:'ACTIVE',tasks:[]};
const fixtures=[];
for(const method of [
 'dashboardOverview','workspaceJobAction','workspaceJobSetState',
 'workspaceTaskAction','workspaceTaskSetState']){
 for(const jobId of ['41','unknown']){
  for(const target of [null,{repository:'example',prNumber:12},
   {repository:'wrong'},{prNumber:13}]){
   fixtures.push({op:'dashboardFactoryParity',method,jobId,taskId:'9',
    action:method==='workspaceTaskAction'?'retry':'reconcile',
    state:method==='workspaceTaskSetState'?'QUEUED':'CANCELLED',
    target,job,overviews:[{job}]});
  }
 }
}
for(const method of ['workspaceJobAction','workspaceTaskAction']){
 for(const action of ['start','cancel','retry']){
  fixtures.push({op:'dashboardFactoryParity',method,jobId:'41',taskId:'9',
   action,target:null,state:'CANCELLED',job,overviews:[{job}]});
 }
}
for(const method of ['dashboardOverview','workspaceJobAction','workspaceTaskAction']){
 fixtures.push({op:'dashboardFactoryParity',method,jobId:'41',taskId:'9',
  action:'cancel',target:null,job,overviews:[]});
}
async function original(f){
 const calls=[];
 const log=(entry)=>calls.push(entry);
 let currentJob=structuredClone(f.job);
 const store={
  load:async id=>{log(`store.load:${id}`);return structuredClone(currentJob);},
  appendTask:async task=>{log(`store.appendTask:${task.jobId}:${JSON.stringify(task.id)}`);
   currentJob.tasks.push(structuredClone(task));},
  saveJob:async job=>{log('store.saveJob');currentJob=structuredClone(job);},
 };
 if(f.canMutate!==false)store.mutateJob=async(id,mutate)=>{
  log(`store.mutateJob:${id}`);currentJob=await mutate(currentJob);
  return structuredClone(currentJob);
 };
 const deps={
  getOverviews:()=>{log('getOverviews');return structuredClone(f.overviews);},
  requireLocalJobBinding:async id=>{log(`requireLocalJobBinding:${id}`);return {store};},
  pool:{reconcileLocalJob:async(id,reason)=>log(`pool.reconcileLocalJob:${id}:${reason}`)},
  dashboardJobAction:(_store,_reconciler,action)=>{
   log(`dashboardJobActionFactory:${action}`);
   return async id=>{log(`dashboardJobAction:${action}:${id}`);return {jobId:id,action};};
  },
  dashboardJobSetState:()=>{
   log('dashboardJobSetStateFactory');
   return async(id,state)=>{log(`dashboardJobSetState:${id}:${state}`);return {jobId:id,state};};
  },
  dashboardTaskAction:(_store,_reconciler,action)=>{
   log(`dashboardTaskActionFactory:${action}`);
   return async(id,taskId)=>{log(`dashboardTaskAction:${action}:${id}:${taskId}`);
     return {jobId:id,taskId,action};};
  },
  dashboardTaskSetState:()=>{
   log('dashboardTaskSetStateFactory');
   return async(id,taskId,state)=>{log(`dashboardTaskSetState:${id}:${taskId}:${state}`);
     return {jobId:id,taskId,state};};
  },
  makeReconciler:()=>{log('makeReconciler');return {};},
  concurrency:1,
  refreshAll:async()=>log('refreshAll'),
  storeDirectory:f.storeDirectory??'/tmp/fixture-not-executed',
  applyJobActivateAction:async job=>{log('applyJobActivateAction');job.state='ACTIVE';},
 };
 const factory=createDashboardActions(deps);
 let outcome;
 try{
  let value;
  switch(f.method){
   case 'dashboardOverview':value=factory.dashboardOverview(f.jobId,f.target)??null;break;
   case 'workspaceJobAction':value=await factory.workspaceJobAction(f.action)(f.jobId);break;
   case 'workspaceJobSetState':value=await factory.workspaceJobSetState(f.jobId,f.state,f.target);break;
   case 'workspaceTaskAction':value=await factory.workspaceTaskAction(f.action)(f.jobId,f.taskId);break;
   case 'workspaceTaskSetState':value=await factory.workspaceTaskSetState(f.jobId,f.taskId,f.state,f.target);break;
   case 'workspaceTaskCreate':value=await factory.workspaceTaskCreate(
     f.jobId,structuredClone(f.providedTask),f.idempotencyKey);break;
   default:throw Error('unknown method');
  }
  outcome={ok:true,value};
 }catch(error){outcome={ok:false,error:error.message};}
 return {outcome:JSON.parse(JSON.stringify(outcome)),calls};
}
test('dashboard actions factory public methods and caller-visible host effects match original Node',async()=>{
 const node=[];for(const f of fixtures)node.push(await original(f));
 const run=spawnSync(binary,[],{cwd:root,encoding:'utf8',
  input:fixtures.map(JSON.stringify).join('\n')+'\n',timeout:120000,maxBuffer:4*1024*1024});
 assert.equal(run.status,0,run.stderr||run.error?.message);
 const native=run.stdout.trim().split('\n').map(JSON.parse);
 assert.equal(native.length,fixtures.length);
 const mismatches=[];
 for(let i=0;i<fixtures.length;i++){
  try{assert.deepEqual(native[i],{ok:true,value:node[i]});}
  catch{mismatches.push({case:i,fixture:fixtures[i],node:node[i],rust:native[i]});}
 }
 assert.deepEqual(mismatches.slice(0,8),[],`${mismatches.length} public factory behavior mismatches`);
 console.log(`DIRECT_DASHBOARD_FACTORY_NODE_RUST_PASS ${fixtures.length}`);
});

test('real Task ID allocation and atomic in-memory Store effects match original DashboardActions factory',async()=>{
 const fixtures=[];
 for(const kind of ['positive','idempotent','wrongJob','missingJob','terminal','explicitId','noMutation','noMutationDraft']){
  const isolated=mkdtempSync(join(tmpdir(),'rust2-dashboard-factory-parity-'));
  const jobWithState={...job,state:kind==='terminal'?'COMPLETED':kind==='noMutationDraft'?'DRAFT':'ACTIVE',
   createdAt:'2026-11-18T10:00:00.000Z',updatedAt:'2026-11-18T10:00:00.000Z'};
  const providedTask={id:kind==='explicitId'?'supplied':'',
   jobId:kind==='wrongJob'?'other':'41',state:'DRAFT',kind:'work',
   input:'test dashboard task creation',output:{kind:'file',path:'out.txt'},
   dependencies:[],capabilities:['coding'],adapter:'script'};
  fixtures.push({op:'dashboardFactoryParity',method:'workspaceTaskCreate',
   jobId:kind==='missingJob'?'missing':'41',taskId:'9',action:'create',
   target:null,state:'ACTIVE',job:jobWithState,overviews:[{job:jobWithState}],
   idempotencyKey:kind==='idempotent'?'fixture-key':null,providedTask,
   canMutate:!['noMutation','noMutationDraft'].includes(kind),
   storeDirectory:join(isolated,'node','stores'),rustDirectory:join(isolated,'rust','stores'),
   isolationRoot:isolated,kind});
 }
 function normalize(result){
  const copy=JSON.parse(JSON.stringify(result));
  if(copy.outcome?.value?.updatedAt)copy.outcome.value.updatedAt='<time>';
  return copy;
 }
 try{
  const expected=[];
  for(const fixture of fixtures)expected.push(normalize(await original(fixture)));
  const rustCases=fixtures.map(f=>({...f,storeDirectory:f.rustDirectory}));
  const run=spawnSync(binary,[],{cwd:root,encoding:'utf8',
   input:rustCases.map(JSON.stringify).join('\n')+'\n',
   timeout:120000,maxBuffer:5*1024*1024});
  assert.equal(run.status,0,run.stderr||run.error?.message);
  const actual=run.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(actual.length,fixtures.length);
  const differences=[];
  for(let i=0;i<fixtures.length;i++){
   try{assert.deepEqual(normalize(actual[i].value),expected[i]);}
   catch{differences.push({case:fixtures[i].kind,node:expected[i],rust:actual[i]});}
  }
  assert.deepEqual(differences,[]);
 }finally{for(const f of fixtures)rmSync(f.isolationRoot,{force:true,recursive:true});}
 console.log('DIRECT_DASHBOARD_FACTORY_TASK_CREATE_NODE_RUST_PASS',fixtures.length);
});
