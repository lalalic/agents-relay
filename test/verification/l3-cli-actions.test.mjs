import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execFileAsync=promisify(execFile);
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {WorkflowActionLedger} from '../../dist/workflow/action-ledger.js';
const root=fileURLToPath(new URL('../../',import.meta.url));
const cli=join(root,'dist/cli.js');
const run=(args,env)=>execFileSync(process.execPath,[cli,'workflow',...args],{cwd:root,encoding:'utf8',timeout:12000,env:{...process.env,AGENTS_RELAY_STORE_DIR:env}});
test('L3 CLI enumerates all 45 canonical Graph Actions and can locate each owning graph',()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-cli-actions-l3-'));
 try {
  const {count,actions}=JSON.parse(run(['actions'],dir));
  assert.equal(count,47);
  for(const entry of actions){
   assert.ok(entry.graphReferences.length,entry.id);
   const refs=JSON.parse(run(['where','--id',entry.id],dir));
   assert.ok(refs.some(ref=>ref.kind==='action'),entry.id);
   assert.equal(entry.cli,'inspect-only; execution requires owning Graph runtime');
  }
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('L3 CLI reads real SQLite action ledger trace and fails closed against direct unsafe effect',()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-cli-sqlite-l3-'));
 const path=join(dir,'workflow.sqlite');
 try {
  const db=new DatabaseSync(path);
  const ledger=new WorkflowActionLedger(db);
  ledger.reserve({executionId:'execution-A',generation:2,graph:'task-lifecycle.mmd',actionId:'effect.launchTask',attemptKey:'job/task/execution-A/launch'}, {accepted:true,source:'QUEUED',target:'QUEUED',actions:[{id:'effect.launchTask'}]},'worker.started');
  db.close();
  const trace=JSON.parse(run(['trace','--sqlite',path,'--attempt-key','job/task/execution-A/launch'],dir)).trace;
  assert.equal(trace.execution_id,'execution-A');
  assert.equal(trace.generation,2);
  assert.equal(trace.action_id,'effect.launchTask');
  assert.equal(trace.outcome,'Unknown');
  for (const {id} of JSON.parse(run(['actions'],dir)).actions) {
   assert.throws(()=>run(['action','--action',id,'--repo','local/isolated','--id','job','--task-id','task'],dir), /supported Graph-authorized task Action ID/, id);
  }
  const again=JSON.parse(run(['trace','--sqlite',path,'--attempt-key','job/task/execution-A/launch'],dir)).trace;
  assert.deepEqual(again,trace,'failed CLI attempt must not modify ledger');
 } finally {rmSync(dir,{recursive:true,force:true});}
});
for (const scenario of [{action:'task.cancel',initial:'DRAFT',expected:'CANCELLED'},{action:'task.retry',initial:'FAILED',expected:'QUEUED'},{action:'task.unblock',initial:'BLOCKED',agentName:'troubleshooter',expected:'QUEUED',args:['--reason','manual blocker resolution']}]) test(`L3 CLI ${scenario.action} reaches production service, executes Graph transition and persists SQLite`,async()=>{
 const {SQLiteRelayStore}=await import('../../dist/relay-store.js');
 const {createService}=await import('../../dist/cli.js');
 const {createServer}=await import('node:net');
 const dir=mkdtempSync(join(tmpdir(),'relay-cli-action-positive-'));
 const stores=join(dir,'stores');
 const {mkdirSync}=await import('node:fs');mkdirSync(stores);
 const sqlite=new SQLiteRelayStore(join(dir,'relay.sqlite'),'cli-action-job');
 const at=new Date().toISOString();
 const task={id:'task-1',jobId:'cli-action-job',parentTaskId:null,dependencies:[],capabilities:[],adapter:'orchestrator',agentName:scenario.agentName,input:'isolated',state:scenario.initial,attempt:scenario.initial==='FAILED'?1:0,maxAttempts:3,leaseOwner:null,leaseExpiresAt:null,executionId:null,threadId:null,result:null,error:null,timeoutMs:10000,createdAt:at,updatedAt:at,continuation:null,continuationDeliveredAt:null};
 const job={id:'cli-action-job',title:'CLI action L3',repository:'local/isolated',prNumber:0,executionMode:'fixed',state:scenario.action==='task.cancel'?'ACTIVE':'DRAFT',continuation:null,createdAt:at,updatedAt:at,tasks:[task]};
 let service;
 const original=process.env.AGENTS_RELAY_STORE_DIR;
 const originalNoGithub=process.env.AGENTS_RELAY_NO_GITHUB;
 try {
  await sqlite.saveJob(job);
  process.env.AGENTS_RELAY_STORE_DIR=stores;
  process.env.AGENTS_RELAY_NO_GITHUB='1';
  const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));
  service=await createService(['--no-github','--events','none','--repo','local/isolated','--id','cli-action-job','--port',String(port),'--interval','600000','--refresh-ms','600000']);
  if (scenario.action==='task.cancel') {
   for(const body of [{command:'task.unblock',jobId:'other-job',taskId:'task-1',reason:'foreign'}, {command:'job.update',jobId:'cli-action-job',patch:{title:'forbidden'}}]) {
    const reply=await fetch(`http://127.0.0.1:${port}/api/control`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    assert.equal(reply.status,409,'single-job Action endpoint must reject foreign Job and non-Task commands');
   }
   assert.equal((await sqlite.loadJob('cli-action-job')).tasks[0].state,'DRAFT','rejected requests never persist transitions');
  }
  const result=await execFileAsync(process.execPath,[cli,'workflow','action','--action',scenario.action,...(scenario.args??[]),'--repo','local/isolated','--id','cli-action-job','--task-id','task-1','--host','127.0.0.1','--port',String(port),'--events','none','--no-github'],{cwd:root,timeout:12000,env:{...process.env,AGENTS_RELAY_STORE_DIR:stores,AGENTS_RELAY_NO_GITHUB:'1'}});
  const output=JSON.parse(result.stdout);
  assert.equal((output.task??output).state,scenario.expected);
  const persisted=(await sqlite.loadJob('cli-action-job')).tasks[0];
  assert.equal(persisted.state,scenario.expected);
  if (scenario.action==='task.unblock') {
   assert.equal(persisted.unblock?.event,'task.unblocked','the Troubleshooter unblock fact is durable');
   assert.equal(persisted.unblock?.reason,'manual blocker resolution');
  }
  if (scenario.action==='task.cancel') {
   await assert.rejects(execFileAsync(process.execPath,[cli,'workflow','action','--action','task.cancel','--repo','local/isolated','--id','cli-action-job','--task-id','task-1','--host','127.0.0.1','--port',String(port),'--events','none','--no-github'],{cwd:root,timeout:12000,env:{...process.env,AGENTS_RELAY_STORE_DIR:stores,AGENTS_RELAY_NO_GITHUB:'1'}}),/not cancellable|not cancel|CANCELLED|No enabled workflow transition/);
   assert.equal((await sqlite.loadJob('cli-action-job')).tasks[0].state,'CANCELLED');
  }
 } finally {
  await service?.stop();sqlite.close();
  if(original===undefined)delete process.env.AGENTS_RELAY_STORE_DIR;else process.env.AGENTS_RELAY_STORE_DIR=original;
  if(originalNoGithub===undefined)delete process.env.AGENTS_RELAY_NO_GITHUB;else process.env.AGENTS_RELAY_NO_GITHUB=originalNoGithub;
  rmSync(dir,{recursive:true,force:true});
 }
});

