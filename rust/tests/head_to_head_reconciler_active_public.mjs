import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {Reconciler} from '../../dist/reconciler.js';
const root=resolve(import.meta.dirname,'../..');
const bin=join(root,'rust/target/debug/relay-rust2-parity');
const at='2026-11-18T09:00:00.000Z';
const task=(state)=>({id:'t-1',jobId:'1',kind:'work',agentName:'worker',adapter:'script',
 title:'Safe no-command fixture',input:'test fixture',state,
 createdAt:at,updatedAt:at,attempt:state==='SUCCEEDED'?1:0,maxAttempts:2,
 dependencies:[],executionId:null,leaseOwner:null,leaseExpiresAt:null,timeoutMs:10000});
const job=(tasks=[])=>({id:'1',repository:'fixture',prNumber:0,title:'Graph without providers',
 objective:'Finish',state:'ACTIVE',createdAt:at,updatedAt:at,
 tasks,plans:[],reviewEnabled:false,pause:null,headSha:null});
const cases=[{job:job()}, {job:job([task('QUEUED')])},
 {job:job([task('SUCCEEDED')])}, {job:job([task('DRAFT')])}];
function normalized(x){
 if(Array.isArray(x))return x.map(normalized);
 if(x&&typeof x==='object')return Object.fromEntries(Object.entries(x)
  .map(([key,val])=>[key,/At$/.test(key)&&typeof val==='string'&&/^20\d\d-/.test(val)?'<time>':normalized(val)]));
 return x;
}
function wire(value){return JSON.parse(JSON.stringify(normalized(value)));}
function rust(){
 const child=spawnSync(bin,[],{cwd:root,encoding:'utf8',timeout:120000,
 input:cases.map(f=>JSON.stringify({op:'apiReconcilerReconcile',root,jobId:'1',...f})).join('\n')+'\n',maxBuffer:8*1024*1024});
 assert.equal(child.status,0,child.stderr||child.error?.message);
 return child.stdout.trim().split('\n').map(JSON.parse).map(x=>wire(x.value));
}
async function node(f){
 let current=structuredClone(f.job);const calls=[];
 const store={
  load:async()=>structuredClone(current),
  saveJob:async j=>{current=structuredClone(j);},
  appendPlan:async p=>{current.plans??=[];current.plans.push(structuredClone(p));},
  appendTask:async t=>{current.tasks.push(structuredClone(t));},
  saveTask:async t=>{const i=current.tasks.findIndex(x=>x.id===t.id);if(i>=0)current.tasks[i]=structuredClone(t);},
  mutateJob:async (id,cb)=>{current=structuredClone(await cb(structuredClone(current)));return structuredClone(current);},
  listAgents:async()=>[],
 };
 const rec=new Reconciler(store,{owner:'fixture',adapters:[],noGitHub:true,maxConcurrent:4,
  emit:async event=>{calls.push(['emit',event.type]);}});
 rec.currentHeadSha=async()=>null;
 rec.launch=async(_job,t)=>calls.push(['launch',t.id]);
 rec.launchPlanner=async(_job,p)=>calls.push(['planner',p.id]);
 const outcome=await rec.reconcile('1').then(value=>({ok:true,value}),error=>({ok:false,error:error.message}));
 await rec.close();
 return wire({outcome,job:current,calls});
}
function diff(a,b,path='root'){
 if(typeof a!==typeof b||a===null||b===null)return JSON.stringify(a)===JSON.stringify(b)?null:{path,a,b};
 if(typeof a!=='object')return Object.is(a,b)?null:{path,a,b};
 for(const key of [...new Set([...Object.keys(a),...Object.keys(b)])].sort()){
  if(!(key in a)||!(key in b))return {path:path+'.'+key,a:a[key],b:b[key]};
  const next=diff(a[key],b[key],path+'.'+key);if(next)return next;
 }return null;
}
test('Reconciler ACTIVE Graph decisions with safe intercepted provider effects Node/Rust',async()=>{
 const actual=rust(),expected=[];
 for(const f of cases)expected.push(await node(f));
 const differences=[];
 for(let i=0;i<cases.length;i++){
  const comparison={outcome:actual[i].outcome,job:actual[i].job};
  const first=diff({outcome:expected[i].outcome,job:expected[i].job},comparison);
  if(first)differences.push({case:i,...first});
 }
 assert.deepEqual(differences,[],JSON.stringify(differences,null,2));
 console.log('Verified',cases.length,'active Graph decision cases without provider execution');
});
