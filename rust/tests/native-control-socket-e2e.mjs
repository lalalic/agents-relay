import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync,statSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {createConnection} from 'node:net';
import {DatabaseSync} from 'node:sqlite';

const target=process.env.CARGO_TARGET_DIR ?? resolve(import.meta.dirname,'../target');
const cli=join(target,'debug/relay-native-job');
const daemon=join(target,'debug/relay-native-daemon');
const helper=join(target,'debug/relay-worker-helper');
const marker='rust-relay-owned-standalone-namespace-v1\n';
function fixture(){
 const home=mkdtempSync('/tmp/rr-');
 const root=join(home,'.local/state/agents-relay/rust-live');
 mkdirSync(root,{recursive:true,mode:0o700});chmodSync(root,0o700);
 writeFileSync(join(root,'.relay-rust-live-namespace-v1'),marker,{mode:0o600});
 writeFileSync(join(root,'.relay-rust-authority-isolated-test'),'isolated-test',{mode:0o600});
 writeFileSync(join(root,'manifest.json'),JSON.stringify({agents:{}}),{mode:0o600});
 const db=join(root,'relay.sqlite');
 const env={...process.env,HOME:home,RELAY_RUST_LIVE_MODE:'pilot-live',RELAY_RUST_EXPERIMENTAL_TEST_ONLY:'',AGENTS_RELAY_STORE_DIR:join(home,'node-store')};
 mkdirSync(env.AGENTS_RELAY_STORE_DIR,{recursive:true});
 // Native production CLI deliberately does not expose live database bootstrap.
 // Provision the exact canonical isolated schema in this disposable fixture.
 const sqlite=new DatabaseSync(db);
 sqlite.exec('PRAGMA journal_mode=WAL; CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL); CREATE TABLE relay_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE agent_snapshot(agent_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL);');
 sqlite.close();chmodSync(db,0o600);
 return {home,root,db,env,socket:join(root,'.rc.sock')};
}
function start(f){
 const child=spawn(daemon,['--loop','--db',f.db,'--manifest',join(f.root,'manifest.json'),'--helper',helper,'--interval-ms','100'],{env:f.env,stdio:['ignore','pipe','pipe']});
 child.stderrText='';child.stderr.on('data',chunk=>child.stderrText+=chunk.toString());return child;
}
async function waitForSocket(f,child){
 for(let i=0;i<100;i++){
  if(existsSync(f.socket)) return;
  if(child.exitCode!==null) throw new Error(`daemon exited: ${child.exitCode}: ${child.stderrText}`);
  await delay(20);
 }
 throw new Error('daemon control socket did not start');
}
function createArgs(f,extra=[]){return ['job','create','--db',f.db,'--repo','agents-relay','--id','861','--objective','A native daemon controlled Job','--project-root',f.root,...extra];}
function invoke(f,args){return spawnSync(cli,args,{env:{...f.env,PATH:'/no-native-fallback'},encoding:'utf8',timeout:8000});}
async function rawRequest(socket,request){
 return await new Promise((resolvePromise,reject)=>{
  const client=createConnection(socket);let data='';
  client.on('connect',()=>client.write(`${JSON.stringify(request)}\n`));
  client.on('data',chunk=>{data+=chunk.toString();if(data.includes('\n')){client.end();resolvePromise(JSON.parse(data.trim()));}});
  client.on('error',reject);
 });
}
function readJob(db){
 const sql=new DatabaseSync(db);try{return JSON.parse(sql.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get('861').json);}finally{sql.close();}
}
async function stop(child){
 if(child.exitCode!==null)return;
 child.kill('SIGTERM');
 await Promise.race([new Promise(resolvePromise=>child.once('exit',resolvePromise)),delay(3000)]);
 if(child.exitCode===null){child.kill('SIGKILL');await new Promise(resolvePromise=>child.once('exit',resolvePromise));}
}

