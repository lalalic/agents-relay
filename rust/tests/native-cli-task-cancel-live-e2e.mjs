import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';

const target = process.env.CARGO_TARGET_DIR ?? resolve(import.meta.dirname,'../target');
const cli = join(target,'debug/relay-native-job');
const daemon = join(target,'debug/relay-native-daemon');
const helper = join(target,'debug/relay-worker-helper');
const isolated = {...process.env,RELAY_RUST_LIVE_MODE:'',RELAY_RUST_EXPERIMENTAL_TEST_ONLY:'isolated-test'};
const call = (env,args,expected=0)=>{
  const p=spawnSync(cli,args,{env,encoding:'utf8',timeout:12000});
  assert.equal(p.status,expected,p.stderr||p.stdout);
  return expected===0?JSON.parse(p.stdout):p.stderr;
};
function read(db,id) {
  const s=new DatabaseSync(db);
  try { return JSON.parse(s.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get(id).json); }
  finally {s.close();}
}
function write(db,j) {
  const s=new DatabaseSync(db);
  try {s.prepare('UPDATE job_snapshot SET json=? WHERE job_id=?').run(JSON.stringify(j),j.id);}
  finally {s.close();}
}
const cancel=(f,task='draft',reason='operator cancelled')=>
 ['task','cancel','--db',f.db,'--id',f.id,'--repo',f.repo,'--task-id',task,'--reason',reason];

