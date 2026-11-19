// Real original Node and Rust interactive resume differential: identity-fenced
// resume over the canonical Task lifecycle Graph, changes_requested comment
// semantics, restart-safe recovery over the interactive-invocation Graph and
// an isolated real SQLite store. AGENTS_RELAY_STORE_DIR is disposable.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {
  resumeInteractiveTask,recoverInteractiveDecisions,
} from '../../dist/interactive-resume.js';

const root=resolve(import.meta.dirname,'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');
const graphDir=join(root,'workflow');
process.env.AGENTS_RELAY_STORE_DIR=mkdtempSync(join(tmpdir(),'r2-interactive-resume-'));
const T0='2026-11-18T11:00:00.000Z';
const T1='2026-11-18T11:30:00.000Z';

const invocation=(over={})=>({invocationId:'inv-1',revision:'r1',
  status:'awaiting_decision',boundAt:T0,...over});
const decided=(over={})=>invocation({decidedAt:T1,...over});
const task=(id,over={})=>({id,jobId:'17',title:'Interactive probe',state:'AWAITING_DECISION',
  kind:'work',agentName:'implementation',attempt:2,maxAttempts:3,timeoutMs:300000,
  result:null,error:'previous failure',failureReason:'worker_platform_failure',
  createdAt:T0,updatedAt:T0,comments:[],...over});
const jobWith=(tasks,over={})=>({id:'17',projectRoot:'/tmp/r2-interactive-fixture',
  repository:'owner/interactive-probe',prNumber:0,state:'ACTIVE',title:'Probe',
  objective:'Probe',tasks,priority:'P2',createdAt:T0,updatedAt:T0,plans:[],...over});