test('native control socket is single-writer, authenticated, allowlisted, and restart-deduplicated', {concurrency:false}, async()=>{
 const f=fixture();let child;
 try{
  child=start(f);await waitForSocket(f,child);
  assert.equal(statSync(f.socket).mode & 0o777,0o600,'socket is private');
  const rejected=await rawRequest(f.socket,{version:1,operation:'job.delete',repository:'agents-relay',id:'861',title:'x',objective:'x',project_root:f.root,project_path:null,priority:'P2',review_enabled:false,auto_merge:false});
  assert.equal(rejected.ok,false);assert.match(rejected.error,/unsupported native control operation/);
  assert.equal(statSync(f.socket).isSocket(),true,'private endpoint is a Unix socket');
  const oversized=await rawRequest(f.socket,{version:1,operation:'job.create',repository:'agents-relay',id:'861',title:'x',objective:'x'.repeat(2*1024*1024+4096),project_root:f.root,project_path:null,priority:'P2',review_enabled:false,auto_merge:false});
  assert.equal(oversized.ok,false);assert.match(oversized.error,/exceeds 2 MiB|oversized control request/);
  const invalid=invoke(f,createArgs(f,['--priority','P8']));
  assert.equal(invalid.status,2,invalid.stderr);assert.match(invalid.stderr,/priority must be P0, P1, P2, or P3/);
  const unknown=invoke(f,['job','update','--db',f.db,'--id','861','--repo','agents-relay','--title','No unknown Job']);
  assert.equal(unknown.status,2);assert.match(unknown.stderr,/unknown Job/);
  const sql=new DatabaseSync(f.db);assert.equal(sql.prepare('SELECT count(*) AS n FROM job_snapshot').get().n,0);sql.close();
  const created=invoke(f,createArgs(f));assert.equal(created.status,0,created.stderr);assert.equal(JSON.parse(created.stdout).created,true);
  assert.deepEqual(readJob(f.db).repository,'agents-relay');
  await stop(child);child=null;assert.equal(existsSync(f.socket),false,'daemon removes socket on shutdown');
  child=start(f);await waitForSocket(f,child);
  const duplicate=invoke(f,createArgs(f));assert.equal(duplicate.status,0,duplicate.stderr);
  assert.equal(JSON.parse(duplicate.stdout).created,false);assert.equal(JSON.parse(duplicate.stdout).deduplicated,true);
  const mismatch=invoke(f,createArgs(f,['--title','different']));
  assert.equal(mismatch.status,2);assert.match(mismatch.stderr,/different immutable create identity/);
  const check=new DatabaseSync(f.db);assert.equal(check.prepare('SELECT count(*) AS n FROM job_snapshot').get().n,1);check.close();
  assert.equal(readJob(f.db).title,'Agents Relay job');
 }finally{if(child)await stop(child);rmSync(f.home,{recursive:true,force:true});}
});

test('native live mutation fails closed without daemon socket and never falls back to Node',()=>{
 const f=fixture();try{
  const result=invoke(f,createArgs(f));assert.equal(result.status,2);assert.match(result.stderr,/control socket unavailable/);
  const sql=new DatabaseSync(f.db);assert.equal(sql.prepare('SELECT count(*) AS n FROM job_snapshot').get().n,0);sql.close();
 }finally{rmSync(f.home,{recursive:true,force:true});}
});


