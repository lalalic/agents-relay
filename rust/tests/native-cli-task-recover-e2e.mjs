import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';

const bin=process.env.CARGO_TARGET_DIR??resolve(import.meta.dirname,'../target');
const cli=join(bin,'debug/relay-native-job');
const daemon=join(bin,'debug/relay-native-daemon');
const helper=join(bin,'debug/relay-worker-helper');
const isolated={...process.env,RELAY_RUST_EXPERIMENTAL_TEST_ONLY:'isolated-test',RELAY_RUST_LIVE_MODE:''};
function run(env,args){return spawnSync(cli,args,{encoding:'utf8',env,timeout:10000});}
function call(env,args,status=0){
 const p=run(env,args);assert.equal(p.status,status,p.stderr||p.stdout);
 return status===0?JSON.parse(p.stdout):p.stderr;
}
function read(db,id){
 const sql=new DatabaseSync(db);
 try{
  const r=sql.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get(id);
  return r?JSON.parse(r.json):null;
 }finally{sql.close();}
}
function save(db,j){
 const sql=new DatabaseSync(db);
 try{sql.prepare('UPDATE job_snapshot SET json=? WHERE job_id=?').run(JSON.stringify(j),j.id);}
 finally{sql.close();}
}
function args(f,extra=[]){
 return ['task','recover','--db',f.db,'--repo','recover-test','--id',f.id,
  '--task-id',f.original,'--recovery-task-id',f.recovery,...extra];
}
function seed(f,{execution='recovery-exec-1',state='RUNNING'}={}){
 const j=read(f.db,f.id);
 const original=j.tasks.find(t=>t.id===f.original);
 const recovery=j.tasks.find(t=>t.id===f.recovery);
 j.state='ACTIVE';
 original.state='FAILED';original.attempt=3;original.maxAttempts=3;
 original.error='provider exploded';original.failureReason='provider_failure';
 original.leaseOwner=null;original.leaseExpiresAt=null;original.executionId=null;
 original.routing={provider:'openai',model:'old-model',profile:'old-profile'};
 original.workerSelection={agentId:'old-agent'};
 original.resolution=null;
 recovery.agentName='troubleshooter';recovery.parentTaskId=f.original;
 recovery.state=state;recovery.executionId=execution;
 recovery.attempt=1;recovery.maxAttempts=4;
 recovery.leaseOwner='worker';recovery.leaseExpiresAt='2099-01-01T00:00:00Z';
 save(f.db,j);
 return j;
}
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'relay-rust-authority-recover-'));
 mkdirSync(join(root,'project'));
 writeFileSync(join(root,'.relay-rust-authority-isolated-test'),'isolated-test');
 const db=join(root,'relay.sqlite'),id='81';
 call(isolated,['init','--db',db]);
 call(isolated,['job','create','--db',db,'--id',id,'--repo','recover-test',
  '--title','Task recover','--objective','Recover exact original task',
  '--project-root',join(root,'project'),'--no-review']);
 function add(title){
  return call(isolated,['task','create','--db',db,'--id',id,'--repo','recover-test',
   '--title',title,'--input',title,'--output','file',
   '--output-path',join(root,'project',title+'.txt')]).taskId;
 }
 const f={root,db,id,original:add('original'),recovery:add('troubleshooter'),env:isolated};
 seed(f);return f;
}
const diag=['--failure-kind','provider_failure','--reason','The old provider is unavailable',
 '--evidence','HTTP 503','--reroute','--exclude-current-route'];

test('Rust task recover Graph retries exact FAILED original with fresh Troubleshooter generation and routing exclusion',()=>{
 const f=fixture();
 try{
  const before=read(f.db,f.id);
  const original=before.tasks.find(t=>t.id===f.original);
  const recovery=before.tasks.find(t=>t.id===f.recovery);
  const result=call(isolated,args(f,diag));
  assert.equal(result.id,f.original);
  assert.equal(result.state,'QUEUED');
  assert.equal(result.maxAttempts,6);
  assert.equal(result.attempt,3,'preserve failed original attempt count');
  assert.equal(result.error,null);
  assert.equal(result.failureReason,undefined);
  assert.equal(result.executionId,null);
  assert.equal(result.leaseOwner,null);
  assert.equal(result.routing,undefined);
  assert.equal(result.workerSelection,undefined);
  assert.deepEqual(result.routingExclusions.map(({provider,model,profile,reason})=>({provider,model,profile,reason})),[
   {provider:'openai',model:'old-model',profile:'old-profile',reason:'The old provider is unavailable'}]);
  assert.equal(result.recoveryContext.failureKind,'provider_failure');
  assert.equal(result.recoveryContext.recoveryTaskId,f.recovery);
  assert.equal(result.recoveryContext.reroute,true);
  assert.equal(result.recoveryContext.evidence,'HTTP 503');
  assert.equal(result.resolution.path,'exact_original_retry');
  assert.equal(result.resolution.owner,'troubleshooter');
  assert.equal(result.resolution.state,'resolved');
  assert.equal(result.resolution.targetTaskId,f.original);
  assert.equal(result.resolution.recoveryExecutionId,'recovery-exec-1');
  const after=read(f.db,f.id);
  assert.equal(after.tasks.length,before.tasks.length);
  assert.deepEqual(after.tasks.find(t=>t.id===f.recovery),recovery,'recovery worker stays untouched');
  const again=call(isolated,args(f,diag),2);
  assert.match(again,/requires FAILED/);
  assert.deepEqual(read(f.db,f.id),after,'duplicate recovery is a rejected no-op');
  assert.equal(after.tasks.find(t=>t.id===f.original).id,original.id);
 }finally{rmSync(f.root,{recursive:true,force:true});}
});

