// Direct source-module Node/Rust pool API effects; no live Store or remote service.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {RepositoryWorkerPool} from '../../dist/pool.js';
const root=resolve(import.meta.dirname,'../..');
const bin=join(root,'rust/target/debug/relay-rust2-parity');
const job=(id='1',state='ACTIVE',tasks=[])=>({
 id,state,repository:'fixture',priority:'P2',createdAt:'2026-11-18T09:00:00Z',
 updatedAt:'2026-11-18T09:00:00Z',tasks,plans:[],headSha:'fixture',
 reviewEnabled:false,pause:null
});
const dag={id:'t',state:'QUEUED',agentGraph:'graph TD; A-->B',
 executionId:null,leaseOwner:null,leaseExpiresAt:null,dependencies:[]};
const ready={id:'q',state:'QUEUED',executionId:null,
 leaseOwner:null,leaseExpiresAt:null,dependencies:[],adapter:'codex'};
const busy={id:'t2',state:'RUNNING',executionId:'live',
 leaseOwner:'worker',leaseExpiresAt:null,dependencies:[]};
const cases=[
 {jobId:'1',localJobs:[],discovered:[]},
 {jobId:'1',localJobs:[job()],discovered:[]},
 {jobId:'1',localJobs:[job('1','DRAFT')],discovered:[]},
 {jobId:'1',localJobs:[job('1','COMPLETED')],discovered:[]},
 {jobId:'1',localJobs:[job('1','ACTIVE',[dag])],discovered:[]},
 {jobId:'1',localJobs:[job('1','ACTIVE',[dag])],discovered:[job('2','ACTIVE',[busy])]},
 {jobId:'1',localJobs:[job('1','ACTIVE',[dag])],discovered:[job('2','ACTIVE',[busy])],concurrency:1},
 {jobId:'1',localJobs:[job('1','ACTIVE',[dag])],discovered:[],concurrency:0},
 {jobId:'1',localJobs:[job()],discovered:[],loadError:'SQLite read error'},
 {jobId:'1',localJobs:[job()],discovered:[],reconcileError:'Graph reconciliation error'},
 {jobId:'1',localJobs:[job()],discovered:[],inventoryError:'Inventory failed'},
 {jobId:'1',localJobs:[job()],discovered:[job('2','DRAFT')]},
 {jobId:'1',localJobs:[job()],discovered:[job('2','ACTIVE')]},
 {jobId:'2',localJobs:[job('1')],discovered:[job('1')]},
 {jobId:'1',localJobs:[job(),job('2','ACTIVE',[ready])],discovered:[job('2','ACTIVE',[ready])],reconcileError:'Graph failure for 2',reconcileErrorFor:'2'},
 {jobId:'1',localJobs:[job(),job('2','ACTIVE',[ready]),job('3','ACTIVE',[ready])],discovered:[job('2','ACTIVE',[ready]),job('3','ACTIVE',[ready])],reconcileError:'Graph failure for 2',reconcileErrorFor:'2'},
];
async function nodeLocal(f){
 const calls=[];
 const local=new Map(f.localJobs.map(j=>[j.id,j]));
 const pool=new RepositoryWorkerPool(f.concurrency??2,(store,slots)=>{
  calls.push(['make',slots,store.id]);
  return {reconcile:async id=>{
   calls.push(['reconcile',id,slots]);
   if(f.reconcileError&&(!f.reconcileErrorFor||f.reconcileErrorFor===id))throw Error(f.reconcileError);
  }};
 },async()=>{
  calls.push(['inventory']);
  if(f.inventoryError)throw Error(f.inventoryError);
  return f.discovered.map(job=>({job}));
 },async id=>{
  calls.push(['resolve',id]);
  const value=local.get(id);
  if(!value)return null;
  return {job:value,store:{id,load:async()=>{
   calls.push(['load',id]);
   if(f.loadError)throw Error(f.loadError);
   return value;
  }}};
 });
 let outcome={ok:true};
 try{await pool.reconcileLocalJob(f.jobId);}catch(error){outcome={ok:false,error:error.message};}
 return {outcome,calls};
}
function rust(op,cases){
 const result=spawnSync(bin,[],{cwd:root,encoding:'utf8',timeout:120000,
  input:cases.map(f=>JSON.stringify({op,...f})).join('\n')+'\n',maxBuffer:10*1024*1024});
 assert.equal(result.status,0,result.stderr||result.error?.message);
 const lines=result.stdout.trim().split('\n').map(JSON.parse);
 assert.equal(lines.length,cases.length);
 return lines.map(row=>row.value);
}
test('Pool reconcileLocalJob resolves local SQLite and schedules immediate DAG capacity',async()=>{
 const actual=rust('apiPoolLocal',cases);
 const expected=await Promise.all(cases.map(nodeLocal));
 const diffs=[];
 for(let i=0;i<cases.length;i++){
  try{assert.deepEqual(actual[i],expected[i]);}
  catch{diffs.push({i,fixture:cases[i],expected:expected[i],actual:actual[i]});}
 }
 assert.deepEqual(diffs,[],JSON.stringify(diffs,null,2));
 console.log('Verified',cases.length,'Pool local reconciliation Node/Rust cases');
});

