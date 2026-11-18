// CLI public factories, real Node import and native Graph-backed Rust effects.
// No Codex or live service is launched. SQLite authority tested separately.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {dashboardJobAction,runtimePlanner} from '../../dist/cli.js';
const root=resolve(import.meta.dirname,'../..');
const bin=join(root,'rust/target/debug/relay-rust2-parity');
function rust(cases){
 const result=spawnSync(bin,[],{cwd:root,encoding:'utf8',timeout:120000,
  input:cases.map(f=>JSON.stringify({op:'apiCliRuntimePublic',root,...f})).join('\n')+'\n'});
 assert.equal(result.status,0,result.stderr||result.error?.message);
 const rows=result.stdout.trim().split('\n').map(JSON.parse);
 assert.equal(rows.length,cases.length);
 return rows.map(row=>row.value);
}
const planArgs=[[],['--planner-command','./fixture-planner'],
 ['--codex','/bin/fixture-agent'],['--planner-command','','--codex','/bin/mock-agent'],
 ['--planner-command','fixture1','--planner-command','fixture2'],
 ['--codex','fixture-model','--planner-command','mock-plan'],
 ['--planner-command'],['--codex'],['--planner-command','literal space']];
test('runtimePlanner constructs genuine Agent/Command planners with CLI precedence',()=>{
 const scenarios=planArgs.map(args=>({kind:'planner',args}));
 const expected=planArgs.map(args=>({kind:runtimePlanner(args).constructor.name}));
 assert.deepEqual(rust(scenarios),expected);
 console.log('Verified',scenarios.length,'runtimePlanner direct constructor cases');
});
const make=(state='DRAFT',tasks=[],plans=[])=>({
 id:'job1',repository:'fixture',prNumber:0,state,
 title:'Fixture',objective:'Local test',priority:'P2',
 createdAt:'2026-11-18T10:00:00Z',updatedAt:'2026-11-18T10:00:00Z',
 tasks,plans,reviewEnabled:false,pause:null,headSha:'abc',
 localMerge:null
});
const task={id:'task1',jobId:'job1',kind:'work',state:'RUNNING',
 leaseOwner:'owner',leaseExpiresAt:'2026-11-18T12:00:00Z',executionId:'e1',
 dependencies:[],capabilities:[],attempt:1,maxAttempts:3};
const plan={id:'plan1',jobId:'job1',status:'PLANNING',executionId:'p1',
 leaseOwner:'planner',leaseExpiresAt:'2026-11-18T12:00:00Z'};
const cases=[
 {action:'start',job:make()},
 {action:'start',job:make('ACTIVE')},
 {action:'start',job:make('COMPLETED')},
 {action:'reconcile',job:make()},
 {action:'reconcile',job:make('ACTIVE',[task])},
 {action:'cancel',job:make()},
 {action:'cancel',job:make('ACTIVE')},
 {action:'cancel',job:make('ACTIVE',[task],[plan])},
 {action:'cancel',job:make('COMPLETED')},
 {action:'cancel',job:make('CANCELLED')},
 {action:'cancel',job:make('ACTIVE',[task]),atomic:false},
 {action:'start',job:make('DRAFT'),atomic:false},
 {action:'reconcile',job:null},
 {action:'cancel',job:null},
];
function normalize(v){
 if(Array.isArray(v))return v.map(normalize);
 if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v)
  .map(([k,value])=>[k,/At$/.test(k)&&typeof value==='string'&&/^20\d\d-/.test(value)?'<time>':normalize(value)]));
 return v;
}
async function nodeAction(f){
 let current=structuredClone(f.job),calls=[];
 const store={
  load:async id=>{calls.push(['load',id]);if(!current)throw Error(`Job ${id} missing`);return structuredClone(current);},
  saveJob:async value=>{calls.push(['save',value.state]);current=structuredClone(value);},
  savePlan:async plan=>{calls.push(['savePlan',plan.id,plan.status]);},
  saveTask:async task=>{calls.push(['saveTask',task.id,task.state]);},
 };
 if(f.atomic!==false)store.mutateJob=async(id,update)=>{
  calls.push(['mutate',id]);const next=await update(structuredClone(current));
  current=structuredClone(next);return structuredClone(current);
 };
 const reconciler={wake:async id=>{calls.push(['wake',id]);return structuredClone(current);}};
 const run=dashboardJobAction(store,reconciler,f.action);
 let outcome={ok:true};
 try{outcome={ok:true,value:await run('job1')};}
 catch(error){outcome={ok:false,error:error.message};}
 return normalize({outcome,calls,job:current});
}
test('dashboardJobAction preserves Graph and durable Store effect boundaries',async()=>{
 const expected=[];
 for(const fixture of cases)expected.push(await nodeAction(fixture));
 const actual=rust(cases).map(normalize);
 const differences=[];
 for(let i=0;i<cases.length;i++){
  try{assert.deepEqual(actual[i],expected[i]);}
  catch{differences.push({i,fixture:cases[i],expected:expected[i],actual:actual[i]});}
 }
 assert.deepEqual(differences,[],JSON.stringify(differences,null,2));
 console.log('Verified',cases.length,'Dashboard Job Graph/Store cases');
});
