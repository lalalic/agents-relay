// Direct Node launchPlanExecution vs native owned-process/SQLite orchestration.
// Fixture-owned planners are promises/closures, not real models or services.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {launchPlanExecution} from '../../dist/planner-runtime.js';
const root=resolve(import.meta.dirname,'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');
const stamp='2026-11-18T08:00:00.000Z',now='2026-11-18T09:00:00.000Z';
const plan=(status='PLANNING',exec=null)=>({id:'plan-1',jobId:'41',
 status,round:1,source:'model-planner',executionId:exec,
 leaseOwner:exec?'relay':null,leaseExpiresAt:exec?'2026-11-19T09:00:00Z':null,
 attempt:0,maxAttempts:3,manualPlanning:false,createdAt:stamp,
 updatedAt:stamp,headSha:'head',trigger:{source:'manual'},forceRestate:false});
const task=(state='SUCCEEDED')=>({id:'work1',jobId:'41',kind:'work',title:'Work',
 agentName:'worker',state,adapter:'codex',attempt:1,maxAttempts:3,
 executionId:state==='RUNNING'?'worker-ex1':null,
 leaseOwner:state==='RUNNING'?'worker':null,
 leaseExpiresAt:state==='RUNNING'?'2026-11-19T09:00:00Z':null,
 dependencies:[],createdAt:stamp,updatedAt:stamp});
const job=(p=plan(),tasks=[task()])=>({id:'41',repository:'fixture',
 prNumber:0,title:'Planner launch',objective:'Complete work',
 state:'ACTIVE',createdAt:stamp,updatedAt:stamp,headSha:'head',
 reviewEnabled:false,pause:null,tasks,plans:p?[p]:[]});
