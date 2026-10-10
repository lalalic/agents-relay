#!/usr/bin/env node
// External E2E fault injector. Never mutates Relay SQLite or lifecycle state directly.
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {NatsEventBus, eventFor} from '../../dist/events.js';
import {resolveEventsBusRuntime} from '../../dist/events-bus-runtime.js';
import {executionEventSource} from '../../dist/reconciler-runtime.js';

const argv=process.argv.slice(2);
const opt=(name,def='')=>{const i=argv.indexOf('--'+name);return i<0?def:argv[i+1]};
const required=name=>{const v=opt(name);if(!v)throw Error(`--${name} is required`);return v};
const scenario=required('scenario');
const jobId=required('job');
const phase=required('phase');
const out=resolve(opt('out',`e2e/runs/current/${jobId}/injection-${phase}.json`));
const save=v=>{mkdirSync(dirname(out),{recursive:true});writeFileSync(out,JSON.stringify(v,null,2)+'\n');};
const api=opt('api','http://127.0.0.1:8787');
const get=async path=>{const r=await fetch(new URL(path,api));if(!r.ok)throw Error(`${path}: HTTP ${r.status} ${await r.text()}`);return r.json();};

async function latestLaunch(){
  const job=await get(`/api/job?id=${encodeURIComponent(jobId)}`);
  const running=(job.tasks||[]).filter(t=>t.state==='RUNNING'&&t.executionId);
  if(running.length!==1)throw Error(`expected exactly one RUNNING execution, found ${running.length}`);
  const task=running[0];
  const events=await get(`/api/events?job=${encodeURIComponent(jobId)}&task=${encodeURIComponent(task.id)}&limit=60`);
  const rows=Array.isArray(events)?events:[];
  const launched=[...rows].reverse().find(e=>e.type==='task.process.launched'&&e.data?.executionId===task.executionId);
  if(!launched)throw Error(`no task.process.launched event found for ${task.id}/${task.executionId}`);
  const pid=Number(launched.data?.pid);
  if(!Number.isInteger(pid)||pid<=1)throw Error(`launch event has no safe PID for ${task.id}`);
  return {job,task,launched,pid,executionId:task.executionId};
}

async function terminateCurrent(){
  const current=await latestLaunch();
  process.kill(current.pid,'SIGTERM');
  const receipt={scenario,phase,jobId,taskId:current.task.id,pid:current.pid,executionId:current.executionId,sourceId:executionEventSource(jobId,current.task.id,current.executionId),signal:'SIGTERM',at:new Date().toISOString()};
  save(receipt); console.log(JSON.stringify(receipt,null,2));
}

async function terminateFromEvent(){
  const pid=Number(required('pid')),taskId=required('task'),executionId=required('execution');
  if(!Number.isSafeInteger(pid)||pid<=1)throw Error('unsafe injected worker PID');
  const current=await get(`/api/job?id=${encodeURIComponent(jobId)}`);
  const task=(current.tasks||[]).find(t=>t.id===taskId);
  if(!task||task.executionId!==executionId||!['QUEUED','RUNNING'].includes(task.state))throw Error(`stale launch event: ${taskId}/${executionId} (${task?.state??'missing'})`);
  try{process.kill(pid,0);}catch(error){throw Error(`worker PID ${pid} is no longer alive: ${error.message}`);}
  process.kill(pid,'SIGTERM');
  const receipt={scenario,phase,jobId,taskId,pid,executionId,sourceId:executionEventSource(jobId,taskId,executionId),signal:'SIGTERM',at:new Date().toISOString()};
  save(receipt);console.log(JSON.stringify(receipt));
}

async function replayStaleTerminal(){
  const receiptPath=resolve(required('receipt'));
  if(!existsSync(receiptPath))throw Error(`receipt not found: ${receiptPath}`);
  const old=JSON.parse(readFileSync(receiptPath,'utf8'));
  const current=await get(`/api/job?id=${encodeURIComponent(jobId)}`);
  const task=(current.tasks||[]).find(t=>t.id===old.taskId);
  if(!task)throw Error(`task ${old.taskId} no longer exists`);
  if(task.executionId===old.executionId)throw Error('new authoritative execution generation has not been established yet; refusing stale replay');
  const runtime=resolveEventsBusRuntime();
  const bus=new NatsEventBus(runtime.natsUrl,runtime.subjectPrefix);
  const event=eventFor(jobId,old.taskId,task.parentTaskId??null,'task.completed','succeeded','E2E delayed stale terminal from old execution','user',{summary:'stale E2E completion',executionId:old.executionId},{id:old.sourceId,agent:'e2e-controller',component:'agents-relay-e2e'});
  try{await bus.publish(event);}finally{await bus.close();}
  const result={scenario,phase,jobId,taskId:old.taskId,oldExecutionId:old.executionId,currentExecutionId:task.executionId??null,eventId:event.event_id,at:new Date().toISOString()};
  save(result); console.log(JSON.stringify(result,null,2));
}

function restartDaemon(){
  const p=spawnSync('npx',['pm2','restart','agents-relayd','--update-env'],{encoding:'utf8',timeout:120000,maxBuffer:4e6});
  if(p.error||p.status!==0)throw Error(p.error?.message||p.stderr||p.stdout||`pm2 exited ${p.status}`);
  const receipt={scenario,phase,jobId,action:'pm2 restart agents-relayd',at:new Date().toISOString()};save(receipt);console.log(JSON.stringify(receipt,null,2));
}

if(scenario.startsWith('005-')&&phase==='terminate-current')await terminateCurrent();
else if(scenario.startsWith('005-')&&phase==='terminate-from-event')await terminateFromEvent();
else if(scenario.startsWith('005-')&&phase==='replay-stale-terminal')await replayStaleTerminal();
else if(scenario.startsWith('009-')&&phase==='restart-daemon')restartDaemon();
else throw Error(`unsupported injection ${scenario}/${phase}`);