test('Rust-only live Job update, pause, resume and cancel go through daemon sole writer and survive restart', {concurrency:false}, async()=>{
 const f=fixture();let child;
 const mutate=(action,fields=[])=>invoke(f,['job',action,'--db',f.db,'--id','861','--repo','agents-relay',...fields]);
 try{
  child=start(f);await waitForSocket(f,child);
  const created=invoke(f,createArgs(f));assert.equal(created.status,0,created.stderr);
  const updated=mutate('update',['--title','Updated by Rust','--priority','P1',
    '--objective','Updated objective','--no-review','--no-auto-merge']);
  assert.equal(updated.status,0,updated.stderr);
  assert.equal(JSON.parse(updated.stdout).operation,'job.update');
  const original=readJob(f.db);
  assert.equal(original.title,'Updated by Rust');
  assert.equal(original.priority,'P1');
  assert.equal(original.objective,'Updated objective');
  assert.equal(original.reviewEnabled,false);
  assert.equal(original.autoMerge,false);
  // All invalid mutations must fail before or within the daemon CAS, with no DB write.
  const before=JSON.stringify(readJob(f.db));
  for(const [args,pattern] of [
    [['job','update','--db',f.db,'--id','861','--repo','wrong','--title','spoofed'],/binding mismatch/],
    [['job','update','--db',f.db,'--id','861','--repo','agents-relay','--priority','P99'],/priority must/],
    [['job','update','--db',f.db,'--id','861','--repo','agents-relay','--review','--no-review'],/conflicting/],
    [['job','update','--db',f.db,'--id','861','--repo','agents-relay','--project-root','/not-a-real-directory'],/projectRoot/],
    [['job','pause','--db',f.db,'--id','861','--repo','agents-relay','--title','silently-ignored'],/refusing to discard/],
    [['job','resume','--db',f.db,'--id','861','--repo','agents-relay','--reason','ignored'],/refusing to discard/],
    [['job','cancel','--db',f.db,'--id','861','--repo','agents-relay','--priority','P0'],/refusing to discard/],
  ]){
   const rejected=invoke(f,args);
   assert.equal(rejected.status,2,rejected.stderr);
   assert.match(rejected.stderr,pattern);
   assert.equal(JSON.stringify(readJob(f.db)),before,'invalid request mutated durable Job');
  }
  const denied=await rawRequest(f.socket,{
   version:1,operation:'job.update',repository:'agents-relay',id:'861',
   title:'',objective:'',project_root:'',project_path:null,priority:'',
   review_enabled:false,auto_merge:false,changes:{state:'COMPLETED'}
  });
  assert.equal(denied.ok,false);
  assert.match(denied.error,/unsupported Job update property state/);
  assert.equal(JSON.stringify(readJob(f.db)),before);
  const paused=mutate('pause');assert.equal(paused.status,0,paused.stderr);
  assert.equal(JSON.parse(paused.stdout).operation,'job.pause');
  const pausedAt=readJob(f.db).pause.requestedAt;
  const again=mutate('pause');assert.equal(again.status,0,again.stderr);
  assert.equal(readJob(f.db).pause.requestedAt,pausedAt,'repeated pause has one durable receipt');
  await stop(child);child=null;
  child=start(f);await waitForSocket(f,child);
  assert.equal(readJob(f.db).pause.requestedAt,pausedAt,'pause survived daemon restart');
  const resumed=mutate('resume');assert.equal(resumed.status,0,resumed.stderr);
  assert.equal(readJob(f.db).pause,undefined);
  const cancelled=mutate('cancel',['--reason','User requested cancel']);
  assert.equal(cancelled.status,0,cancelled.stderr);
  assert.equal(readJob(f.db).state,'CANCELLED');
  const terminal=JSON.stringify(readJob(f.db));
  const noResume=mutate('resume');
  assert.equal(noResume.status,2);assert.match(noResume.stderr,/Cannot resume terminal Job/);
  assert.equal(JSON.stringify(readJob(f.db)),terminal);
  const noCancel=mutate('cancel');
  assert.equal(noCancel.status,2);assert.match(noCancel.stderr,/canonical Job Graph denied cancellation|unknown event/);
  assert.equal(JSON.stringify(readJob(f.db)),terminal);
 }finally{if(child)await stop(child);rmSync(f.home,{recursive:true,force:true});}
});

test('live control refuses pause and cancel while an execution lease is active', {concurrency:false}, async()=>{
 const f=fixture();let child;
 try{
  child=start(f);await waitForSocket(f,child);
  assert.equal(invoke(f,createArgs(f)).status,0);
  const sql=new DatabaseSync(f.db);
  const j=readJob(f.db);
  // Keep this Job DRAFT so the daemon does not execute a synthetic worker.
  j.state='DRAFT';
  j.tasks=[{id:'1',title:'running',state:'RUNNING',
   executionId:'execution-1',leaseOwner:'daemon-1',leaseExpiresAt:'2099-01-01T00:00:00Z'}];
  sql.prepare('UPDATE job_snapshot SET json=? WHERE job_id=?').run(JSON.stringify(j),'861');
  sql.close();
  const before=JSON.stringify(readJob(f.db));
  for(const action of ['pause','cancel']){
    const result=invoke(f,['job',action,'--db',f.db,'--id','861','--repo','agents-relay']);
    assert.equal(result.status,2,result.stderr);
    assert.match(result.stderr,/active executions|active Task execution/);
    assert.equal(JSON.stringify(readJob(f.db)),before,'did not forge cancellation of active worker');
  }
 }finally{if(child)await stop(child);rmSync(f.home,{recursive:true,force:true});}
});

