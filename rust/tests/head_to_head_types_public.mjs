// Real original Node and Rust types.ts public runtime API differential:
// timeout helpers, legacy lifecycle normalization and V2 transition asserts.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {
  STORY_SIZE_TIMEOUT_MS,storySizeTimeoutMs,taskOverallTimeoutMs,
  chatGptStartAckTimeoutMs,normalizeLegacyTaskLifecycle,
  assertJobLifecycleTransition,assertTaskTransition,
} from '../../dist/types.js';

const root=resolve(import.meta.dirname,'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');
const graphDir=join(root,'workflow');
const T0='2026-11-18T09:00:00.000Z';
const T1='2026-11-18T09:30:00.000Z';
const T2='2026-11-18T11:00:00.000Z';
const taskBase=(over={})=>({id:'t1',jobId:'17',title:'Legacy probe',state:'QUEUED',
  kind:'work',agentName:'implementation',attempt:1,maxAttempts:3,timeoutMs:300000,
  result:null,error:null,createdAt:T0,updatedAt:T1,...over});
const interactive=(over={})=>({boundAt:T0,status:'running',...over});
const cases=[];
const SIZES=['S','M','L','X',undefined,null];
const REASONINGS=[undefined,null,'high','HIGH','High','x',''];
for(const size of SIZES)for(const reasoning of REASONINGS){
  cases.push({method:'storySizeTimeout',size});
  cases.push({method:'taskOverallTimeout',size,reasoning});
}
for(const ms of [0,1,119999,120000,179999,180000,359999,360000,360001,600000,1800000,1799999,5400000,999999999])
  cases.push({method:'chatGptStartAckTimeout',overallTimeoutMs:ms});
for(const agentName of ['troubleshooter','implementation',undefined])
  for(const failureReason of [undefined,null,'worker_outcome_unknown','x'])
    for(const maxAttempts of [undefined,null,2,5])
      for(const attempt of [undefined,null,1,3])
        for(const unblock of [undefined,null,{attempt:2,reason:'x'},{event:'old'}]){
          const over={state:'UNBLOCKED',kind:'work',
            ...(agentName===undefined?{}:{agentName}),
            ...(failureReason===undefined?{}:{failureReason}),
            ...(maxAttempts===undefined?{}:{maxAttempts}),
            ...(attempt===undefined?{}:{attempt}),
            ...(unblock===undefined?{}:{unblock})};
          cases.push({method:'normalizeLegacyTaskLifecycle',task:taskBase(over)});
        }
for(const attempt of [0,1,2,undefined])
  for(const executionId of [undefined,null,'','exec-1'])
    for(const invocation of [undefined,interactive({boundAt:'',status:'awaiting_decision'}),
      interactive({status:'awaiting_decision'}),interactive({status:'other'}),
      interactive({status:'other',decidedAt:T2}),
      {...interactive({status:'other',decidedAt:T2}),boundAt:''}])
      for(const updatedAt of [T0,T2]){
        const over={state:'DRAFT',kind:'work',agentName:'implementation',updatedAt,
          ...(attempt===undefined?{}:{attempt}),
          ...(executionId===undefined?{}:{executionId}),
          ...(invocation===undefined?{}:{interactiveInvocation:invocation})};
        cases.push({method:'normalizeLegacyTaskLifecycle',task:taskBase(over)});
      }
for(const kind of ['work','planner',undefined])
  for(const agentName of ['troubleshooter','implementation',undefined])
    for(const failureReason of [undefined,'worker_outcome_unknown','x'])
      for(const error of [undefined,'x']){
        const over={state:'BLOCKED',
          ...(kind===undefined?{}:{kind}),
          ...(agentName===undefined?{}:{agentName}),
          ...(failureReason===undefined?{}:{failureReason}),
          ...(error===undefined?{}:{error})};
        cases.push({method:'normalizeLegacyTaskLifecycle',task:taskBase(over)});
      }
for(const state of ['QUEUED','RUNNING','SUCCEEDED','FAILED','AWAITING_DECISION'])
  cases.push({method:'normalizeLegacyTaskLifecycle',
    task:taskBase({state,attempt:2,interactiveInvocation:interactive()})});
