import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';

const bin=process.env.CARGO_TARGET_DIR??resolve(import.meta.dirname,'../target');
const cli=join(bin,'debug/relay-native-job');
const daemon=join(bin,'debug/relay-native-daemon');
const helper=join(bin,'debug/relay-worker-helper');
const isolated={...process.env,RELAY_RUST_EXPERIMENTAL_TEST_ONLY:'isolated-test',RELAY_RUST_LIVE_MODE:''};
function invoke(env,args,status=0){
 const p=spawnSync(cli,args,{env,encoding:'utf8',timeout:12000});
 assert.equal(p.status,status,p.stderr||p.stdout);
 return status===0?JSON.parse(p.stdout):p.stderr;
}
function load(db,id){
 const sql=new DatabaseSync(db);
 try{return JSON.parse(sql.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get(id).json);}
 finally{sql.close();}
}
function store(db,job){
 const sql=new DatabaseSync(db);
 try{sql.prepare('UPDATE job_snapshot SET json=? WHERE job_id=?').run(JSON.stringify(job),job.id);}
 finally{sql.close();}
}
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'relay-rust-authority-supersede-'));
 mkdirSync(join(root,'project'));
 writeFileSync(join(root,'.relay-rust-authority-isolated-test'),'isolated-test');
 const db=join(root,'relay.sqlite'),id='76',repo='supersede-repo';
 invoke(isolated,['init','--db',db]);
 invoke(isolated,['job','create','--db',db,'--id',id,'--repo',repo,
  '--objective','Preserve cancelled Task evidence','--project-root',join(root,'project'),'--no-review']);
 const make=name=>invoke(isolated,['task','create','--db',db,'--id',id,'--repo',repo,
  '--title',name,'--input',name,'--output','file','--output-path',join(root,'project',name+'.txt')]).taskId;
 const f={root,db,id,repo,taskId:make('original'),otherId:make('other')};
 const job=load(db,id),task=job.tasks.find(t=>t.id===f.taskId);
 task.state='CANCELLED';task.error='Cancelled by worker';
 task.leaseOwner=null;task.leaseExpiresAt=null;task.executionId=null;
 store(db,job);
 return f;
}
const command=(f,extra=[])=>['task','supersede','--db',f.db,'--id',f.id,
 '--repo',f.repo,'--task-id',f.taskId,'--reason','  Obsolete after corrected work  ',...extra];

test('Task supersede records Graph-approved CANCELLED Task evidence without changing state or other Tasks',()=>{
 const f=fixture();
 try{
  const before=load(f.db,f.id),original=before.tasks.find(t=>t.id===f.taskId);
  const result=invoke(isolated,command(f));
  assert.equal(result.id,f.taskId);
  assert.equal(result.state,'CANCELLED');
  assert.equal(result.error,'Superseded Obsolete after corrected work');
  assert.equal(result.resolution.path,'cancel_supersede');
  assert.equal(result.resolution.targetTaskId,f.taskId);
  assert.equal(result.resolution.rootCause,'Obsolete after corrected work');
  assert.equal(result.resolution.solution,'Superseded by later corrected durable work');
  assert.equal(result.resolution.owner,'external');
  assert.equal(result.resolution.state,'resolved');
  const after=load(f.db,f.id);
  assert.deepEqual(after.tasks.find(t=>t.id===f.otherId),
   before.tasks.find(t=>t.id===f.otherId),'other Task cannot be modified');
  assert.equal(after.tasks.length,before.tasks.length);
  assert.deepEqual({...result,resolution:undefined,error:undefined,updatedAt:undefined},
   {...original,resolution:undefined,error:undefined,updatedAt:undefined},
   'Task lifecycle and its execution identity remain intact');
  assert.deepEqual(after.tasks.find(t=>t.id===f.taskId),result);
  assert.match(invoke(isolated,command(f),2),/already superseded/);
  assert.deepEqual(load(f.db,f.id),after,'duplicate Task supersede cannot overwrite original evidence');
 }finally{rmSync(f.root,{recursive:true,force:true});}
});