function mutateFixture(job){
  const jobs=new Map([[job.id,structuredClone(job)]]);
  return {
    load:async id=>structuredClone(jobs.get(id)),
    mutateJob:async(id,mutation)=>{
      const current=structuredClone(jobs.get(id));
      const before=structuredClone(current);
      const observed=mutation(current);
      jobs.set(id,observed);
      return observed;
    },
    _before:before=>before,
  };
}
async function nodeResume(job,taskId,invocationId,revision,decision){
  const store=mutateFixture(job);
  const resumed=await resumeInteractiveTask(store,job.id,taskId,
    invocationId,revision,decision);
  return {resumed,job:await store.load(job.id)};
}
async function nodeRecover(job){
  const store=mutateFixture(job);
  const recovered=await recoverInteractiveDecisions(store,job.id);
  return {recovered,job:await store.load(job.id)};
}
function jsonable(value){
  if(typeof value==='number'){
    // JSON serialization drops NaN/Infinity keys; the Rust side already went
    // through a JSON pipeline, so normalize the same way here.
    if(!Number.isFinite(value))return undefined;
    return value;
  }
  if(typeof value==='string'){
    if(/^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d/.test(value))return '<iso>';
    if(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value))return '<uuid>';
    return value;
  }
  if(Array.isArray(value))return value.map(jsonable);
  if(value&&typeof value==='object'){
    const entries=Object.entries(value)
      .map(([k,v])=>[k,jsonable(v)])
      .filter(([,v])=>v!==undefined);
    return Object.fromEntries(entries);
  }
  return value;
}
const DECISIONS=['approved','changes_requested','rejected','awaiting_decision','other'];
const INVOCATION_STATES=[
  decided({status:'approved'}),
  decided({status:'changes_requested',feedback:'  Please rework the error handling.  '}),
  decided({status:'changes_requested',feedback:''}),
  decided({status:'changes_requested',feedback:'   '}),
  decided({status:'changes_requested',feedback:'x'.repeat(1500)}),
  decided({status:'changes_requested',feedback:'emoji 😀😀 review'}),
  decided({status:'rejected'}),
  decided({status:'approved',invocationId:'inv-OTHER'}),
  decided({status:'approved',revision:'r-OTHER'}),
  decided({status:'approved',decidedAt:null}),
  decided({status:'approved',decidedAt:undefined}),
  invocation(),
];
const TASK_VARIANTS=[
  {},
  {state:'QUEUED'},{state:'RUNNING'},{state:'SUCCEEDED'},
  {maxAttempts:undefined},{maxAttempts:null},{maxAttempts:1},{maxAttempts:9},
  {attempt:0},{attempt:7},{kind:'planner'},
  {executionId:'exec-9',leaseOwner:'worker-1',leaseExpiresAt:T1},
  {blockedBy:{repository:'o/r',pr_number:3,job_id:'18',blocked_attempt:1,
    registered_at:T0}},
  {comments:[{id:'c0',text:'existing',author:'cli',createdAt:T0,jobId:'17',taskId:'t1'}]},
  {comments:undefined},
];
const cases=[];
let index=0;
for(const variant of TASK_VARIANTS)for(const inv of INVOCATION_STATES){
  cases.push({method:'resume',taskId:'t1',invocationId:'inv-1',revision:'r1',
    decision:inv.status,job:jobWith([task('t1',{interactiveInvocation:inv,...variant})])});
  index++;
}
for(const [taskId,invocationId,revision,decision] of [
  ['t-missing','inv-1','r1','approved'],
  ['t2','inv-1','r1','approved'],
]){
  cases.push({method:'resume',taskId,invocationId,revision,decision,
    job:jobWith([task('t2',{interactiveInvocation:decided({status:'approved'})})])});
}
const RECOVERY_JOBS=[
  jobWith([task('t1',{interactiveInvocation:decided({status:'approved'})}),
    task('t2',{interactiveInvocation:decided({status:'changes_requested',feedback:'rework'})}),
    task('t3',{interactiveInvocation:invocation()}),
    task('t4',{state:'RUNNING',interactiveInvocation:decided({status:'approved'})}),
    task('t5',{interactiveInvocation:decided({status:'rejected'})}),
    task('t6',{interactiveInvocation:decided({status:'unknown_status'})}),
    task('t7',{state:'QUEUED',interactiveInvocation:decided({status:'approved'})}),
    task('t8')]),
  jobWith([task('t1',{interactiveInvocation:decided({status:'awaiting_decision'})})]),
  jobWith([]),
  jobWith([task('t1',{interactiveInvocation:decided({status:'approved'}),
    state:'AWAITING_DECISION',maxAttempts:undefined})]),
];
for(const job of RECOVERY_JOBS){
  cases.push({method:'recover',job,jobId:job.id});
  cases.push({method:'recoverable',job});
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
test('original Node/Rust interactive resume differential',async()=>{
  const expectedList=[];
  for(const fixture of cases){
    if(fixture.method==='resume'){
      try{
        const outcome=await nodeResume(structuredClone(fixture.job),fixture.taskId,
          fixture.invocationId,fixture.revision,fixture.decision);
        expectedList.push({resumed:outcome.resumed,job:jsonable(outcome.job)});
      }catch(error){expectedList.push({error:error?.message??String(error)});}
      continue;
    }
    if(fixture.method==='recoverable'){
      // Node has no separate public recoverable list; derive it from the
      // recovery loop's own eligibility (state, decidedAt, status).
      const eligible=fixture.job.tasks.filter(t=>
        t.state==='AWAITING_DECISION'&&t.interactiveInvocation?.decidedAt
        &&t.interactiveInvocation.status!=='awaiting_decision')
        .map(t=>[t.id,t.interactiveInvocation.invocationId,
          t.interactiveInvocation.revision,t.interactiveInvocation.status]);
      expectedList.push(jsonable(eligible));
      continue;
    }
    try{
      const outcome=await nodeRecover(structuredClone(fixture.job));
      expectedList.push({recovered:outcome.recovered,job:jsonable(outcome.job)});
    }catch(error){expectedList.push({error:error?.message??String(error)});}
  }
  const rustStore=mkdtempSync(join(tmpdir(),'r2-interactive-rust-store-'));
  const stdout=await new Promise((resolve,reject)=>{
    const child=spawn(binary,[],{cwd:root});
    let out='',err='';
    child.stdout.on('data',chunk=>out+=chunk);
    child.stderr.on('data',chunk=>err+=chunk);
    child.on('error',reject);
    child.on('close',code=>{
      if(code!==0)reject(new Error(err||`parity binary exited ${code}`));
      else resolve(out);
    });
    child.stdin.end(cases.map((f,i)=>JSON.stringify({op:'certInteractiveResume',
      ...f,graphDir,storeDir:join(rustStore,`store-${i}`)})).join('\n')+'\n');
    const timer=setTimeout(()=>{child.kill();reject(new Error('parity timeout'));},300000);
    timer.unref();
  });
  const outputs=stdout.trim().split('\n').map(line=>{
    const parsed=JSON.parse(line);
    return parsed.ok?jsonable(parsed.value):{error:parsed.error};
  });
  assert.equal(outputs.length,cases.length);
  const failures=[];
  for(let i=0;i<cases.length;i++){
    const want=expectedList[i];
    const got=outputs[i];
    let diff=null;
    if(want.error||got.error){
      if(!want.error||!got.error||want.error!==got.error)diff=[null,want.error,got.error??got];
    }else{
      diff=firstDiff(want,got);
    }
    if(!diff)continue;
    failures.push({i,method:cases[i].method,diff});
  }
  for(const f of failures.slice(0,12))console.log('IR_DIFF',f.i,f.method,
    JSON.stringify(f.diff).slice(0,360));
  assert.deepEqual(failures.map(f=>f.i),[],
    `${failures.length} original Node/Rust interactive resume mismatches`);
  console.log('Verified',cases.length,'original Node/Rust interactive resume cases');
});