test('native Task cancel uses authoritative Graph, persists reason and cannot mutate active worker leases',()=>{
  const root=mkdtempSync(join(tmpdir(),'relay-rust-authority-cancel-'));
  try {
    mkdirSync(join(root,'project'));
    writeFileSync(join(root,'.relay-rust-authority-isolated-test'),'isolated-test');
    const f={root,db:join(root,'relay.sqlite'),id:'41',repo:'cancel-repo'};
    call(isolated,['init','--db',f.db]);
    call(isolated,['job','create','--db',f.db,'--id',f.id,'--repo',f.repo,
      '--objective','Cancel dependency gated Task','--project-root',join(root,'project'),'--no-review']);
    const original=read(f.db,f.id);
    original.state='ACTIVE';
    original.tasks=[
      {id:'draft',jobId:f.id,title:'Draft Task',kind:'work',state:'DRAFT',
        dependencies:[],attempt:0,maxAttempts:3,leaseOwner:null,leaseExpiresAt:null,
        executionId:null,error:null},
      {id:'active',jobId:f.id,title:'Running Task',kind:'work',state:'RUNNING',
        dependencies:[],attempt:1,maxAttempts:3,leaseOwner:'worker',leaseExpiresAt:'2099-01-01T00:00:00Z',
        executionId:'exec-current',error:null},
    ];
    write(f.db,original);
    const before=read(f.db,f.id);
    const rejected=call(isolated,cancel(f,'active'),2);
    assert.match(rejected,/unleased DRAFT or QUEUED/);
    assert.deepEqual(read(f.db,f.id),before,'active lease cancellation must not change SQLite');
    const valid=call(isolated,cancel(f,'draft','Operator closed unused Task'));
    assert.equal(valid.jobId,f.id);
    assert.equal(valid.taskId,'draft');
    assert.equal(valid.task.state,'CANCELLED');
    assert.equal(valid.task.error,'Operator closed unused Task');
    assert.equal(valid.task.executionId,null);
    const after=read(f.db,f.id);
    assert.equal(after.tasks[1].state,'RUNNING');
    assert.equal(after.tasks[1].executionId,'exec-current');
    assert.equal(after.tasks[1].leaseOwner,'worker');
    assert.deepEqual(after.tasks[0],valid.task);
    assert.match(call(isolated,cancel(f,'draft'),2),/unleased DRAFT or QUEUED/);
    assert.deepEqual(read(f.db,f.id),after,'duplicate cancel must not change snapshot');
    const bad=[
      [cancel(f,'draft','   '),/requires nonempty --reason/],
      [cancel(f,'draft','a'.repeat(2049)),/at most 2048 bytes/],
      [cancel(f,'missing'),/Unknown Task/],
      [cancel(f).map((x,i,a)=>a[i-1]==='--repo'?'forged':x),/repository identity mismatch/],
      [[...cancel(f),'--priority','P0'],/unrecognized/],
    ];
    for(const [a,rx] of bad){
      assert.match(call(isolated,a,2),rx);
      assert.deepEqual(read(f.db,f.id),after);
    }
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('isolated task retry extends bounded attempt budget, rejects active lease and keeps Graph identity',()=>{
  const root=mkdtempSync(join(tmpdir(),'relay-rust-authority-retry-'));
  try {
    mkdirSync(join(root,'project'));
    writeFileSync(join(root,'.relay-rust-authority-isolated-test'),'isolated-test');
    const f={root,db:join(root,'relay.sqlite'),id:'45',repo:'retry-repo'};
    call(isolated,['init','--db',f.db]);
    call(isolated,['job','create','--db',f.db,'--id',f.id,'--repo',f.repo,
      '--objective','Retry failed Task using Graph','--project-root',join(root,'project'),'--no-review']);
    const j=read(f.db,f.id);j.state='ACTIVE';
    j.tasks=[{id:'failed',jobId:f.id,title:'failed Task',kind:'work',state:'FAILED',
      dependencies:[],attempt:3,maxAttempts:3,error:'provider failure',
      failureReason:'provider_failure',routing:{provider:'old',model:'broken'},
      workerSelection:{worker:'old'},executionId:null,leaseOwner:null,leaseExpiresAt:null}];
    write(f.db,j);
    const cmd=['task','retry','--db',f.db,'--id',f.id,'--repo',f.repo,'--task-id','failed'];
    const rejected=read(f.db,f.id);
    rejected.tasks[0].executionId='still-running';
    write(f.db,rejected);
    const locked=read(f.db,f.id);
    assert.match(call(isolated,cmd,2),/inactive FAILED Task without recovery ownership/);
    assert.deepEqual(read(f.db,f.id),locked,'leased failed Task must be immutable');
    write(f.db,j);
    const retried=call(isolated,cmd);
    assert.equal(retried.task.state,'QUEUED');
    assert.equal(retried.task.maxAttempts,6);
    assert.equal(retried.task.attempt,3);
    assert.equal(retried.task.error,null);
    assert.equal(retried.task.failureReason,undefined);
    assert.equal(retried.task.routing,undefined);
    assert.equal(retried.task.workerSelection,undefined);
    assert.equal(retried.taskId,'failed');
    const after=read(f.db,f.id);
    assert.match(call(isolated,cmd,2),/inactive FAILED Task without recovery ownership/);
    assert.deepEqual(read(f.db,f.id),after,'duplicate retry must not change Task');
    assert.match(call(isolated,[...cmd,'--reason','ignored'],2),/unrecognized task retry option/);
    assert.deepEqual(read(f.db,f.id),after);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('live task retry uses daemon socket and workflow action and persists a failed Task generation',async()=>{
  const home=mkdtempSync('/tmp/rr-rtl-');
  const root=join(home,'.local/state/agents-relay/rust-live');
  mkdirSync(root,{recursive:true,mode:0o700});chmodSync(root,0o700);
  writeFileSync(join(root,'.relay-rust-live-namespace-v1'),'rust-relay-owned-standalone-namespace-v1\n',{mode:0o600});
  writeFileSync(join(root,'manifest.json'),JSON.stringify({agents:{}}));
  const db=join(root,'relay.sqlite'),id='46',repo='retry-repo';
  const sql=new DatabaseSync(db);
  sql.exec('PRAGMA journal_mode=WAL; CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL); CREATE TABLE relay_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE agent_snapshot(agent_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL);');
  sql.close();chmodSync(db,0o600);
  const env={...process.env,HOME:home,RELAY_RUST_LIVE_MODE:'pilot-live',RELAY_RUST_EXPERIMENTAL_TEST_ONLY:''};
  const sock=join(root,'.rc.sock');
  let child;
  function start(){
    const p=spawn(daemon,['--loop','--db',db,'--manifest',join(root,'manifest.json'),
      '--helper',helper,'--interval-ms','5000'],{env,stdio:['ignore','pipe','pipe']});
    p.err='';p.stderr.on('data',d=>p.err+=d);return p;
  }
  async function ready(){
    for(let i=0;i<110;i++){
      if(existsSync(sock))return;
      if(child.exitCode!==null)throw Error('daemon exited: '+child.err);
      await delay(20);
    }
    throw Error('daemon socket not ready: '+child.err);
  }
  async function stop(){
    if(!child||child.exitCode!==null)return;
    child.kill('SIGTERM');
    await Promise.race([new Promise(ok=>child.once('exit',ok)),delay(3000)]);
    if(child.exitCode===null){child.kill('SIGKILL');await new Promise(ok=>child.once('exit',ok));}
  }
  const args=['task','retry','--db',db,'--id',id,'--repo',repo,'--task-id','failed'];
  try{
    assert.match(call(env,args,2),/control socket unavailable/);
    child=start();await ready();
    assert.equal(call(env,['job','create','--db',db,'--id',id,'--repo',repo,
      '--objective','Retry live failed Task','--project-root',root,'--no-review']).created,true);
    await stop();child=null;
    const j=read(db,id);j.state='ACTIVE';
    j.tasks=[{id:'failed',jobId:id,title:'Failed Worker',kind:'work',state:'FAILED',
      dependencies:[],attempt:3,maxAttempts:3,executionId:null,leaseOwner:null,leaseExpiresAt:null,
      error:'provider unavailable',failureReason:'adapter_failure',
      routing:{provider:'old'},workerSelection:{worker:'old'}}];
    write(db,j);
    child=start();await ready();
    const alias=['workflow','action','--action','task.retry','--db',db,
      '--id',id,'--repo',repo,'--task-id','failed'];
    const output=call(env,alias);
    assert.equal(output.task.state,'QUEUED');
    assert.equal(output.task.maxAttempts,6);
    assert.equal(output.task.routing,undefined);
    const after=read(db,id);
    assert.equal(after.tasks[0].state,'QUEUED');
    assert.match(call(env,args,2),/inactive FAILED Task without recovery ownership/);
    assert.deepEqual(read(db,id),after);
    assert.match(call(env,args.map((v,i,a)=>a[i-1]==='--repo'?'forged':v),2),/repository identity mismatch/);
    assert.deepEqual(read(db,id),after);
    await stop();child=null;
    const durable=read(db,id);
    assert.equal(durable.tasks[0].state,'QUEUED');
    assert.equal(durable.tasks[0].maxAttempts,6);
  }finally{if(child)await stop();rmSync(home,{recursive:true,force:true});}
});

test('production-mode task cancel uses only Daemon Unix socket and workflow alias, survives daemon restart',async()=>{
  const home=mkdtempSync('/tmp/rr-cnl-');
  const root=join(home,'.local/state/agents-relay/rust-live');
  mkdirSync(root,{recursive:true,mode:0o700});chmodSync(root,0o700);
  writeFileSync(join(root,'.relay-rust-live-namespace-v1'),'rust-relay-owned-standalone-namespace-v1\n',{mode:0o600});
  writeFileSync(join(root,'manifest.json'),JSON.stringify({agents:{}}));
  const db=join(root,'relay.sqlite');
  const sql=new DatabaseSync(db);
  sql.exec('PRAGMA journal_mode=WAL; CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL); CREATE TABLE relay_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE agent_snapshot(agent_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL);');
  sql.close();chmodSync(db,0o600);
  const env={...process.env,HOME:home,RELAY_RUST_LIVE_MODE:'pilot-live',RELAY_RUST_EXPERIMENTAL_TEST_ONLY:''};
  const f={root,db,id:'42',repo:'cancel-repo',socket:join(root,'.rc.sock')};
  let child=null;
  function start(){
    const p=spawn(daemon,['--loop','--db',db,'--manifest',join(root,'manifest.json'),
      '--helper',helper,'--interval-ms','100'],{env,stdio:['ignore','pipe','pipe']});
    p.err='';p.stderr.on('data',d=>p.err+=d);return p;
  }
  async function ready(){
    for(let i=0;i<100;i++){
      if(existsSync(f.socket))return;
      if(child.exitCode!==null)throw Error('daemon exited: '+child.err);
      await delay(20);
    }
    throw Error('daemon socket unavailable: '+child.err);
  }
  async function stop(){
    if(!child||child.exitCode!==null)return;
    child.kill('SIGTERM');
    await Promise.race([new Promise(ok=>child.once('exit',ok)),delay(3000)]);
    if(child.exitCode===null){child.kill('SIGKILL');await new Promise(ok=>child.once('exit',ok));}
  }
  try{
    assert.match(call(env,cancel(f),2),/control socket unavailable/);
    child=start();await ready();
    assert.equal(call(env,['job','create','--db',db,'--id',f.id,'--repo',f.repo,
      '--title','Live cancel','--objective','Cancel unused Task',
      '--project-root',root,'--no-review']).created,true);
    await stop();child=null;
    const j=read(db,f.id);
    j.state='ACTIVE';
    j.tasks=[
      {id:'draft',jobId:f.id,title:'Safe unused draft',kind:'work',state:'DRAFT',
        dependencies:[],leaseOwner:null,leaseExpiresAt:null,executionId:null},
      {id:'draft2',jobId:f.id,title:'Another unused draft',kind:'work',state:'DRAFT',
        dependencies:[],leaseOwner:null,leaseExpiresAt:null,executionId:null}
    ];
    write(db,j);
    child=start();await ready();
    const first=call(env,cancel(f,'draft','live operator cancellation'));
    assert.equal(first.task.state,'CANCELLED');
    assert.equal(first.task.error,'live operator cancellation');
    const alias=['workflow','action','--action','task.cancel','--db',f.db,
      '--id',f.id,'--repo',f.repo,'--task-id','draft2','--reason','Graph alias cancellation'];
    const second=call(env,alias);
    assert.equal(second.task.state,'CANCELLED');
    assert.equal(second.task.error,'Graph alias cancellation');
    const after=read(db,f.id);
    assert.equal(after.tasks.length,2);
    assert.deepEqual(after.tasks.map(t=>t.state),['CANCELLED','CANCELLED']);
    const forged=call(env,cancel(f,'draft','bad').map((x,i,a)=>a[i-1]==='--repo'?'wrong':x),2);
    assert.match(forged,/repository identity mismatch/);
    assert.deepEqual(read(db,f.id),after);
    await stop();child=null;
    child=start();await ready();
    assert.deepEqual(read(db,f.id),after,'both cancellations survived fresh daemon');
    assert.match(call(env,cancel(f),2),/unleased DRAFT or QUEUED/);
    assert.deepEqual(read(db,f.id),after);
  }finally{await stop();rmSync(home,{recursive:true,force:true});}
});