test('L3 CLI task.escalate and task.resume-troubleshooter preserve authoritative human recovery',async()=>{
 const {SQLiteRelayStore}=await import('../../dist/relay-store.js');
 const {createService}=await import('../../dist/cli.js');
 const {createServer}=await import('node:net');
 const {mkdirSync}=await import('node:fs');
 const dir=mkdtempSync(join(tmpdir(),'relay-cli-human-positive-'));
 const stores=join(dir,'stores');mkdirSync(stores);
 const sqlite=new SQLiteRelayStore(join(dir,'relay.sqlite'),'cli-human-job');
 const at=new Date().toISOString();
 const base=(id,state)=>({id,jobId:'cli-human-job',parentTaskId:null,dependencies:[],capabilities:[],adapter:'orchestrator',input:'isolate',state,attempt:state==='FAILED'?1:0,maxAttempts:3,leaseOwner:null,leaseExpiresAt:null,executionId:null,threadId:null,result:null,error:state==='FAILED'?'external login required':null,timeoutMs:10000,createdAt:at,updatedAt:at,continuation:null,continuationDeliveredAt:null});
 const original=base('original','FAILED');
 const recovery={...base('troubleshoot-original','QUEUED'),agentName:'troubleshooter',parentTaskId:'original'};
 const job={id:'cli-human-job',title:'CLI human recovery L3',repository:'local/isolated',prNumber:0,executionMode:'fixed',state:'ACTIVE',continuation:null,createdAt:at,updatedAt:at,tasks:[original,recovery]};
 let service;
 const priorStore=process.env.AGENTS_RELAY_STORE_DIR,priorNoGithub=process.env.AGENTS_RELAY_NO_GITHUB;
 try {
  await sqlite.saveJob(job);process.env.AGENTS_RELAY_STORE_DIR=stores;process.env.AGENTS_RELAY_NO_GITHUB='1';
  const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  service=await createService(['--no-github','--events','none','--repo','local/isolated','--id',job.id,'--port',String(port),'--interval','600000','--refresh-ms','600000']);
  const execAction=async(action,extra)=>{
   const result=await execFileAsync(process.execPath,[cli,'workflow','action','--action',action,'--repo','local/isolated','--id',job.id,'--task-id',recovery.id,...extra,'--host','127.0.0.1','--port',String(port),'--events','none','--no-github'],{cwd:root,timeout:12000,env:{...process.env,AGENTS_RELAY_STORE_DIR:stores,AGENTS_RELAY_NO_GITHUB:'1'}});
   return JSON.parse(result.stdout);
  };
  await execAction('task.escalate',['--required-action','Complete SSO','--resolution-condition','Login valid','--context','Provider challenge']);
  const escalated=await sqlite.loadJob(job.id);
  assert.equal(escalated.tasks.find(t=>t.id===original.id).state,'FAILED');
  const blocked=escalated.tasks.find(t=>t.id===recovery.id);
  assert.equal(blocked.state,'BLOCKED');
  assert.equal(blocked.escalation.status,'pending');
  assert.equal(blocked.escalation.notification.status,'pending','event publication is not human delivery');
  await execAction('task.resume-troubleshooter',['--response','SSO completed']);
  const resumed=await sqlite.loadJob(job.id);
  assert.equal(resumed.tasks.find(t=>t.id===original.id).state,'FAILED');
  const updated=resumed.tasks.find(t=>t.id===recovery.id);
  assert.equal(updated.escalation.status,'responded');
  assert.equal(updated.escalation.response,'SSO completed');
  await assert.rejects(execAction('task.resume-troubleshooter',['--response','duplicate']), /already has a response|not a blocked Troubleshooter escalation/);
 } finally {
  await service?.stop();sqlite.close();
  if(priorStore===undefined)delete process.env.AGENTS_RELAY_STORE_DIR;else process.env.AGENTS_RELAY_STORE_DIR=priorStore;
  if(priorNoGithub===undefined)delete process.env.AGENTS_RELAY_NO_GITHUB;else process.env.AGENTS_RELAY_NO_GITHUB=priorNoGithub;
  rmSync(dir,{recursive:true,force:true});
 }
});