test('job unblock atomically retries blocked Troubleshooters only, preserving Graph provenance and rejecting pending human escalations', {concurrency:false}, async()=>{
 const f=fixture();let child;
 const command=(reason='External blocker resolved')=>invoke(f,['job','unblock','--db',f.db,
    '--id','861','--repo','agents-relay','--reason',reason]);
 try{
  child=start(f);await waitForSocket(f,child);
  assert.equal(invoke(f,createArgs(f)).status,0);
  const sql=new DatabaseSync(f.db);
  const j=readJob(f.db);
  const stamp='2026-11-15T11:00:00Z';
  j.tasks=[
   {id:'1',kind:'worker',agentName:'troubleshooter',state:'BLOCKED',title:'Troubleshoot A',
    updatedAt:stamp,attempt:3,maxAttempts:2,error:'Blocked A',failureReason:'external',
    blockedBaseline:{blockedAt:stamp,reason:'Blocked A'},blockedBy:{cause:'external'},leaseOwner:null,executionId:null},
   {id:'2',kind:'worker',agentName:'troubleshooter',state:'BLOCKED',title:'Troubleshoot B',
    updatedAt:stamp,attempt:2,maxAttempts:5,error:'Blocked B',leaseOwner:null,executionId:null},
   {id:'3',kind:'worker',agentName:'developer',state:'BLOCKED',title:'Unrelated blocked work',
    updatedAt:stamp,attempt:1,maxAttempts:2,error:'Blocked work',leaseOwner:null,executionId:null}
  ];
  sql.prepare('UPDATE job_snapshot SET json=? WHERE job_id=?').run(JSON.stringify(j),'861');
  sql.close();
  const empty=command(' ');
  assert.equal(empty.status,2);assert.match(empty.stderr,/requires nonempty --reason/);
  const badRepo=invoke(f,['job','unblock','--db',f.db,'--id','861','--repo','another','--reason','done']);
  assert.equal(badRepo.status,2);assert.match(badRepo.stderr,/binding mismatch/);
  const before=JSON.stringify(readJob(f.db));
  assert.equal(command('--malformed').status,2);
  assert.equal(JSON.stringify(readJob(f.db)),before,'invalid request is read-only');
  const response=command();
  assert.equal(response.status,0,response.stderr);
  const summary=JSON.parse(response.stdout);
  assert.equal(summary.jobId,'861');
  assert.deepEqual(summary.resumedTasks,['1','2']);
  const after=readJob(f.db);
  assert.equal(after.tasks[0].state,'QUEUED');
  assert.equal(after.tasks[1].state,'QUEUED');
  assert.equal(after.tasks[2].state,'BLOCKED','unrelated blocked non-Troubleshooter stays blocked');
  assert.equal(after.tasks[0].attempt,0);
  assert.equal(after.tasks[0].maxAttempts,3);
  assert.equal(after.tasks[1].maxAttempts,5);
  assert.equal(after.tasks[0].error,null);
  assert.equal(after.tasks[0].failureReason,undefined);
  assert.equal(after.tasks[0].blockedBy,undefined);
  assert.equal(after.tasks[0].unblock.event,'task.unblocked');
  assert.equal(after.tasks[0].unblock.source,'cli');
  assert.equal(after.tasks[0].unblock.reason,'External blocker resolved');
  assert.equal(after.tasks[0].unblock.baseline.reason,'Blocked A');
  assert.equal(command().status,2,'duplicate unblock must not spin a new round');
  await stop(child);child=null;
  child=start(f);await waitForSocket(f,child);
  assert.equal(readJob(f.db).tasks[0].state,'QUEUED','unblock state survives daemon restart');
 }finally{if(child)await stop(child);rmSync(f.home,{recursive:true,force:true});}
});

test('job unblock never forges a human response or bypasses active Troubleshooter lease', {concurrency:false}, async()=>{
 const f=fixture();let child;
 try{
  child=start(f);await waitForSocket(f,child);
  assert.equal(invoke(f,createArgs(f)).status,0);
  const sql=new DatabaseSync(f.db);
  const j=readJob(f.db);
  j.tasks=[{id:'1',kind:'worker',agentName:'troubleshooter',state:'BLOCKED',
   title:'Blocked escalation',updatedAt:'2026-11-15T11:00:00Z',attempt:2,maxAttempts:3,
   escalation:{id:'escalation-1',status:'pending',requiredAction:'Human verification'},
   leaseOwner:null,executionId:null}];
  const save=sql.prepare('UPDATE job_snapshot SET json=? WHERE job_id=?');
  save.run(JSON.stringify(j),'861');
  const run=()=>invoke(f,['job','unblock','--db',f.db,'--id','861','--repo','agents-relay','--reason','claim resolved']);
  const before=JSON.stringify(readJob(f.db));
  const denied=run();assert.equal(denied.status,2);
  assert.match(denied.stderr,/authorized human response/);
  assert.equal(JSON.stringify(readJob(f.db)),before);
  j.tasks[0].escalation.status='resolved';
  j.tasks[0].leaseOwner='still-working';
  j.tasks[0].executionId='exec-current';
  save.run(JSON.stringify(j),'861');
  const active=JSON.stringify(readJob(f.db));
  const lease=run();assert.equal(lease.status,2);assert.match(lease.stderr,/active Troubleshooter execution lease/);
  assert.equal(JSON.stringify(readJob(f.db)),active);
  sql.close();
 }finally{if(child)await stop(child);rmSync(f.home,{recursive:true,force:true});}
});
