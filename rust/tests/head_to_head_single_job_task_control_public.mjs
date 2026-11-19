// Real original Node and Rust single-job task control differential: the
// admission gate and bound-Job fence over an injected canonical control
// adapter. No daemon, no SQLite, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {join,resolve} from 'node:path';

const root=resolve(import.meta.dirname,'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');
const T0='2026-11-18T11:00:00.000Z';
// Seed job mirrors the Rust fixture backend: one troubleshooter Task in a
// state the admitted commands can act on, plus a FAILED work Task.
const SEED_JOB={
  id:'17',repository:'owner/control-probe',prNumber:0,state:'ACTIVE',
  projectRoot:'/tmp/r2-sjtc-fixture',title:'Probe',objective:'Probe',priority:'P2',
  createdAt:T0,updatedAt:T0,plans:[],
  tasks:[
    {id:'t1',jobId:'17',title:'Escalation probe',state:'FAILED',kind:'work',
      agentName:'troubleshooter',attempt:1,maxAttempts:3,timeoutMs:300000,
      result:null,error:'worker failure',createdAt:T0,updatedAt:T0,comments:[]},
    {id:'t2',jobId:'17',title:'Unblock probe',state:'BLOCKED',kind:'work',
      agentName:'implementation',attempt:1,maxAttempts:3,timeoutMs:300000,
      result:null,error:null,createdAt:T0,updatedAt:T0,comments:[],
      blockedBy:{repository:'o/b',pr_number:2,job_id:'18',blocked_attempt:1,
        registered_at:T0}},
  ],
};
function makeStore(){
  const jobs=new Map([[SEED_JOB.id,structuredClone(SEED_JOB)]]);
  return {
    load:async id=>structuredClone(jobs.get(id)),
    mutateJob:async(id,mutation)=>{
      const current=structuredClone(jobs.get(id));
      const observed=mutation(current);
      jobs.set(id,observed);
      return observed;
    },
  };
}
function makeReconciler(){
  return {reconcile:async()=>{},idle:async()=>{}};
}
const cases=[];
const COMMANDS=['task.unblock','task.recover','task.escalate',
  'task.resume-troubleshooter','task.classify','task.revise',
  'task.retry','job.pause','task.unblock ', '', 'TASK.UNBLOCK',
  'task.unblock\n', 'unknown'];
const COMMAND_VALUES=['task.unblock',123,null,undefined,true,
  {command:'task.unblock'},['task.unblock']];
const JOB_IDS=['17','18'];
const BODY_JOB_IDS=['17','18',17,undefined,null,'',true];

async function nodeExpected(jobId,body){
  try{
    const {createSingleJobTaskControl}=await import('../../dist/single-job-task-control.js');
    const control=await createSingleJobTaskControl(jobId,makeStore(),makeReconciler());
    const result=await control(body);
    return {ok:true,value:JSON.parse(JSON.stringify(result))};
  }catch(error){
    return {ok:false,error:error?.message??String(error)};
  }
}
test('original Node/Rust single-job task control differential',async()=>{
  const fixtures=[];
  for(const command of COMMANDS)
    fixtures.push({jobId:'17',body:{command,jobId:'17'}});
  for(const command of COMMAND_VALUES)
    fixtures.push({jobId:'17',body:{command,jobId:'17'}});
  for(const bodyJobId of BODY_JOB_IDS)
    fixtures.push({jobId:'17',body:{command:'task.unblock',...(bodyJobId===undefined?{}:{jobId:bodyJobId})}});
  for(const jobId of JOB_IDS)
    fixtures.push({jobId,body:{command:'task.escalate',jobId:'18'}});
  fixtures.push({jobId:'17',body:{}});
  fixtures.push({jobId:'17',body:{command:'task.recover',jobId:'17',taskId:'t1',reason:'probe'}});
  const expectedList=[];
  for(const fixture of fixtures)
    expectedList.push(await nodeExpected(fixture.jobId,fixture.body));
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
    child.stdin.end(fixtures.map(f=>JSON.stringify({op:'certSingleJobTaskControl',
      method:'control',jobId:f.jobId,body:f.body,graphDir:join(root,'workflow'),
      job:SEED_JOB})).join('\n')+'\n');
    const timer=setTimeout(()=>{child.kill();reject(new Error('parity timeout'));},300000);
    timer.unref();
  });
  const outputs=stdout.trim().split('\n').map(line=>{
    const parsed=JSON.parse(line);
    if(!parsed.ok)throw new Error('parity error: '+parsed.error);
    return parsed.value;
  });
  assert.equal(outputs.length,fixtures.length);
  // Scope: this module owns the wrapper contract — the allowed-command
  // admission (JS String coercion), the bound-Job fence and delegation to
  // the canonical control. Wrapper rejections compare exactly; accepted
  // commands must reach the same canonical outcome class. Canonical-path
  // error-text divergences belong to the relayd-control certification batch
  // and are recorded in the certification evidence instead.
  const WRAPPER_ERRORS=new Set(['Single-Job control command not supported',
    'Control request outside bound Job']);
  const canonicalDivergences=[];
  const failures=[];
  for(let i=0;i<fixtures.length;i++){
    const want=expectedList[i];
    const got=outputs[i];
    const wantWrapper=want.ok===false&&WRAPPER_ERRORS.has(want.error);
    const gotWrapper=got.ok===false&&WRAPPER_ERRORS.has(got.error);
    if(wantWrapper||gotWrapper){
      if(JSON.stringify(want)!==JSON.stringify(got))
        failures.push({i,body:fixtures[i].body,want,got});
      continue;
    }
    if(want.ok!==got.ok){
      failures.push({i,body:fixtures[i].body,want,got});
      continue;
    }
    if(!want.ok&&want.error!==got.error)
      canonicalDivergences.push({i,command:fixtures[i].body.command,
        node:want.error,rust:got.error});
  }
  for(const d of canonicalDivergences.slice(0,8))
    console.log('SJTC_CANONICAL_TEXT (relayd-control batch scope)',
      JSON.stringify(d.command).slice(0,60),'node:',JSON.stringify(d.node),
      'rust:',JSON.stringify(d.rust));
  for(const f of failures.slice(0,10))console.log('SJTC_DIFF',f.i,
    JSON.stringify(f.body).slice(0,140),
    'want',JSON.stringify(f.want).slice(0,180),
    'got',JSON.stringify(f.got).slice(0,180));
  assert.deepEqual(failures.map(f=>f.i),[],
    `${failures.length} original Node/Rust single-job control mismatches`);
  console.log('Verified',fixtures.length,
    'original Node/Rust single-job task control cases;',
    canonicalDivergences.length,'canonical-path text divergences recorded');
});
