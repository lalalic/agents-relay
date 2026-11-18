// Direct original Node finishPlanner vs native Graph+SQLite effect port.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {finishPlanner} from '../../dist/planner-runtime.js';
import {parsePlannerResult} from '../../dist/planner.js';
const root=resolve(import.meta.dirname,'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');
const stamp='2026-11-18T08:00:00.000Z';
const plan=(status='PLANNING',exec='ex1',attempt=1,manual=false)=>({
 id:'plan-1',jobId:'41',status,round:1,source:'model-planner',
 executionId:exec,leaseOwner:'relay',leaseExpiresAt:'2026-11-20T10:00:00Z',
 attempt,maxAttempts:3,manualPlanning:manual,headSha:'head',
 createdAt:stamp,updatedAt:stamp,trigger:{source:'manual'},
 forceRestate:false,generatedTaskIds:[],guidance:'Plan task'});
const task={id:'work1',jobId:'41',kind:'work',state:'SUCCEEDED',
 agentName:'worker',adapter:'codex',title:'Done',executionId:null,
 leaseOwner:null,leaseExpiresAt:null,attempt:1,maxAttempts:3,
 dependencies:[],createdAt:stamp,updatedAt:stamp};
const job=(p=plan(),tasks=[task])=>({id:'41',title:'Planner test',repository:'fixture',prNumber:0,
 objective:'Complete work',state:'ACTIVE',createdAt:stamp,updatedAt:stamp,
 tasks,plans:p?[p]:[],headSha:'head',reviewEnabled:false,pause:null});