const raw={objective_status:'satisfied',assessment:'Complete',next_tasks:[],unblocks:[]};
const cases=[
 {job:job(),planner:false},
 {job:job(),planner:false,atomic:false},
 {job:job(plan('SUCCEEDED')),planner:false},
 {job:job(),planner:false,plan:{...plan(),executionId:'wrong'}},
 {job:job(),planner:true},
 {job:job(),planner:true,raw},
 {job:job(),planner:true,raw,wait:false,settle:true},
 {job:job(plan('COMPLETED')),planner:true,raw},
 {job:job(plan('FAILED')),planner:true,raw},
 {job:job(),planner:true,raw,contextError:'Planner context failed'},
 {job:job(),planner:true,raw,error:'Planner command failed'},
 {job:job(plan('PLANNING', 'ex1')),planner:true,raw,live:'ex1'},
 {job:job(plan('PLANNING','ex1')),planner:true,raw},
 {job:{...job(),pause:{at:stamp,reason:'review'}},planner:true,raw},
 {job:job(plan(),[task('RUNNING')]),planner:true,raw},
 {job:job(null),planner:true,raw,plan:plan()},
 {job:job({...plan(),timeoutMs:60000}),planner:true,raw},
 {job:job({...plan(),manualPlanning:true}),planner:true,raw},
 {job:job({...plan(),attempt:2}),planner:true,raw,error:'Terminal failure'},
 {job:job({...plan(),attempt:2}),planner:true,raw,wait:false,settle:true},
];
function normalize(x){
 if(Array.isArray(x))return x.map(normalize);
 if(x&&typeof x==='object')return Object.fromEntries(Object.entries(x)
  .map(([k,v])=>[k,/At$/.test(k)&&typeof v==='string'&&/^20\d\d-/.test(v)?'<time>':
  /(executionId|ExecutionId)$/.test(k)&&typeof v==='string'&&/^[0-9a-f]{8}-/.test(v)?'<uuid>':normalize(v)]));
 return x;
}
function rust(fixtures){
 const child=spawnSync(binary,[],{cwd:root,encoding:'utf8',timeout:120000,
 input:fixtures.map(f=>JSON.stringify({op:'apiPlannerLaunch',root,now,planId:'plan-1',...f})).join('\n')+'\n',maxBuffer:10*1024*1024});
 assert.equal(child.status,0,child.stderr||child.error?.message);
 const values=child.stdout.trim().split('\n').map(JSON.parse);
 assert.equal(values.length,fixtures.length);
 return values.map(row=>normalize(row.value));
}
async function node(f){
 const calls=[];
 let current=structuredClone(f.job),pending=[];
 let live=null;
 const store={
  load:async id=>{calls.push(['load',id]);return structuredClone(current);},
  savePlan:async plan=>{calls.push(['savePlan',plan.id,plan.status]);
   const i=current.plans.findIndex(p=>p.id===plan.id);
   if(i>=0)current.plans[i]=structuredClone(plan);
  },
  headSha:async()=>{calls.push(['headSha']);return null;},
  listAgents:async()=>{calls.push(['workers']);return [];},
 };
 if(f.atomic!==false)store.mutateJob=async(id,callback)=>{
  calls.push(['mutate',id]);current=structuredClone(await callback(structuredClone(current)));
  return structuredClone(current);
 };
 const lives=new class extends Map{
  set(id,value){calls.push(['live',id,current.plans.find(p=>p.id===id)?.timeoutMs??120000]);
   live=value.executionId;return super.set(id,value);}
  delete(id){if(this.has(id)){calls.push(['release',id]);live=null;}
   return super.delete(id);}
 };
 if(f.live)lives.set('plan-1',{executionId:f.live,
  controller:new AbortController(),timer:setTimeout(()=>{},120000)});
 if(f.live)calls.length=0;
 const planner=f.planner===false?undefined:{
  plan:async()=>{
   calls.push(['plan']);
   if(f.delayMs)await new Promise(resolve=>setTimeout(resolve,f.delayMs));
   if(f.error)throw Error(f.error);
   return structuredClone(f.raw??null);
  }
 };
 const ports={store,live:lives,
  options:{owner:'relay',planner,adapters:[],leaseMs:300000,
   plannerTimeoutMs:120000,now:new Date(f.now??now)},
  plannerContext:async()=>{
   calls.push(['context']);if(f.contextError)throw Error(f.contextError);
   return {};
  },
  emit:async event=>{calls.push(['emit',event.type]);},
  reconcile:async(id)=>{calls.push(['reconcile',id,'planner follow-up reconciliation']);},
  detach:(promise,id,planId,why)=>{
   const last=calls.findLast(call=>call[0]==='reconcile'&&call[1]===id);
   if(last)last[2]=why;
   calls.push(['detach',id,planId]);
   pending.push(Promise.resolve(promise).catch(error=>{
    calls.push(['detached_failure',error.message]);
   }));
  }
 };
 let outcome={ok:true};
 try{await launchPlanExecution(ports,structuredClone(f.job),
  structuredClone(f.plan??f.job.plans[0]??plan()),f.wait!==false);}
 catch(error){outcome={ok:false,error:error.message};}
 if(f.wait===false&&f.settle)await Promise.all(pending);
 for(const item of lives.values())clearTimeout(item.timer);
 return normalize(JSON.parse(JSON.stringify({outcome,calls,job:current,
  live,planner:f.planner!==false})));
}
function firstDiff(a,b,path='root'){
 if(typeof a!==typeof b||a===null||b===null)return JSON.stringify(a)===JSON.stringify(b)?null:{path,expected:a,actual:b};
 if(typeof a!=='object')return Object.is(a,b)?null:{path,expected:a,actual:b};
 for(const k of [...new Set([...Object.keys(a),...Object.keys(b)])].sort()){
  if(!(k in a)||!(k in b))return {path:`${path}.${k}`,expected:a[k],actual:b[k]};
  const v=firstDiff(a[k],b[k],`${path}.${k}`);if(v)return v;
 }return null;
}
test('launchPlanExecution Node/Rust durable lease, worker slot, live de-dup and owned wait/detach settlement',async()=>{
 const actual=rust(cases),expected=[];
 for(const scenario of cases)expected.push(await node(scenario));
 const failures=[];
 for(let i=0;i<cases.length;i++){
  try{assert.deepEqual(actual[i],expected[i]);}
  catch{failures.push({i,difference:firstDiff(expected[i],actual[i])});}
 }
 assert.deepEqual(failures,[],JSON.stringify(failures,null,2));
 console.log('Verified',cases.length,'Node/Rust Planner launch scenarios');
});