const types=['task.started','task.progress','task.completed','task.failed',
 'task.blocked','task.unblocked','task.cancelled','review.started',
 'review.approved','review.changes_required','review.blocked',
 'task.interactive_decision','job.wake','review.created','planner.completed',
 'github.webhook','random.event','package.published'];
const event=(type, data={})=>({job_id:'1',type,data});
const watchCases=[
 {events:[]},
 {events:types.map(type=>event(type))},
 {events:[event('task.completed',{message:'done'})],afterUnsubscribe:event('task.failed')},
 {events:[event('github.webhook',{coordinatorRouted:true}),event('github.webhook',{coordinatorIngress:true})]},
 {events:[event('job.wake'),event('review.created'),event('planner.completed')]},
 {events:[event('task.interactive_decision'),event('package.published')]},
 {events:[event('task.completed'),event('task.completed')]},
 {events:[],afterUnsubscribe:event('job.wake')},
 {events:[event('review.approved')],wake:{deliveryId:'one',event:'push'}},
 {events:[event('random.event')],wake:{deliveryId:'two',event:'push'},testResolvedWebhook:true},
 {events:[event('task.started')],wake:{deliveryId:'three',event:'push',publication:{package:'p',version:'1'}},testResolvedWebhook:true},
];
async function nodeWatch(f){
 const signals=[];let handler=null;
 const bus={
  subscribeAll:async cb=>{handler=cb;return async()=>{handler=null;}},
  publish:async e=>{if(handler)await handler(e);}
 };
 const pool=new RepositoryWorkerPool(2,()=>({}),async()=>[],async()=>null);
 pool.coordinator.acceptTransport=async signal=>{signals.push(signal);};
 const unsubscribe=await pool.watch(bus);
 for(const e of f.events)await bus.publish(e);
 await unsubscribe();
 if(f.afterUnsubscribe)await bus.publish(f.afterUnsubscribe);
 let webhookSignalPublishCount=0,resolvedWebhookPublishCount=0;
 const spy={publish:async()=>{webhookSignalPublishCount++;}};
 await pool.webhookSignal(spy,f.wake??{});
 await pool.webhookSignal(undefined,f.wake??{});
 if(f.testResolvedWebhook){
  await pool.webhookWake({publish:async()=>{resolvedWebhookPublishCount++;}},
   {id:'local',repository:'org/repo'},f.wake);
 }
 return {signals,webhookSignalPublishCount,resolvedWebhookPublishCount};
}
test('Pool watch filters lifecycle transport and releases exact subscription; webhookSignal ignores unresolved wakeups',async()=>{
 const expected=(await Promise.all(watchCases.map(nodeWatch)))
  .map(value=>JSON.parse(JSON.stringify(value)));
 const actual=rust('apiPoolWatch',watchCases);
 const diffs=[];
 for(let i=0;i<watchCases.length;i++){
  try{assert.deepEqual(actual[i],expected[i]);}
  catch{diffs.push({i,expected:expected[i],actual:actual[i]});}
 }
 assert.deepEqual(diffs,[],JSON.stringify(diffs,null,2));
 console.log('Verified',watchCases.length,'Pool watch/webhookSignal Node/Rust cases');
});