test('L3 CLI task.recover requires active Troubleshooter and persists original Graph recovery safely',async()=>{
 const {SQLiteRelayStore}=await import('../../dist/relay-store.js');
 const {createService}=await import('../../dist/cli.js');
 const {createServer}=await import('node:net');
 const {mkdirSync}=await import('node:fs');
 const dir=mkdtempSync(join(tmpdir(),'relay-cli-recover-positive-'));
 const stores=join(dir,'stores');mkdirSync(stores);
 const sqlite=new SQLiteRelayStore(join(dir,'relay.sqlite'),'cli-recover-job');
 const at=new Date().toISOString();
 const base=(id,state)=>({id,jobId:'cli-recover-job',parentTaskId:null,dependencies:[],capabilities:[],adapter:'orchestrator',input:'isolate',state,attempt:1,maxAttempts:3,leaseOwner:null,leaseExpiresAt:null,executionId:null,threadId:null,result:null,error:state==='FAILED'?'fault':null,timeoutMs:10000,createdAt:at,updatedAt:at,continuation:null,continuationDeliveredAt:null});
 const original=base('original','FAILED');
 const recovery={...base('troubleshoot-original','RUNNING'),agentName:'troubleshooter',parentTaskId:'original',executionId:'recovery-exec',leaseOwner:'relay-test',leaseExpiresAt:new Date(Date.now()+3600000).toISOString(),executionHistory:[{id:'recovery-exec',attempt:1,startedAt:at}]};
 const job={id:'cli-recover-job',title:'CLI recovery L3',repository:'local/isolated',prNumber:0,executionMode:'fixed',state:'ACTIVE',continuation:null,createdAt:at,updatedAt:at,tasks:[original,recovery]};
 let service;
 const priorStore=process.env.AGENTS_RELAY_STORE_DIR,priorNoGithub=process.env.AGENTS_RELAY_NO_GITHUB;
 try {
  await sqlite.saveJob(job);process.env.AGENTS_RELAY_STORE_DIR=stores;process.env.AGENTS_RELAY_NO_GITHUB='1';
  const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  service=await createService(['--no-github','--events','none','--repo','local/isolated','--id',job.id,'--port',String(port),'--interval','600000','--refresh-ms','600000']);
  const result=await execFileAsync(process.execPath,[cli,'workflow','action','--action','task.recover','--repo','local/isolated','--id',job.id,'--task-id',original.id,'--recovery-task-id',recovery.id,'--host','127.0.0.1','--port',String(port),'--events','none','--no-github'],{cwd:root,timeout:12000,env:{...process.env,AGENTS_RELAY_STORE_DIR:stores,AGENTS_RELAY_NO_GITHUB:'1'}});
  const output=JSON.parse(result.stdout);
  assert.notEqual(output.state,'FAILED','Graph recovery request must change original state');
  const after=await sqlite.loadJob(job.id);
  assert.equal(after.tasks.find(t=>t.id===original.id).state,output.state);
  assert.notEqual(after.state,'COMPLETED','recovery request is never a fabricated objective terminal');
 } finally {
  await service?.stop();sqlite.close();
  if(priorStore===undefined)delete process.env.AGENTS_RELAY_STORE_DIR;else process.env.AGENTS_RELAY_STORE_DIR=priorStore;
  if(priorNoGithub===undefined)delete process.env.AGENTS_RELAY_NO_GITHUB;else process.env.AGENTS_RELAY_NO_GITHUB=priorNoGithub;
  rmSync(dir,{recursive:true,force:true});
 }
});
