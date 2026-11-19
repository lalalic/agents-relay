// Real original Node and Rust Dependency Revision Graph/allocator semantics.
// Pure, disposable Job fixtures; never open the live Relay Store.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {dependencyRevisionStillCurrent,reconcileDependencyRevisionFacts}
  from '../../dist/dependency-revision-execution.js';
const root=resolve(import.meta.dirname,'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');
const stamp='2026-11-18T00:00:00.000Z';
const task=(id,deps=[],policy={})=>({
 id,jobId:'17',title:'Task '+id,kind:'work',agentName:'implementation',adapter:'script',
 priority:'P2',storySize:'S',state:'SUCCEEDED',attempt:1,maxAttempts:3,
 capabilities:['script'],workerRequirements:{capabilities:['script']},
 dependencies:deps,dependencyValidity:policy,input:'Do durable work '+id,
 result:{summary:'Done '+id},output:{kind:'task_pr'},
 parentTaskId:null,leaseOwner:null,leaseExpiresAt:null,executionId:null,threadId:null,
 createdAt:stamp,updatedAt:stamp,
});
const clone=value=>structuredClone(value);
const cases=[];
for(let i=0;i<180;i++){
 const variant=i%18;
 const mode=['rerun','revalidate','order-only'][i%3];
 const upstream=task('1');
 const original=task('2',['1'],{'1':variant===0?'order-only':mode==='order-only'?'rerun':mode});
 const unrelated=task('3');
 const job={id:'17',repository:'isolated',state:'ACTIVE',priority:'P2',
   title:'Isolated evidence',objective:'Revision semantics only',tasks:[upstream,original,unrelated],
   reviewEnabled:false,plans:[],review:{taskId:'review-5'},createdAt:stamp,updatedAt:stamp};
 const revised=task('12');revised.parentTaskId='1';
 revised.revision={kind:'rerun',originalTaskId:'1',dependencyVector:{},requestIds:['rq1'],reviewTaskId:'rev1'};
 revised.createdAt='2026-11-18T01:00:00.000Z';
 let addRevision=variant>=1&&variant!==17;
 if(addRevision)job.tasks.push(revised);
 if(variant===3||variant===9)revised.state='QUEUED';
 if(variant===10)revised.state='FAILED';
 if(variant===11)revised.state='CANCELLED';
 if(variant===4||variant===5){
   const child=task('29');child.revision={kind:mode==='rerun'?'rerun':'revalidate',
      originalTaskId:'2',dependencyVector:{'1':'12:1'},requestIds:[],reviewTaskId:'rev1'};
   child.parentTaskId='2';child.createdAt='2026-11-18T02:00:00.000Z';
   if(variant===5)child.state='QUEUED';
   job.tasks.push(child);
 }
 if(variant===6){
   const stale=task('29');stale.revision={kind:'rerun',originalTaskId:'2',
     dependencyVector:{'1':'1:1'},requestIds:[]};
   stale.state='QUEUED';stale.parentTaskId='2';job.tasks.push(stale);
 }
 if(variant===7)original.dependencies=['unavailable'];
 if(variant===8)original.dependencyValidity={'1':'invalid-mode'};
 if(variant===12)original.agentName='reviewer';
 if(variant===13)original.agentName='troubleshooter';
 if(variant===14)original.kind='planner';
 if(variant===15)original.state='QUEUED';
 if(variant===16)original.revision={kind:'rerun',originalTaskId:'1',dependencyVector:{}};
 const reservedIds=(variant===2||variant===17)?[]:['100','101','102','103','104'];
 if(variant===1||variant===6||variant===7||variant===8||variant===11||variant===12)
   job.tasks=[...job.tasks].reverse();
 cases.push({op:'certDependencyRevisionExecution',method:'reconcileFacts',job,
   reservedIds});
 const candidate=job.tasks.find(x=>x.id==='2');
 cases.push({op:'certDependencyRevisionExecution',method:'stillCurrent',job,task:candidate});
 const revision=task('64');revision.revision={kind:'revalidate',originalTaskId:'2',
   dependencyVector:{'1':variant%4===0?'1:1':'12:1'}};
 cases.push({op:'certDependencyRevisionExecution',method:'stillCurrent',job,task:revision});
}
function normalize(v){
 if(Array.isArray(v))return v.map(normalize);
 if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,normalize(x)]));
 return typeof v==='string'&&/^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)&&
     !v.startsWith('2026-11-18')?'<dynamic-now>':v;
}
async function original(f){
 try{
  if(f.method==='stillCurrent')return {ok:true,value:dependencyRevisionStillCurrent(f.job,f.task)};
  const job=clone(f.job);
  const created=reconcileDependencyRevisionFacts(job,f.reservedIds);
  return {ok:true,value:normalize({created,job})};
 }catch(e){return {ok:false,error:e?.message??String(e)};}
}
function firstDiff(a,b,path=''){
 if(Object.is(a,b))return null;
 if(typeof a!==typeof b||a===null||b===null||typeof a!=='object')return [path,a,b];
 for(const k of new Set([...Object.keys(a),...Object.keys(b)])){
  const d=firstDiff(a[k],b[k],path+'/'+k);if(d)return d;
 }
 return null;
}
test('540 direct original Node/Rust Dependency Revision public cases',async()=>{
 const expected=[];for(const f of cases)expected.push(await original(f));
 const child=spawnSync(binary,[],{cwd:root,encoding:'utf8',timeout:120000,
   input:cases.map(JSON.stringify).join('\n')+'\n',maxBuffer:30*1024*1024});
 assert.equal(child.status,0,child.stderr||String(child.error));
 const outputs=child.stdout.trim().split('\n').map(JSON.parse);
 assert.equal(outputs.length,cases.length);
 const failures=[];
 for(let i=0;i<cases.length;i++){
  const actual=normalize(outputs[i]);
  const expectedCase=expected[i];
  if(!firstDiff(expectedCase,actual))continue;
  failures.push({i,method:cases[i].method,variant:Math.floor(i/3)%18,
    diff:firstDiff(expectedCase,actual)});
 }
 for(const f of failures.slice(0,17))console.log('REVISION_DIFF',f.i,f.method,f.variant,JSON.stringify(f.diff).slice(0,350));
 assert.deepEqual(failures.map(f=>f.i),[],`${failures.length} original Node/Rust public API mismatches`);
 console.log('Verified',cases.length,'Node/Rust Dependency Revision public cases');
});
