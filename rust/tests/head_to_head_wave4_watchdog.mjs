// Real Node exported functions vs native Rust; no durable store or live browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import * as watchdog from '../../dist/task-inactivity-watchdog.js';
const root=resolve(import.meta.dirname,'../..');
const binary=resolve(root,'rust/target/debug/relay-rust2-parity');
let seed=0xb17f4a01;
const rand=n=>{seed=(Math.imul(seed,1103515245)+12345)>>>0;return seed%n};
const pick=a=>a[rand(a.length)];
const date=ms=>new Date(ms).toISOString();
const NOW=1794927600123;
const reasons=['worker_start_timeout','terminal_event_timeout','worker_exit_before_start','worker_exit_without_terminal_event','worker_delivery_after_start','non_recoverable',null];
const errors=['worker_start_timeout','timed out waiting for the mandatory terminal worker event','exceeded its inactivity timeout','exited before publishing task.started','exited after task.started without publishing a terminal task event','Worker delivery failed after task.started','failed for another reason',null];
function rust(cases){
 const p=spawnSync(binary,{cwd:root,input:cases.map(JSON.stringify).join('\n')+'\n',encoding:'utf8',timeout:80000,maxBuffer:12*1024*1024});
 assert.equal(p.status,0,p.stderr||String(p.error));
 const rows=p.stdout.trim().split('\n').map(JSON.parse);assert.equal(rows.length,cases.length);return rows;
}
function task(i){
 const exec=pick(['g1','g2',null]);
 return {jobId:'31',id:'42',kind:'work',state:pick(['RUNNING','QUEUED','FAILED','CANCELLED']),
  agentGraph:pick([null,null,{}, {nodes:[]}]),executionId:exec,adapter:pick(['chatgpt','z','script','codex']),
  failureReason:pick(reasons),error:pick(errors),timeoutMs:pick([0,1,250,5000,120000]),
  lastProgressAt:pick([null,date(NOW-250000),date(NOW-5000)]),
  processExitedAt:pick([null,date(NOW-6000),date(NOW-200000)]),
  executionHistory:pick([[],[{id:'g1',startedAt:date(NOW-60000)},{id:'g2',startedAt:date(NOW-10000)}]]),
  updatedAt:date(NOW-180000),lastProgressEventAt:null};
}
test('watchdog pure APIs: 500 randomized Node/Rust positive + negative correlation/deadline cases',()=>{
 const cases=[];
 for(let i=0;i<500;i++){
  const t=task(i),executionId=pick(['g1','g2','wrong']),graceMs=pick([0,1,250,5000,15000]);
  const source=pick(['job/31/task/42/execution/g1','job/31/task/42/execution/g2','job/31/task/42/execution/forged','unrelated']);
  const event={job_id:pick(['31','32']),task_id:'42',source:{id:source},timestamp:date(NOW-100)};
  cases.push({op:'wave4Watchdog',action:pick(['requires','recoverable','correlated','deadline']),task:t,event,executionId,graceMs,now:NOW});
 }
 const actual=rust(cases);
 for(let i=0;i<cases.length;i++){
  const q=cases[i];let value;
  switch(q.action){
   case 'requires':value=watchdog.requiresWorkerInactivityWatchdog({id:'31'},q.task);break;
   case 'recoverable':value=watchdog.isRecoverableWatchdogFailure(q.task);break;
   case 'correlated':value=watchdog.isCorrelatedWorkerEvent(q.task,q.event);break;
   case 'deadline':value=watchdog.inactivityDeadline(q.task,q.executionId,q.graceMs);break;
  }
  assert.deepEqual(actual[i],{ok:true,value},`case ${i}: ${JSON.stringify(q)}`);
 }
});