test('Rust task recover rejects invalid lineage, stale or missing recovery execution, leased original and bad diagnoses atomically',()=>{
 const scenarios=[
  [j=>j.tasks.find(t=>t.id===j.original).state='QUEUED',/requires FAILED/],
  [j=>j.tasks.find(t=>t.id===j.original).executionId='original-still-running',/active execution lease/],
  [j=>j.tasks.find(t=>t.id===j.recovery).agentName='worker',/active Troubleshooter/],
  [j=>j.tasks.find(t=>t.id===j.recovery).parentTaskId='wrong',/active Troubleshooter/],
  [j=>j.tasks.find(t=>t.id===j.recovery).executionId=null,/no current execution/],
  [j=>j.tasks.find(t=>t.id===j.recovery).state='SUCCEEDED',/active Troubleshooter/],
  [j=>j.tasks.find(t=>t.id===j.original).resolution={state:'waiting',path:'escalation_gate'},/active or waiting recovery ownership/],
  [j=>j.tasks.find(t=>t.id===j.original).resolution={recoveryExecutionId:'recovery-exec-1',state:'resolved'},/already recorded/],
  [j=>j.state='COMPLETED',/active unpaused Job/],
  [j=>j.pause={generation:1},/active unpaused Job/],
 ];
 const f=fixture();
 try{
  for(const [edit,pattern] of scenarios){
   seed(f);
   const j=read(f.db,f.id);j.original=f.original;j.recovery=f.recovery;
   edit(j);delete j.original;delete j.recovery;save(f.db,j);
   const before=JSON.stringify(read(f.db,f.id));
   assert.match(call(isolated,args(f),2),pattern);
   assert.equal(JSON.stringify(read(f.db,f.id)),before);
  }
  seed(f);
  const invalid=[
   [args(f,['--failure-kind','bad','--reason','x']),/Invalid recovery failureKind/],
   [args(f,['--failure-kind','provider_failure']),/requires --reason/],
   [args(f,['--reroute']),/require --failure-kind/],
   [args(f,['--failure-kind','provider_failure','--reason','x','--exclude-current-route']),/Cannot exclude route without reroute/],
   [args(f,['--recovery-task-id','extra']),/duplicate option/],
   [args(f,['--message','unexpected']),/unrecognized/],
   [args(f).map((x,i,a)=>a[i-1]==='--repo'?'forged':x),/repository identity mismatch/],
  ];
  const before=JSON.stringify(read(f.db,f.id));
  for(const [argv,pattern] of invalid){
   assert.match(call(isolated,argv,2),pattern,argv.join(' '));
   assert.equal(JSON.stringify(read(f.db,f.id)),before);
  }
 }finally{rmSync(f.root,{recursive:true,force:true});}
});

test('workflow action task.recover delegates to the same canonical authority with diagnosis flags',()=>{
 const f=fixture();
 try{
  const action=['workflow','action','--db',f.db,'--repo','recover-test',
    '--id',f.id,'--task-id',f.original,'--action','task.recover',
    '--recovery-task-id',f.recovery,...diag];
  const restored=call(isolated,action);
  assert.equal(restored.state,'QUEUED');
  assert.equal(restored.resolution.recoveryExecutionId,'recovery-exec-1');
  assert.equal(restored.routing,undefined);
  const before=read(f.db,f.id);
  assert.match(call(isolated,action,2),/requires FAILED/);
  assert.deepEqual(read(f.db,f.id),before);
 }finally{rmSync(f.root,{recursive:true,force:true});}
});

