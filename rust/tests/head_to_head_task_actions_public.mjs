// Independent differential for src/task-actions.ts: all exported snapshot
// appliers and dispatchTaskAction over the real lifecycle/resolution Graph.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  applyTaskRetryAction,applyTaskUnblockRetryAction,applyTaskCancelAction,
  applyTaskReleaseAction,applyTaskHoldAction,applyTaskQueueAction,
  dispatchTaskAction,
} from '../../dist/task-actions.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');

async function parity(request){
  return await new Promise((resolvePromise,reject)=>{
    const child=spawn(binary,[],{cwd:root});
    let out='',err='';
    child.stdout.on('data',c=>out+=c);
    child.stderr.on('data',c=>err+=c);
    child.on('error',reject);
    child.on('close',code=>{
      if(code!==0)return reject(new Error(err||`parity exited ${code}`));
      try{
        const parsed=JSON.parse(out.trim());
        if(!parsed.ok)throw new Error('parity error: '+parsed.error);
        resolvePromise(parsed.value);
      }catch(e){reject(new Error(`parity JSON: ${e.message}: ${out.slice(0,300)}`));}
    });
    child.stdin.end(JSON.stringify(request)+'\n');
  });
}
const baseTask=(state,over={})=>({id:'t1',kind:'work',state,
  attempt:1,maxAttempts:3,error:'boom',leaseOwner:'w',leaseExpiresAt:'x',
  executionId:'ex-1',dependencies:[],routing:{provider:'p'},
  workerSelection:{workerId:'w'},...over});
