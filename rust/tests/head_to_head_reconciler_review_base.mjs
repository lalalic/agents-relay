// Direct ReconcilerReviewBase original Node class and native Rust review Graph.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {ReconcilerReviewBase} from '../../dist/reconciler-review.js';
const root=resolve(import.meta.dirname,'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');
const stamp='2026-11-18T08:00:00.000Z';
const job=(review=null,reviewEnabled=true,tasks=[])=>({id:'41',state:'ACTIVE',
 repository:'fixture',prNumber:0,priority:'P2',title:'Review test',
 headSha:'head-new',review,reviewEnabled,tasks,plans:[],
 createdAt:stamp,updatedAt:stamp});
const review=(outcome='pending',headSha='head-old',taskId='rv1')=>({
 outcome,headSha,taskId,updatedAt:stamp,evidence:null});
const task=(agentName='worker',state='SUCCEEDED')=>({id:'t1',jobId:'41',
 kind:'work',state,agentName,adapter:'codex',routing:{provider:'mock',model:'test'},
 output:{kind:'task_pr'},reviewHeadSha:'head-old',
 dependencies:[],capabilities:[],createdAt:stamp,updatedAt:stamp});
const event=(type='review.approved')=>({type,job_id:'41',task_id:'rv1',
 timestamp:stamp,status:'succeeded',message:'approved',
 data:{headSha:'head-old'},source:{id:'system'}});
const cases=[
 {operation:'head',job:job()},
 {operation:'head',job:{...job(),headSha:null}},
 {operation:'head',job:{...job(review()),headSha:null}},
 {operation:'invalidate',head:'head-new',job:job()},
 {operation:'invalidate',head:'head-new',job:job(review('pending','head-new'))},
 {operation:'invalidate',head:null,job:job(review())},
 {operation:'invalidate',head:'head-new',job:job(review())},
 {operation:'invalidate',head:'head-new',job:job(review('approved'))},
 {operation:'invalidate',head:'head-new',job:job(review('changes_required'))},
 {operation:'invalidate',head:'head-new',job:job(review('blocked'))},
 {operation:'ensure',head:'head-new',job:job(null,false)},
 {operation:'ensure',head:null,job:job(null,true)},
 {operation:'ensure',head:'head-new',job:job(review('approved','head-new'),true,[
  {...task('job-acceptance-reviewer'),id:'rv1',reviewHeadSha:'head-new'}])},
 {operation:'route',taskId:'t1',job:job(null,true,[task()])},
 {operation:'route',taskId:'absent',job:job(null,false,[task()])},
 {operation:'event',event:event('review.approved'),job:job()},
 {operation:'event',event:event('review.started'),job:job(review())},
 {operation:'launch',task:task(),job:job()},
];
class Fixture extends ReconcilerReviewBase{
 constructor(store){super(store,{owner:'relay',adapters:[],
  noGitHub:true,localMergeEffect:async()=>({})});}
 async reconcile(){return this.store.load('41');}
 async launch(){}
 async head(job){return this.currentHeadSha(job)}
 async invalidate(job,head){return this.invalidateStaleReview(job,head)}
 async ensure(job,head){return this.ensureFinalReview(job,head)}
 async route(job,task){return this.routeTaskForExecution(job,task)}
 async review(event){return this.applyReviewEvent(event)}
}
function rust(fixtures){
 const result=spawnSync(binary,[],{cwd:root,encoding:'utf8',timeout:120000,
 input:fixtures.map(f=>JSON.stringify({op:'apiReviewBase',root,...f})).join('\n')+'\n'});
 assert.equal(result.status,0,result.stderr||result.error?.message);
 return result.stdout.trim().split('\n').map(JSON.parse).map(x=>normalize(x.value));
}
function normalize(value){
 if(Array.isArray(value))return value.map(normalize);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value)
  .map(([key,v])=>[key,/At$/.test(key)&&typeof v==='string'&&/^20\d\d-/.test(v)?'<time>':normalize(v)]));
 return value;
}
async function node(f){
 let current=structuredClone(f.job),writes=0;
 const store={
  load:async()=>structuredClone(current),
  loadJob:async()=>structuredClone(current),
  mutateJob:async(_id,callback)=>{
   const next=structuredClone(await callback(structuredClone(current)));
   if(JSON.stringify(next)!==JSON.stringify(current))writes++;
   current=next;return structuredClone(current);
  },
  saveTask:async task=>{
   const index=current.tasks.findIndex(t=>t.id===task.id);
   if(index>=0){current.tasks[index]=structuredClone(task);writes++;}
  },
  saveJob:async job=>{current=structuredClone(job);writes++;},
  appendTask:async task=>{current.tasks.push(structuredClone(task));writes++;},
  listAgents:async()=>[],
 };
 const instance=new Fixture(store);
 let outcome={ok:true,value:null},reason='';
 try{
  const op=f.operation;
  if(op==='head')outcome.value={head:await instance.head(current)};
  else if(op==='invalidate')await instance.invalidate(current,f.head);
  else if(op==='ensure')await instance.ensure(current,f.head);
  else if(op==='route'){
   const t=current.tasks.find(t=>t.id===f.taskId);
   if(!t)throw Error(`Task ${f.taskId} not found`);
   const response=await instance.route(current,t);
   reason=JSON.stringify({events:0});
   assert.equal(response.routed,false);
  }
  else if(op==='event'){
   const result=await instance.review(f.event);
   reason=JSON.stringify({wake:result.reconcile,events:0});
  }
  else if(op==='launch')await instance.launch(current,f.task);
 }catch(error){outcome={ok:false,error:error.message}}
 await instance.close();
 return normalize(JSON.parse(JSON.stringify({outcome,job:current,reason,writes})));
}
function firstDiff(a,b,path='root'){
 if(typeof a!==typeof b||a===null||b===null)return JSON.stringify(a)===JSON.stringify(b)?null:{path,expected:a,actual:b};
 if(typeof a!=='object')return Object.is(a,b)?null:{path,expected:a,actual:b};
 for(const key of [...new Set([...Object.keys(a),...Object.keys(b)])].sort()){
  if(!(key in a)||!(key in b))return {path:`${path}.${key}`,expected:a[key],actual:b[key]};
  const diff=firstDiff(a[key],b[key],`${path}.${key}`);if(diff)return diff;
 }return null;
}
test('ReconcilerReviewBase Node/Rust currentHead, stale review, route, review-event and settled gates',async()=>{
 const actual=rust(cases),expected=[];
 for(const fixture of cases)expected.push(await node(fixture));
 const failures=[];
 for(let i=0;i<cases.length;i++){
  try{assert.deepEqual(actual[i],expected[i]);}
  catch{failures.push({i,firstDifference:firstDiff(expected[i],actual[i])});}
 }
 assert.deepEqual(failures,[],JSON.stringify(failures,null,2));
 console.log('Verified',cases.length,'ReviewBase Node/Rust direct cases');
});