const JOB_STATES=['DRAFT','ACTIVE','COMPLETED','CANCELLED'];
const TASK_STATES=['DRAFT','QUEUED','RUNNING','AWAITING_DECISION','BLOCKED','SUCCEEDED','FAILED','CANCELLED'];
for(const from of [...JOB_STATES,'BOGUS',''])
  for(const to of [...JOB_STATES,'BOGUS'])
    cases.push({method:'assertJobLifecycleTransition',from,to});
for(const from of [...TASK_STATES,'BOGUS',''])
  for(const to of [...TASK_STATES,'BOGUS'])
    cases.push({method:'assertTaskTransition',from,to});
const jsonable=value=>JSON.parse(JSON.stringify(value));
function expected(f){
  if(f.method==='storySizeTimeout'){
    const value=storySizeTimeoutMs(f.size);
    return value===undefined?null:value;
  }
  if(f.method==='taskOverallTimeout'){
    const value=taskOverallTimeoutMs(f.size,f.reasoning);
    return Number.isFinite(value)?value:null;
  }
  if(f.method==='chatGptStartAckTimeout')
    return chatGptStartAckTimeoutMs(f.overallTimeoutMs);
  if(f.method==='normalizeLegacyTaskLifecycle'){
    const task=structuredClone(f.task);
    return jsonable(normalizeLegacyTaskLifecycle(task));
  }
  if(f.method==='assertJobLifecycleTransition'){
    try{assertJobLifecycleTransition(f.from,f.to);return {ok:true};}
    catch(error){return {ok:false,error:error.message};}
  }
  try{assertTaskTransition(f.from,f.to);return {ok:true};}
  catch(error){return {ok:false,error:error.message};}
}
function firstDiff(a,b,path=''){
  if(Object.is(a,b))return null;
  if(typeof a!==typeof b||a===null||b===null||typeof a!=='object')return [path,a,b];
  if(Array.isArray(a)!==Array.isArray(b))return [path,a,b];
  if(Array.isArray(a)){
    if(a.length!==b.length)return [path+'/length',a.length,b.length];
    for(let i=0;i<a.length;i++){const d=firstDiff(a[i],b[i],path+'/'+i);if(d)return d;}
    return null;
  }
  for(const k of new Set([...Object.keys(a),...Object.keys(b)])){
    const d=firstDiff(a[k],b[k],path+'/'+k);if(d)return d;
  }
  return null;
}
test('original Node/Rust types public runtime differential',()=>{
  assert.deepEqual(STORY_SIZE_TIMEOUT_MS,{S:300000,M:900000,L:2700000});
  const requests=cases.map(f=>({op:'certTypes',method:f.method,
    size:f.size===undefined?null:f.size,
    reasoning:f.reasoning===undefined?null:f.reasoning,
    overallTimeoutMs:f.overallTimeoutMs,
    task:f.task,jsonable:true,graphDir,from:f.from,to:f.to}));
  const child=spawnSync(binary,[],{cwd:root,encoding:'utf8',timeout:300000,
    input:requests.map(JSON.stringify).join('\n')+'\n',maxBuffer:64*1024*1024});
  assert.equal(child.status,0,child.stderr||String(child.error));
  const outputs=child.stdout.trim().split('\n').map(line=>{
    const parsed=JSON.parse(line);
    if(!parsed.ok)throw new Error('parity error: '+parsed.error);
    return parsed.value;
  });
  assert.equal(outputs.length,cases.length);
  const failures=[];
  for(let i=0;i<cases.length;i++){
    const diff=firstDiff(expected(cases[i]),outputs[i]);
    if(!diff)continue;
    failures.push({i,method:cases[i].method,detail:cases[i].from!==undefined
      ?`${cases[i].from}->${cases[i].to}`:JSON.stringify(cases[i].task||cases[i]).slice(0,160),
      diff});
  }
  for(const f of failures.slice(0,12))console.log('TYPES_DIFF',f.i,f.method,f.detail,
    JSON.stringify(f.diff).slice(0,300));
  assert.deepEqual(failures.map(f=>f.i),[],
    `${failures.length} original Node/Rust types mismatches`);
  console.log('Verified',cases.length,'original Node/Rust types runtime cases');
});