function normalize(task){
  task=JSON.parse(JSON.stringify(task));
  if(task.updatedAt)task.updatedAt='<now>';
  if(task.resolution?.updatedAt)task.resolution.updatedAt='<now>';
  return task;
}
async function nodeRun(method,fixture){
  const graphDir=mkdtempSync(join(tmpdir(),'rust2-ta-n-'));
  try{
    if(method==='dispatch'){
      // dispatch needs a store with mutateJob.
      let job=JSON.parse(JSON.stringify(fixture.job));
      const store={
        async load(){return JSON.parse(JSON.stringify(job));},
        async mutateJob(_id,mutate){
          const candidate=JSON.parse(JSON.stringify(job));
          const next=mutate(candidate);
          job=next;
          return next;
        },
      };
      const result=await dispatchTaskAction(store,
        JSON.parse(JSON.stringify(fixture.request)));
      const jobOut=JSON.parse(JSON.stringify(result.job));
      for(const task of jobOut.tasks??[]){
        if(task.updatedAt)task.updatedAt='<now>';
        if(task.createdAt)task.createdAt='<now>';
        if(task.resolution?.updatedAt)task.resolution.updatedAt='<now>';
      }
      return {ok:true,job:jobOut,task:normalize(result.task)};
    }
    const task=JSON.parse(JSON.stringify(fixture.task));
    if(method==='retry')
      await applyTaskRetryAction(task,{extendBudget:fixture.extendBudget});
    else if(method==='unblockRetry')
      await applyTaskUnblockRetryAction(task);
    else if(method==='tryCancel')
      await applyTaskCancelAction(task,fixture.reason);
    else if(method==='release')
      await applyTaskReleaseAction(task);
    else if(method==='hold')
      await applyTaskHoldAction(task);
    else if(method==='queue')
      await applyTaskQueueAction(JSON.parse(JSON.stringify(fixture.job)),task);
    return {ok:true,task:normalize(task)};
  }catch(error){
    return {ok:false,error:error?.message??String(error)};
  }finally{
    rmSync(graphDir,{recursive:true,force:true});
  }
}
test('original Node/Rust task-actions differential',async()=>{
  const cases=[
    {method:'retry',task:baseTask('FAILED')},
    {method:'retry',task:baseTask('FAILED',{attempt:3,maxAttempts:3}),
      extendBudget:true},
    {method:'retry',task:baseTask('SUCCEEDED')},
    {method:'retry',task:baseTask('QUEUED')},
    {method:'retry',task:baseTask('FAILED',{kind:'planner'})},
    {method:'unblockRetry',task:baseTask('BLOCKED',{blockedBy:'b1'})},
    {method:'unblockRetry',task:baseTask('QUEUED',{blockedBy:'b1',
      attempt:2,maxAttempts:2})},
    {method:'unblockRetry',task:baseTask('DRAFT')},
    {method:'unblockRetry',task:baseTask('RUNNING')},
    {method:'tryCancel',task:baseTask('RUNNING'),reason:'obsolete'},
    {method:'tryCancel',task:baseTask('CANCELLED'),reason:'again'},
    {method:'tryCancel',task:baseTask('RUNNING',{kind:'planner'}),
      reason:'no'},
    {method:'tryCancel',task:baseTask('SUCCEEDED'),reason:'late'},
    {method:'release',task:baseTask('RUNNING')},
    {method:'release',task:baseTask('FAILED')},
    {method:'hold',task:baseTask('QUEUED')},
    {method:'hold',task:baseTask('RUNNING')},
    {method:'queue',task:baseTask('DRAFT',{dependencies:['d1']}),
      job:{id:'j1',tasks:[baseTask('SUCCEEDED',{id:'d1',dependencies:[]}),
        baseTask('DRAFT',{id:'t1',dependencies:['d1']})]}},
    {method:'queue',task:baseTask('DRAFT',{dependencies:['d1']}),
      job:{id:'j1',tasks:[baseTask('RUNNING',{id:'d1',dependencies:[]}),
        baseTask('DRAFT',{id:'t1',dependencies:['d1']})]}},
    {method:'queue',task:baseTask('DRAFT',{dependencies:[]}),
      job:{id:'j1',tasks:[baseTask('DRAFT',{id:'t1',dependencies:[]})]}},
  ];
  // dispatch cases
  const job=()=>({id:'j1',tasks:[baseTask('FAILED',{id:'t1'}),
    {id:'rec1',kind:'work',state:'QUEUED',agentName:'troubleshooter',
      parentTaskId:'t1',executionId:'rex-1',dependencies:[],
      attempt:0,maxAttempts:3}]});
  cases.push({method:'dispatch',job:job(),
    request:{id:'task.retry',jobId:'j1',taskId:'t1'}});
  cases.push({method:'dispatch',job:job(),
    request:{id:'task.cancel',jobId:'j1',taskId:'t1',reason:'obsolete'}});
  cases.push({method:'dispatch',job:job(),
    request:{id:'task.recover',jobId:'j1',taskId:'t1',
      recoveryTaskId:'rec1'}});
  cases.push({method:'dispatch',job:job(),
    request:{id:'task.recover',jobId:'j1',taskId:'t1',
      recoveryTaskId:'missing'}});
  cases.push({method:'dispatch',job:job(),
    request:{id:'task.retry',jobId:'j1',taskId:'missing'}});
  cases.push({method:'dispatch',job:job(),
    request:{id:'task.hold',jobId:'j1',taskId:'t1'}});
  const expected=[];
  for(const fixture of cases)
    expected.push(await nodeRun(fixture.method,fixture));
  const results=[];
  for(const fixture of cases){
    const payload={op:'certTaskActions',method:fixture.method,
      task:fixture.task,job:fixture.job,request:fixture.request,
      extendBudget:fixture.extendBudget,reason:fixture.reason};
    results.push(await parity(payload));
  }
  const failures=[];
  for(let i=0;i<cases.length;i++){
    const want=expected[i],got=results[i];
    const strip=v=>{
      if(!v||typeof v!=='object')return v;
      const clone=JSON.parse(JSON.stringify(v));
      if(clone.task){
        for(const key of ['createdAt'])
          if(clone.task[key])clone.task[key]='<now>';
      }
      if(clone.job&&Array.isArray(clone.job.tasks))
        for(const t of clone.job.tasks)
          if(t.createdAt)t.createdAt='<now>';
      return clone;
    };
    if(want.ok!==got.ok){failures.push([i,want,got]);continue;}
    if(want.ok===false&&want.error!==got.error){failures.push([i,want,got]);continue;}
    if(want.ok===true){
      if(JSON.stringify(strip(want))!==JSON.stringify(strip(got)))
        failures.push([i,strip(want),strip(got)]);
    }
  }
  for(const [i,want,got] of failures.slice(0,8))
    console.log('TA_DIFF',i,JSON.stringify(want).slice(0,240),
      JSON.stringify(got).slice(0,240));
  assert.deepEqual(failures.map(f=>String(f[0])),[],
    `${failures.length} task-actions mismatches`);
  console.log('Verified',cases.length,
    'original Node/Rust task-actions cases');
});