test('fresh Troubleshooter execution can recover a subsequent failure episode without reusing previous execution',()=>{
 const f=fixture();
 try{
  const first=call(isolated,args(f));
  assert.equal(first.routing.model,'old-model','no diagnosis means retain original route');
  assert.equal(first.recoveryContext,undefined);
  const j=read(f.db,f.id);
  j.tasks.find(t=>t.id===f.original).state='FAILED';
  j.tasks.find(t=>t.id===f.original).error='new failure episode';
  j.tasks.find(t=>t.id===f.recovery).executionId='recovery-exec-2';
  save(f.db,j);
  const second=call(isolated,args(f,['--failure-kind','task_failure','--reason','new issue']));
  assert.equal(second.resolution.recoveryExecutionId,'recovery-exec-2');
  assert.equal(second.maxAttempts,9);
 }finally{rmSync(f.root,{recursive:true,force:true});}
});

async function ready(f,child){
 for(let i=0;i<120;i++){
  if(existsSync(f.socket))return;
  if(child.exitCode!==null)throw Error('Rust daemon exited: '+child.stderrText);
  await delay(20);
 }
 throw Error('Rust daemon socket unavailable: '+child.stderrText);
}
async function stop(child){
 if(!child||child.exitCode!==null)return;
 child.kill('SIGTERM');
 await Promise.race([new Promise(ok=>child.once('exit',ok)),delay(3000)]);
 if(child.exitCode===null){child.kill('SIGKILL');await new Promise(ok=>child.once('exit',ok));}
}
test('production-mode recover uses daemon-owned socket and survives daemon restart without a second writer',async()=>{
 const home=mkdtempSync('/tmp/rr-rec-');
 const root=join(home,'.local/state/agents-relay/rust-live');
 mkdirSync(root,{recursive:true,mode:0o700});chmodSync(root,0o700);
 writeFileSync(join(root,'.relay-rust-live-namespace-v1'),'rust-relay-owned-standalone-namespace-v1\n',{mode:0o600});
 writeFileSync(join(root,'manifest.json'),JSON.stringify({agents:{}}));
 const db=join(root,'relay.sqlite');
 const sql=new DatabaseSync(db);
 sql.exec('PRAGMA journal_mode=WAL; CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL); CREATE TABLE relay_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE agent_snapshot(agent_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL);');
 sql.close();chmodSync(db,0o600);
 const env={...process.env,HOME:home,RELAY_RUST_LIVE_MODE:'pilot-live',RELAY_RUST_EXPERIMENTAL_TEST_ONLY:''};
 const f={home,root,db,id:'91',original:'original',recovery:'recovery',env,
   socket:join(root,'.rc.sock')};
 let child;
 const start=()=>{
  const proc=spawn(daemon,['--loop','--db',db,'--manifest',join(root,'manifest.json'),
   '--helper',helper,'--interval-ms','100'],{env,stdio:['ignore','pipe','pipe']});
  proc.stderrText='';proc.stderr.on('data',d=>proc.stderrText+=d);return proc;
 };
 try{
  assert.match(call(env,args(f),2),/control socket unavailable/);
  child=start();await ready(f,child);
  assert.equal(call(env,['job','create','--db',db,'--id',f.id,'--repo','recover-test',
   '--title','Live Task recovery','--objective','Exact original recovery',
   '--project-root',root,'--no-review']).created,true);
  await stop(child);child=null;
  assert.equal(existsSync(f.socket),false,'old daemon must remove control socket');
  const j=read(db,f.id);
  j.state='ACTIVE';
  j.tasks=[
   {id:f.original,jobId:f.id,title:'original',kind:'work',state:'FAILED',dependencies:[],
    attempt:3,maxAttempts:3,error:'failure',failureReason:'provider_failure',
    leaseOwner:null,leaseExpiresAt:null,executionId:null},
   {id:f.recovery,jobId:f.id,title:'recovery',kind:'work',state:'RUNNING',dependencies:[],
    agentName:'troubleshooter',parentTaskId:f.original,attempt:1,maxAttempts:3,
    executionId:'live-recovery-exec',leaseOwner:'worker',leaseExpiresAt:'2099-01-01T00:00:00Z'}
  ];
  save(db,j);
  child=start();await ready(f,child);
  const rec=call(env,args(f,['--failure-kind','model_failure','--reason','test live']));
  assert.equal(rec.state,'QUEUED');
  assert.equal(rec.resolution.recoveryExecutionId,'live-recovery-exec');
  await stop(child);child=null;
  child=start();await ready(f,child);
  const persisted=read(db,f.id).tasks.find(t=>t.id===f.original);
  assert.equal(persisted.resolution.recoveryExecutionId,'live-recovery-exec');
  assert.equal(call(env,args(f),2).includes('FAILED'),true);
 }finally{if(child)await stop(child);rmSync(home,{recursive:true,force:true});}
});
