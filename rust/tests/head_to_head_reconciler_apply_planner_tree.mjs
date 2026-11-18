import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {Reconciler} from '../../dist/reconciler.js';
const root=resolve(import.meta.dirname,'../..');
const bin=join(root,'rust/target/debug/relay-rust2-parity');
const at='2026-11-18T10:00:00.000Z';
const plan=(status='PLANNING',executionId='ex1')=>({
 id:'plan-1',jobId:'41',status,round:1,source:'model-planner',
 executionId,leaseOwner:'relay',leaseExpiresAt:'2026-11-20T10:00:00Z',
 attempt:1,maxAttempts:3,manualPlanning:true,headSha:'head',
 createdAt:at,updatedAt:at,trigger:{source:'manual'},
 forceRestate:false,generatedTaskIds:[],guidance:'Plan task'});
const done={id:'work1',jobId:'41',kind:'work',state:'SUCCEEDED',
 agentName:'worker',adapter:'codex',title:'Done',executionId:null,
 leaseOwner:null,leaseExpiresAt:null,attempt:1,maxAttempts:3,
 dependencies:[],createdAt:at,updatedAt:at};
const job=(p=plan())=>({id:'41',title:'Planner test',repository:'fixture',prNumber:0,
 objective:'Complete work',state:'ACTIVE',createdAt:at,updatedAt:at,
 tasks:[done],plans:p?[p]:[],headSha:'head',reviewEnabled:false,pause:null});
const proposal={objective_status:'satisfied',assessment:'Implementation complete',next_tasks:[],unblocks:[]};
const cases=[
 {job:job(),proposal},
 {job:job(null),proposal},
 {job:job(plan('FAILED')),proposal},
 {job:job(plan('SUCCEEDED')),proposal},
 {job:job(),proposal,executionId:'wrong'},
 {job:job(),proposal,executionId:'wrong',live:'ex1'},
 {job:job(),proposal,atomic:false},
 {job:job(),proposal:{objective_status:'invalid'}},
 {job:job(),proposal:{...proposal,objective_status:'unknown'}},
 {job:job(),proposal:null},
 {job:job(),proposal:{...proposal,next_tasks:[{title:'Build'}]}},
 {job:job(),proposal:{...proposal,history_cleanup:'invalid'}},
];
function normalize(value){
 if(Array.isArray(value))return value.map(normalize);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value)
  .map(([key,val])=>[key,/At$/.test(key)&&typeof val==='string'&&/^20\d\d-/.test(val)?'<time>':normalize(val)]));
 return value;
}
function rust(){
 const result=spawnSync(bin,[],{cwd:root,encoding:'utf8',timeout:120000,
 input:cases.map(f=>JSON.stringify({op:'apiPlannerApplyTree',root,
  jobId:'41',planId:'plan-1',executionId:'ex1',...f})).join('\n')+'\n',
 maxBuffer:8*1024*1024});
 assert.equal(result.status,0,result.stderr||result.error?.message);
 const rows=result.stdout.trim().split('\n').map(JSON.parse);
 assert.equal(rows.length,cases.length);
 return rows.map(row=>normalize(row.value));
}
async function node(f){
 let current=structuredClone(f.job), live=f.live??null;
 const calls=[];
 const store={
  load:async id=>{calls.push(['load',id]);return structuredClone(current);},
  listAgents:async()=>{calls.push(['workers']);return structuredClone(f.workers??[]);},
  savePlan:async plan=>{calls.push(['savePlan',plan.id,plan.status]);},
 };
 if(f.atomic!==false)store.mutateJob=async(id,mutation)=>{
  calls.push(['mutate',id]);
  current=structuredClone(await mutation(structuredClone(current)));
  return structuredClone(current);
 };
 const rec=new Reconciler(store,{owner:'relay',adapters:[],noGitHub:true});
 rec.plannerContext=async()=>{calls.push(['context']);return f.context??null;};
 rec.emit=async event=>{calls.push(['emit',event.type]);};
 rec.reconcile=async id=>{calls.push(['reconcile',id,'planner follow-up reconciliation']);return current;};
 const old=rec.plannerLive;
 if(live)old.set('plan-1',{executionId:live,controller:new AbortController(),
  timer:setTimeout(()=>{},100000)});
 const deletion=old.delete.bind(old);
 old.delete=key=>{if(old.has(key))calls.push(['release',key]);return deletion(key);};
 let outcome;
 try{outcome={ok:true,value:await rec.applyPlannerTree('41','plan-1',f.executionId??'ex1',f.proposal)};}
 catch(error){outcome={ok:false,error:error.message};}
 const remainingLive=old.get('plan-1')?.executionId??null;
 for(const entry of old.values())clearTimeout(entry.timer);
 await rec.close();
 return normalize(JSON.parse(JSON.stringify({outcome,job:current,calls,live:remainingLive})));
}
function diff(a,b,path='root'){
 if(typeof a!==typeof b||a===null||b===null)return JSON.stringify(a)===JSON.stringify(b)?null:{path,a,b};
 if(typeof a!=='object')return Object.is(a,b)?null:{path,a,b};
 for(const key of [...new Set([...Object.keys(a),...Object.keys(b)])].sort()){
  if(!(key in a)||!(key in b))return{path:path+'.'+key,a:a[key],b:b[key]};
  const r=diff(a[key],b[key],path+'.'+key);if(r)return r;
 }
 return null;
}
test('Reconciler.applyPlannerTree direct Node/Rust CLI candidate and atomic Plan effect parity',async()=>{
 const actual=rust(),expected=[];
 for(const f of cases)expected.push(await node(f));
 const differences=[];
 for(let i=0;i<cases.length;i++){
  const d=diff(expected[i],actual[i]);if(d)differences.push({case:i,...d});
 }
 assert.deepEqual(differences,[],JSON.stringify(differences,null,2));
 console.log('Verified',cases.length,'applyPlannerTree Node/Rust direct fixtures');
});
