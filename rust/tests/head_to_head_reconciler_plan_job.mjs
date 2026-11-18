// Direct Node Reconciler.planJob through manual-plan Graph + Store persistence
// vs Rust Reconciler.plan_job. Planner launch is simulated with durable receipt.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {Reconciler} from '../../dist/reconciler.js';
const root=resolve(import.meta.dirname,'../..');
const bin=join(root,'rust/target/debug/relay-rust2-parity');
const at='2026-11-18T09:00:00.000Z';
const make=(state='ACTIVE',plans=[],tasks=[])=>({
 id:'41',state,repository:'fixture',prNumber:0,priority:'P2',title:'Planner test',
 objective:'Build a test feature',createdAt:at,updatedAt:at,
 plans,tasks,reviewEnabled:false,headSha:'abcdef012345',pause:null,
 localMerge:null
});
const pending={id:'plan-1',jobId:'41',round:1,status:'PLANNING',
 source:'model-planner',attempt:0,maxAttempts:1,executionId:null,
 leaseOwner:null,leaseExpiresAt:null,manualPlanning:true,
 trigger:{kind:'manual'},generatedTaskIds:[],createdAt:at,updatedAt:at};
const failed={id:'t1',jobId:'41',kind:'work',state:'FAILED',
 adapter:'codex',agentName:'editor',attempt:3,maxAttempts:3,
 dependencies:[],capabilities:[],createdAt:at,updatedAt:at};
const cases=[
 {job:make()},
 {job:make(),guidance:'Plan exactly one task'},
 {job:make('DRAFT'),guidance:'Start draft planning'},
 {job:make('COMPLETED')},
 {job:make('CANCELLED')},
 {job:{...make(),pause:{at,reason:'review'}}},
 {job:make('ACTIVE',[pending])},
 {job:make('ACTIVE',[{...pending,executionId:'execution-owned'}])},
 {job:make('ACTIVE',[pending]),forceRestate:true},
 {job:make('ACTIVE',[],[failed]),forceRestate:true,guidance:'Restate failed tasks'},
 {job:make(),forceRestate:true,atomic:false},
 {job:make(),launchError:'Injected planner start failure'},
 {job:make(),atomic:false},
 {job:make('DRAFT'),atomic:false},
 {job:make('ACTIVE',[pending]),atomic:false},
];
function normalize(value){
 if(Array.isArray(value))return value.map(normalize);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value)
  .map(([key,val])=>[key,/At$/.test(key)&&typeof val==='string'&&/^20\d\d-/.test(val)?'<time>':normalize(val)]));
 return value;
}
function rust(fixtures){
 const result=spawnSync(bin,[],{cwd:root,encoding:'utf8',timeout:120000,
  input:fixtures.map(f=>JSON.stringify({op:'apiReconcilerPlanJob',root,...f})).join('\n')+'\n'});
 assert.equal(result.status,0,result.stderr||result.error?.message);
 const lines=result.stdout.trim().split('\n').map(JSON.parse);
 assert.equal(lines.length,fixtures.length);
 return lines.map(line=>normalize(line.value));
}
async function node(f){
 let current=structuredClone(f.job);
 const calls=[];
 const store={
  load:async id=>{assert.equal(id,'41');calls.push(['load']);return structuredClone(current);},
  mutateJob:f.atomic===false?undefined:async(id,mutator)=>{
   assert.equal(id,'41');calls.push(['mutate']);
   current=structuredClone(await mutator(structuredClone(current)));
   return structuredClone(current);
  },
  appendPlan:async plan=>{
   calls.push(['appendPlan',plan.id]);
   current.plans=[...(current.plans??[]),structuredClone(plan)];
  },
  saveJob:async next=>{calls.push(['saveJob']);current=structuredClone(next);},
  savePlan:async next=>{
   const pos=current.plans.findIndex(plan=>plan.id===next.id);
   if(pos>=0)current.plans[pos]=structuredClone(next);
  }
 };
 const reconciler=new Reconciler(store,{owner:'fixture',adapters:[],
  plannerTimeoutMs:f.timeoutMs??120000});
 reconciler.launchPlanner=async(job,round)=>{
  calls.push(['launch',round.id]);
  if(f.launchError)throw Error(f.launchError);
  const plan={...round,status:'SUCCEEDED',assessment:'Planner fixture receipt accepted'};
  await store.savePlan(plan);
 };
 let outcome={ok:true};
 try{outcome={ok:true,value:await reconciler.planJob('41',f.guidance,f.forceRestate??false)};}
 catch(error){outcome={ok:false,error:error.message};}
 await reconciler.close();
 return JSON.parse(JSON.stringify(normalize({outcome,job:current,calls})));
}
function firstDiff(a,b,path='root'){
 if(typeof a!==typeof b||a===null||b===null)return JSON.stringify(a)===JSON.stringify(b)?null:{path,expected:a,actual:b};
 if(typeof a!=='object')return Object.is(a,b)?null:{path,expected:a,actual:b};
 const keys=[...new Set([...Object.keys(a),...Object.keys(b)])].sort();
 for(const key of keys){
  if(!(key in a)||!(key in b))return {path:`${path}.${key}`,expected:a[key],actual:b[key]};
  const diff=firstDiff(a[key],b[key],`${path}.${key}`);
  if(diff)return diff;
 }
 return null;
}
test('Reconciler.planJob delegates to canonical manual/force-restate Plan Graph and durable Store',async()=>{
 const actual=rust(cases),expected=[];
 for(const fixture of cases)expected.push(await node(fixture));
 const diffs=[];
 for(let i=0;i<cases.length;i++){
  try{assert.deepEqual(actual[i],expected[i]);}
  catch{diffs.push({i,firstDifference:firstDiff(expected[i],actual[i])});}
 }
 assert.deepEqual(diffs,[],JSON.stringify(diffs,null,2));
 console.log('Verified',cases.length,'PlanJob Node/Rust direct cases');
});
