import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { acceptTaskProgress, inactivityDeadline } from '../dist/task-inactivity-watchdog.js';
import { executionEventSource } from '../dist/execution-event-identity.js';

const taskId='pool-timeout-task';
const jobId='pool-timeout-job';
const executionId='pool-timeout-execution';
const now=()=>new Date().toISOString();
function fixture(){
  const t={id:taskId,jobId,executionId,state:'RUNNING',adapter:'z',timeoutMs:120000,
    updatedAt:new Date(Date.now()-150000).toISOString(),lastProgressAt:null,lastProgressEventAt:null,
    executionHistory:[{id:executionId,startedAt:new Date(Date.now()-150000).toISOString()}]};
  const transitions={apply:async(j,id,kind,options)=>{
    assert.equal(j,jobId);assert.equal(id,taskId);assert.equal(kind,'task.progress');
    const job={id:jobId};
    if(!options.eligible(job,t))return {decision:{accepted:false},task:t};
    options.mutate(job,t);return {decision:{accepted:true},task:t};
  }};
  return {t,transitions};
}
function progress(timestamp=now(),sourceId=executionEventSource(jobId,taskId,executionId)){
  return {type:'task.progress',timestamp,job_id:jobId,task_id:taskId,source:{id:sourceId}};
}
test('fresh correlated assistant output extends Relay watchdog; old execution cannot',async()=>{
  const {t,transitions}=fixture();
  const before=inactivityDeadline(t,executionId,15000);
  assert.ok(before<Date.now());
  const accepted=await acceptTaskProgress(transitions,progress());
  assert.equal(accepted,t);
  const extended=inactivityDeadline(t,executionId,15000);
  assert.ok(extended>Date.now()+110000);
  assert.ok(extended-before>110000);
  assert.equal(await acceptTaskProgress(transitions,progress(now(),executionEventSource(jobId,taskId,'outdated'))),null);
  assert.equal(inactivityDeadline(t,executionId,15000),extended);
});
test('duplicate or stale task.progress event cannot renew timeout',async()=>{
  const {t,transitions}=fixture();
  const event=progress();
  await acceptTaskProgress(transitions,event);
  const first=inactivityDeadline(t,executionId,15000);
  assert.equal(await acceptTaskProgress(transitions,event),null);
  assert.equal(await acceptTaskProgress(transitions,progress(new Date(Date.now()-60000).toISOString())),null);
  assert.equal(inactivityDeadline(t,executionId,15000),first);
});
test('heartbeat-only / spinner-only cannot publish progress or renew deadline',async()=>{
  const {t}=fixture();const deadline=inactivityDeadline(t,executionId,15000);
  for(const noNewOutput of ['heartbeat','spinner','same assistant text','blank response']){
    assert.equal(inactivityDeadline(t,executionId,15000),deadline,noNewOutput);
  }
});