test('Task supersede rejects unsafe states, active leases, changed identity and invalid reasons with no DB writes',()=>{
 const f=fixture();
 try{
  const rejects=[
   [command(f,['--unknown','value']),/unrecognized task/],
   [command(f,['--reason','other']),/duplicate option/],
   [command(f).map((x,i,a)=>a[i-1]==='--reason'?'  ':x),/requires --reason/],
   [command(f).map((x,i,a)=>a[i-1]==='--reason'?'x'.repeat(4097):x),/at most 4096/],
   [command(f).map((x,i,a)=>a[i-1]==='--repo'?'spoof':x),/repository identity mismatch/],
   [command(f).map((x,i,a)=>a[i-1]==='--id'?'unknown':x),/unknown Job/],
   [command(f).map((x,i,a)=>a[i-1]==='--task-id'?'unknown':x),/Task to supersede not found/],
  ];
  let original=JSON.stringify(load(f.db,f.id));
  for(const [args,expected] of rejects){
   assert.match(invoke(isolated,args,2),expected);
   assert.equal(JSON.stringify(load(f.db,f.id)),original,args.join(' '));
  }
  const modifications=[
   t=>t.state='FAILED',
   t=>t.state='QUEUED',
   t=>t.kind='planner',
   t=>t.leaseOwner='worker',
   t=>t.leaseExpiresAt='2099-01-01T00:00:00Z',
   t=>t.executionId='stale-execution',
   t=>t.resolution={state:'waiting',path:'escalation_gate'},
   t=>t.resolution={state:'active',path:'exact_original_retry'},
   t=>t.resolution={state:'resolved',path:'cancel_supersede',rootCause:'previous'},
  ];
  for(const modify of modifications){
   store(f.db,JSON.parse(original));
   const job=load(f.db,f.id);modify(job.tasks.find(t=>t.id===f.taskId));store(f.db,job);
   const before=JSON.stringify(load(f.db,f.id));
   assert.equal(invoke(isolated,command(f),2).startsWith('relay-native-job:'),true);
   assert.equal(JSON.stringify(load(f.db,f.id)),before,'unsafe state modification must not commit');
  }
 }finally{rmSync(f.root,{recursive:true,force:true});}
});

test('Live Task supersede delegates only to daemon socket and persists after daemon restart',async()=>{
 const home=mkdtempSync('/tmp/rr-sup-');
 const root=join(home,'.local/state/agents-relay/rust-live');
 mkdirSync(root,{recursive:true,mode:0o700});chmodSync(root,0o700);
 writeFileSync(join(root,'.relay-rust-live-namespace-v1'),'rust-relay-owned-standalone-namespace-v1\n',{mode:0o600});
 writeFileSync(join(root,'manifest.json'),JSON.stringify({agents:{}}));
 const db=join(root,'relay.sqlite');
 const sql=new DatabaseSync(db);
 sql.exec('PRAGMA journal_mode=WAL; CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL); CREATE TABLE relay_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE agent_snapshot(agent_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL);');
 sql.close();chmodSync(db,0o600);
 const env={...process.env,HOME:home,RELAY_RUST_LIVE_MODE:'pilot-live',RELAY_RUST_EXPERIMENTAL_TEST_ONLY:''};
 const f={root,db,id:'77',repo:'supersede-repo',taskId:'cancelled-task',socket:join(root,'.rc.sock')};
 let child=null;
 function start(){
  const proc=spawn(daemon,['--loop','--db',db,'--manifest',join(root,'manifest.json'),
   '--helper',helper,'--interval-ms','100'],{env,stdio:['ignore','pipe','pipe']});
  proc.stderrText='';proc.stderr.on('data',d=>proc.stderrText+=d);return proc;
 }
 async function ready(){
  for(let i=0;i<100;i++){
   if(existsSync(f.socket))return;
   if(child.exitCode!==null)throw Error('Native daemon exited: '+child.stderrText);
   await delay(20);
  }
  throw Error('Daemon socket not ready');
 }
 async function stop(){
  if(!child||child.exitCode!==null)return;
  child.kill('SIGTERM');
  await Promise.race([new Promise(ok=>child.once('exit',ok)),delay(3000)]);
  if(child.exitCode===null){child.kill('SIGKILL');await new Promise(ok=>child.once('exit',ok));}
 }
 try{
  assert.match(invoke(env,command(f),2),/control socket unavailable/);
  child=start();await ready();
  assert.equal(invoke(env,['job','create','--db',db,'--id',f.id,'--repo',f.repo,
   '--title','Live supersede','--objective','Persist evidence','--project-root',root,'--no-review']).created,true);
  await stop();child=null;
  const job=load(db,f.id);
  job.tasks=[{id:f.taskId,jobId:f.id,title:'cancelled',kind:'work',
   state:'CANCELLED',dependencies:[],error:'previous cancellation',
   leaseOwner:null,leaseExpiresAt:null,executionId:null}];
  store(db,job);
  child=start();await ready();
  const result=invoke(env,command(f));
  assert.equal(result.state,'CANCELLED');
  assert.equal(result.resolution.path,'cancel_supersede');
  assert.equal(result.resolution.rootCause,'Obsolete after corrected work');
  await stop();child=null;
  child=start();await ready();
  assert.equal(load(db,f.id).tasks[0].resolution.rootCause,'Obsolete after corrected work');
  assert.match(invoke(env,command(f),2),/already superseded/);
 }finally{await stop();rmSync(home,{recursive:true,force:true});}
});