const raw={objective_status:'satisfied',assessment:'Implementation complete',next_tasks:[],unblocks:[]};
const fingerprint=createHash('sha256').update(JSON.stringify(parsePlannerResult(raw))).digest('hex');
const cases=[
 {job:job(null)},
 {job:job(null),cliApply:true},
 {job:job(),executionId:'wrong'},
 {job:job(),executionId:'wrong',cliApply:true},
 {job:job(),executionId:'ex1',error:'Planner process failed',live:'ex1'},
 {job:job(plan('PLANNING','ex1',3,false)),executionId:'ex1',error:'Crash',live:'ex1'},
 {job:job(plan('PLANNING','ex1',1,true)),executionId:'ex1',error:'No progress',live:'ex1'},
 {job:job(),executionId:'ex1',error:'Planner JSON correction failed after one retry: exhausted',live:'ex1'},
 {job:job(),executionId:'ex1',error:'Input error',cliApply:true,live:'ex1'},
 {job:job(),executionId:'ex1',raw:{cliApplied:true},live:'ex1'},
 {job:job(plan('SUCCEEDED','ex1')),executionId:'ex1',raw:{cliApplied:true},live:'ex1'},
 {job:job({...plan('SUCCEEDED',null),appliedExecutionId:'ex1',appliedCandidateFingerprint:fingerprint}),executionId:'ex1',raw,live:'ex1'},
 {job:job({...plan('SUCCEEDED',null),appliedExecutionId:'ex1',appliedCandidateFingerprint:'wrong'}),executionId:'ex1',raw,live:'ex1'},
 {job:job(),executionId:'ex1',raw:{objective_status:'invalid'},live:'ex1'},
 {job:job(),executionId:'ex1',raw,live:'ex1'},
 {job:job(),executionId:'ex1',raw,live:'ex1',atomic:false},
 {job:job({...plan(),forceRestate:true,restateTaskIds:['work1']}),executionId:'ex1',raw,live:'ex1'},
 {job:job({...plan(),forceRestate:true,restateTaskIds:[]}),executionId:'ex1',raw,live:'ex1'},
 {job:job(plan('PLANNING','ex1',2)),executionId:'ex1',error:'Recoverable',live:'not-this-generation'},
];
function normalize(value){
 if(Array.isArray(value))return value.map(normalize);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value)
  .map(([key,val])=>[key,/At$/.test(key)&&typeof val==='string'&&/^20\d\d-/.test(val)?'<time>':normalize(val)]));
 return value;
}
function rust(fixtures){
 const result=spawnSync(binary,[],{cwd:root,encoding:'utf8',timeout:120000,
 input:fixtures.map(f=>JSON.stringify({op:'apiPlannerFinish',root,
  jobId:'41',planId:'plan-1',...f})).join('\n')+'\n',maxBuffer:10*1024*1024});
 assert.equal(result.status,0,result.stderr||result.error?.message);
 return result.stdout.trim().split('\n').map(JSON.parse).map(row=>normalize(row.value));
}
async function node(f){
 let current=structuredClone(f.job),live=f.live??null;
 const calls=[];
 const store={
  load:async id=>{calls.push(['load',id]);return structuredClone(current);},
  listAgents:async()=>{calls.push(['workers']);return structuredClone(f.workers??[]);},
  savePlan:async next=>{calls.push(['savePlan',next.id,next.status]);
   const pos=current.plans.findIndex(item=>item.id===next.id);
   if(pos>=0)current.plans[pos]=structuredClone(next);
  },
 };
 if(f.atomic!==false)store.mutateJob=async(id,callback)=>{
  calls.push(['mutate',id]);
  const candidate=await callback(structuredClone(current));
  current=structuredClone(candidate);return structuredClone(current);
 };
 const liveMap=new class extends Map{
  delete(key){const previous=this.get(key);if(previous)calls.push(['release',key]);
   return super.delete(key);}
 };
 if(live)liveMap.set('plan-1',{executionId:live,
  controller:new AbortController(),timer:setTimeout(()=>{},100000)});
 const ports={store,options:{adapters:[],owner:'relay'},live:liveMap,
  plannerContext:async()=>{calls.push(['context']);return f.context??null;},
  emit:async event=>{calls.push(['emit',event.type]);},
  detach:async(promise,id,planId,why)=>{
   const last=calls.findLast(item=>item[0]==='reconcile'&&item[1]===id);
   if(last)last[2]=why;
   await promise;
  },
  reconcile:async(id)=>{calls.push(['reconcile',id,'planner retry reconciliation']);},
 };
 let outcome={ok:true};
 try{await finishPlanner(ports,'41','plan-1',f.executionId??null,
  f.error?Error(f.error):null,f.raw,f.cliApply??false);}
 catch(error){outcome={ok:false,error:error.message};}
 for(const entry of liveMap.values())clearTimeout(entry.timer);
 // Normalized call names match native port effect audit.
 const postLive=liveMap.get('plan-1')?.executionId??null;
 // release recorded directly by the watched Live map.
 return normalize(JSON.parse(JSON.stringify({outcome,calls,job:current,live:postLive})));
}
function firstDiff(a,b,path='root'){
 if(typeof a!==typeof b||a===null||b===null)return JSON.stringify(a)===JSON.stringify(b)?null:{path,expected:a,actual:b};
 if(typeof a!=='object')return Object.is(a,b)?null:{path,expected:a,actual:b};
 for(const key of [...new Set([...Object.keys(a),...Object.keys(b)])].sort()){
  if(!(key in a)||!(key in b))return {path:`${path}.${key}`,expected:a[key],actual:b[key]};
  const diff=firstDiff(a[key],b[key],`${path}.${key}`);if(diff)return diff;
 }return null;
}
test('finishPlanner Node/Rust lease ownership, retries, candidate validation and atomic settlement',async()=>{
 const actual=rust(cases);const expected=[];
 for(const c of cases)expected.push(await node(c));
 const failed=[];
 for(let i=0;i<cases.length;i++){
  try{assert.deepEqual(actual[i],expected[i]);}
  catch{failed.push({i,difference:firstDiff(expected[i],actual[i])});}
 }
 assert.deepEqual(failed,[],JSON.stringify(failed,null,2));
 console.log('Verified',cases.length,'direct Node/Rust finishPlanner scenarios');
});
