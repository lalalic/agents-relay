import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,symlinkSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,spawnSync,execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {SQLiteRelayStore} from '../../dist/relay-store.js';
import {DatabaseSync} from 'node:sqlite';
const binary=resolve(import.meta.dirname,'../target/debug/relay-native-daemon');
const helper=resolve(import.meta.dirname,'../target/debug/relay-worker-helper');
const t0='2026-11-13T20:00:00.000Z';
const yes={...process.env,RELAY_RUST_EXPERIMENTAL_TEST_ONLY:'isolated-test'};
const script=`printf '{"jobId":"%s","taskId":"%s","executionId":"%s","status":"COMPLETED","output":{"verified":true}}' "$RELAY_JOB_ID" "$RELAY_TASK_ID" "$RELAY_EXECUTION_ID" > "$RELAY_RESULT_PATH"; echo success`;
function fixture(source=script){
 const dir=mkdtempSync(join(tmpdir(),'relay-rust-authority-'));
 const db=join(dir,'relay.sqlite'),manifest=join(dir,'manifest.json');
 writeFileSync(join(dir,'.relay-rust-authority-isolated-test'),'test-only');
 writeFileSync(manifest,JSON.stringify({agents:{alpha:{executable:'/bin/sh',args:['-c',source]}}}));
 const args=['--once','--db',db,'--manifest',manifest,'--helper',helper,'--max-tasks','20'];
 return {dir,db,manifest,args};
}
function task(id,jobId,deps=[],state='QUEUED'){
 return {id,jobId,title:'native '+id,kind:'work',agentName:'alpha',parentTaskId:null,dependencies:deps,
 adapter:'script',capabilities:['script'],input:'fixture',state,
 attempt:0,maxAttempts:3,leaseOwner:null,leaseExpiresAt:null,executionId:null,threadId:null,
 error:null,result:null,timeoutMs:1200,createdAt:t0,updatedAt:t0};
}
async function save(store,root,id,tasks){
 await store.saveJob({id,title:'native daemon '+id,repository:'example',projectRoot:root,prNumber:0,
  state:'ACTIVE',reviewEnabled:true,createdAt:t0,updatedAt:t0,tasks});
}
function once(f,env=yes){
 const result=spawnSync(binary,f.args,{encoding:'utf8',env,timeout:10000});
 assert.equal(result.status,0,result.stderr);
 return JSON.parse(result.stdout.trim())?.report;
}
async function until(callback,timeout=6000){
 const end=Date.now()+timeout;
 while(Date.now()<end){const value=await callback();if(value)return value;await delay(30);}
 throw Error('condition timeout');
}
function alive(pid){
 try{const stat=execFileSync('/bin/ps',['-p',String(pid),'-o','stat='],{encoding:'utf8',timeout:1500}).trim();return stat!==''&&!stat.startsWith('Z');}
 catch{return false;}
}
function runAsync(f){
 return new Promise(resolvePromise=>{
  const child=spawn(binary,f.args,{env:yes,stdio:['ignore','pipe','pipe']});
  let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
  child.once('close',code=>resolvePromise({code,out,err}));
 });
}
test('isolated native daemon: multi-job and dependency wave, physical helper + SQLite readback',async()=>{
 const f=fixture();let store;
 try{
  store=new SQLiteRelayStore(f.db);
  await save(store,f.dir,'91',[task('101','91'),task('102','91',['101'],'DRAFT')]);
  await save(store,f.dir,'92',[task('201','92')]);
  store.close();store=null;
  const first=once(f);
  assert.equal(first.tasksClaimed,2,JSON.stringify(first));
  assert.equal(first.tasksSucceeded,2,JSON.stringify(first));
  store=new SQLiteRelayStore(f.db);
  let job=await store.loadJob('91');
  assert.equal(job.tasks[0].state,'SUCCEEDED');
  assert.equal(job.tasks[1].state,'DRAFT');
  assert.equal(job.state,'ACTIVE','Script must not bypass Final Review');
  assert.equal((await store.loadJob('92')).tasks[0].state,'SUCCEEDED');
  store.close();store=null;
  const second=once(f);
  assert.equal(second.tasksQueued,1);
  assert.equal(second.tasksSucceeded,1);
  store=new SQLiteRelayStore(f.db);job=await store.loadJob('91');
  assert.deepEqual(job.tasks.map(t=>t.state),['SUCCEEDED','SUCCEEDED']);
  assert.equal(job.tasks[1].result.data.output.verified,true);
  assert.equal(once(f).tasksClaimed,0,'restart must never repeat terminal Script');
  const sql=new DatabaseSync(f.db);
  assert.equal(sql.prepare('SELECT count(*) AS n FROM workflow_action_trace').get().n,3);
  assert.equal(sql.prepare('SELECT count(*) AS n FROM execution_process WHERE ended_at IS NOT NULL').get().n,3);
  sql.close();
  console.log('Native daemon: three real Workers, two Jobs, dependency wave, no repeat on restart');
 }finally{store?.close();rmSync(f.dir,{recursive:true,force:true});}
});
test('two independent native daemon invocations compete but cannot duplicate a Script generation',async()=>{
 const f=fixture();let store;
 try{
  store=new SQLiteRelayStore(f.db);await save(store,f.dir,'91',[task('101','91')]);store.close();store=null;
  const [a,b]=await Promise.all([runAsync(f),runAsync(f)]);
  assert.equal(a.code,0,a.err);assert.equal(b.code,0,b.err);
  store=new SQLiteRelayStore(f.db);
  const j=await store.loadJob('91');assert.equal(j.tasks[0].state,'SUCCEEDED');
  const sql=new DatabaseSync(f.db);
  assert.equal(sql.prepare('SELECT count(*) AS n FROM workflow_action_trace').get().n,1);
  assert.equal(sql.prepare('SELECT count(*) AS n FROM execution_process').get().n,1);
  sql.close();
 }finally{store?.close();rmSync(f.dir,{recursive:true,force:true});}
});
test('daemon refuses production or unmarked SQLite before any worker launch',async()=>{
 const f=fixture();let store;
 try{
  store=new SQLiteRelayStore(f.db);await save(store,f.dir,'91',[task('101','91')]);store.close();store=null;
  const denied=spawnSync(binary,f.args,{encoding:'utf8',env:{...process.env,RELAY_RUST_EXPERIMENTAL_TEST_ONLY:''}});
  assert.notEqual(denied.status,0);assert.match(denied.stderr,/isolated-test required/);
  const sql=new DatabaseSync(f.db);
  assert.equal(sql.prepare('SELECT count(*) AS n FROM sqlite_master WHERE name=\'workflow_action_trace\'').get().n,0);
  sql.close();
 }finally{store?.close();rmSync(f.dir,{recursive:true,force:true});}
});
test('SIGKILL daemon -> helper kills owned worker -> restart marks proven expired execution FAILED once',async()=>{
 const f=fixture('sleep 20; '+script);let store,daemon,pid;
 try{
  store=new SQLiteRelayStore(f.db);
  const t=task('101','91');t.timeoutMs=1200;
  await save(store,f.dir,'91',[t]);store.close();store=null;
  daemon=spawn(binary,f.args,{env:yes,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';daemon.stdout.on('data',b=>stdout+=b);daemon.stderr.on('data',b=>stderr+=b);
  pid=await until(()=>{
   const db=new DatabaseSync(f.db);let row;
   try{row=db.prepare('SELECT pid FROM execution_process LIMIT 1').get();}catch{}
   db.close();return row?.pid;
  },6500);
  assert.ok(alive(pid),'worker must be active before daemon death');
  daemon.kill('SIGKILL');
  await until(()=>!alive(pid),6000);
  store=new SQLiteRelayStore(f.db);
  assert.equal((await store.loadJob('91')).tasks[0].state,'RUNNING');
  // Advance only the disposable Task lease clock; the real Worker has
  // already been reaped by the helper after a physical SIGKILL of daemon.
  await store.mutateJob('91',j=>{
    j.tasks[0].leaseExpiresAt=new Date(Date.now()-500).toISOString();
    return j;
  });
  store.close();store=null;
  const restart=once(f);
  assert.equal(restart.tasksRecovered,1,JSON.stringify(restart));
  assert.equal(restart.tasksClaimed,0,'orphan recovery does not auto-retry');
  store=new SQLiteRelayStore(f.db);
  const finishedTask=(await store.loadJob('91')).tasks[0];
  assert.equal(finishedTask.state,'FAILED');assert.equal(finishedTask.executionId,null);
  assert.equal(finishedTask.failureReason,'worker_outcome_unknown');
  assert.equal(finishedTask.executionHistory.length,1);
  const sql=new DatabaseSync(f.db);
  assert.equal(sql.prepare('SELECT count(*) AS n FROM workflow_event_outbox WHERE event_id=\'task.failed\'').get().n,1);
  sql.close();
  assert.equal(once(f).tasksRecovered,0,'replay of recovery must be idempotent');
  console.log('SIGKILL real daemon: helper reaped worker; verified lease expiry -> single FAILED recovery event');
 }finally{
  daemon?.kill('SIGKILL');
  if(pid&&alive(pid)){try{process.kill(-pid,'SIGKILL');}catch{}}
  store?.close();await delay(80);rmSync(f.dir,{recursive:true,force:true});
 }
});

test('SIGTERM daemon cancels running helper Worker promptly, persists FAILED without false success',async()=>{
 const f=fixture('sleep 20; '+script);let store,daemon,pid;
 try{
  store=new SQLiteRelayStore(f.db);
  const t=task('101','91');t.timeoutMs=20000;
  await save(store,f.dir,'91',[t]);store.close();store=null;
  daemon=spawn(binary,f.args,{env:yes,stdio:['ignore','pipe','pipe']});
  const exit=new Promise(resolvePromise=>daemon.once('close',(code,signal)=>resolvePromise({code,signal})));
  pid=await until(()=>{
   const db=new DatabaseSync(f.db);let row;
   try{row=db.prepare('SELECT pid FROM execution_process LIMIT 1').get();}catch{}
   db.close();return row?.pid;
  },5000);
  assert.ok(alive(pid));
  daemon.kill('SIGTERM');
  const outcome=await Promise.race([exit,delay(3600).then(()=>({code:'TIMEOUT'}))]);
  assert.equal(outcome.code,0,'graceful signal should cancel helper, not wait 20s');
  await until(()=>!alive(pid),3500);
  store=new SQLiteRelayStore(f.db);
  const job=await store.loadJob('91');
  assert.equal(job.tasks[0].state,'FAILED');
  assert.equal(job.tasks[0].result,null);
  assert.equal(job.state,'ACTIVE');
  const sql=new DatabaseSync(f.db);
  assert.equal(sql.prepare('SELECT count(*) AS n FROM execution_process WHERE ended_at IS NOT NULL').get().n,1);
  sql.close();
 }finally{
  daemon?.kill('SIGKILL');
  if(pid&&alive(pid)){try{process.kill(-pid,'SIGKILL');}catch{}}
  store?.close();await delay(80);rmSync(f.dir,{recursive:true,force:true});
 }
});

test('expired leased Task without durable PID is BLOCKED, not retried or falsely completed',async()=>{
 const f=fixture();let store;
 try{
  store=new SQLiteRelayStore(f.db);
  const original=task('101','91');original.state='RUNNING';
  original.attempt=1;original.leaseOwner='rust-native-isolated';
  original.executionId='orphan-before-pid';
  original.leaseExpiresAt='2026-11-13T20:00:01.000Z';
  original.executionHistory=[{id:'orphan-before-pid',attempt:1,startedAt:t0}];
  await save(store,f.dir,'91',[original]);store.close();store=null;
  const result=once(f);
  assert.equal(result.tasksRecovered,0);
  assert.equal(result.tasksClaimed,0);
  assert.match(result.blocked.join(' '),/no durable PID/);
  store=new SQLiteRelayStore(f.db);
  const restored=(await store.loadJob('91')).tasks[0];
  assert.equal(restored.state,'RUNNING');
  assert.equal(restored.executionId,'orphan-before-pid');
  assert.equal(restored.failureReason,undefined);
 }finally{store?.close();rmSync(f.dir,{recursive:true,force:true});}
});
test('Script output symlink cannot escape isolated DB root',async()=>{
 const f=fixture();const target=mkdtempSync(join(tmpdir(),'relay-native-symlink-target-'));let store;
 try{
  symlinkSync(target,join(f.dir,'.relay-rust-native-executions'));
  store=new SQLiteRelayStore(f.db);
  await save(store,f.dir,'91',[task('101','91')]);store.close();store=null;
  const report=once(f);
  assert.equal(report.tasksClaimed,0);
  assert.match(report.blocked.join(' '),/unsafe symlink/);
  assert.equal(existsSync(join(target,'91')),false);
  store=new SQLiteRelayStore(f.db);
  assert.equal((await store.loadJob('91')).tasks[0].state,'QUEUED');
 }finally{store?.close();rmSync(f.dir,{recursive:true,force:true});rmSync(target,{recursive:true,force:true});}
});

test('native --loop polls unchanged SQLite without writes and exits cleanly on SIGTERM',async()=>{
 const f=fixture();let store,daemon;
 try{
  store=new SQLiteRelayStore(f.db);
  await save(store,f.dir,'91',[]);store.close();store=null;
  daemon=spawn(binary,['--loop',...f.args.filter(arg=>arg!=='--once'),'--interval-ms','150'],
   {env:yes,stdio:['ignore','pipe','pipe']});
  let output='',errors='';daemon.stdout.on('data',b=>output+=b);daemon.stderr.on('data',b=>errors+=b);
  const exited=new Promise(resolvePromise=>daemon.once('close',(code,signal)=>resolvePromise({code,signal})));
  await until(()=>output.split('\n').filter(line=>line.includes('"type":"tick"')).length>=2,3500);
  daemon.kill('SIGTERM');
  const result=await Promise.race([exited,delay(2200).then(()=>({code:'TIMEOUT'}))]);
  assert.equal(result.code,0,errors);
  store=new SQLiteRelayStore(f.db);
  const j=await store.loadJob('91');
  assert.equal(j.updatedAt,t0,'idle ticks must not rewrite snapshots');
  assert.equal(j.tasks.length,0);
 }finally{daemon?.kill('SIGKILL');store?.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('concurrent daemon dependency ticks converge without redundant SQLite snapshot changes',async()=>{
 const f=fixture();let store;
 try{
  store=new SQLiteRelayStore(f.db);
  const completed=task('101','91');completed.state='SUCCEEDED';
  await save(store,f.dir,'91',[completed,task('102','91',['101'],'DRAFT')]);
  store.close();store=null;
  const attempts=await Promise.all([runAsync(f),runAsync(f)]);
  for(const attempt of attempts)assert.equal(attempt.code,0,attempt.err);
  store=new SQLiteRelayStore(f.db);
  const tasks=(await store.loadJob('91')).tasks;
  assert.equal(tasks[1].state,'SUCCEEDED');
  assert.equal(tasks[1].attempt,1);
  const sql=new DatabaseSync(f.db);
  assert.equal(sql.prepare('SELECT count(*) AS n FROM workflow_action_trace').get().n,1);
  sql.close();
 }finally{store?.close();rmSync(f.dir,{recursive:true,force:true});}
});
