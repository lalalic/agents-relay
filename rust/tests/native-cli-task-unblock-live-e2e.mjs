import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';

const target=process.env.CARGO_TARGET_DIR??resolve(import.meta.dirname,'../target');
const cli=join(target,'debug/relay-native-job');
const daemon=join(target,'debug/relay-native-daemon');
const helper=join(target,'debug/relay-worker-helper');
const isolated={...process.env,RELAY_RUST_LIVE_MODE:'',RELAY_RUST_EXPERIMENTAL_TEST_ONLY:'isolated-test'};
function call(env,args,status=0){
 const p=spawnSync(cli,args,{env,encoding:'utf8',timeout:12000});
 assert.equal(p.status,status,p.stderr||p.stdout);
 return status===0?JSON.parse(p.stdout):p.stderr;
}
function read(db,id){
 const sql=new DatabaseSync(db);
 try{return JSON.parse(sql.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get(id).json);}
 finally{sql.close();}
}
function write(db,j){
 const sql=new DatabaseSync(db);
 try{sql.prepare('UPDATE job_snapshot SET json=? WHERE job_id=?').run(JSON.stringify(j),j.id);}
 finally{sql.close();}
}
const unblock=(f,taskId='recovery1',reason='verified blocker cleared')=>
 ['task','unblock','--db',f.db,'--id',f.id,'--repo',f.repo,'--task-id',taskId,'--reason',reason];
function seed(j){
 j.state='ACTIVE';
 j.tasks=[
  {id:'original1',jobId:j.id,title:'original1',kind:'work',agentName:'builder',
    state:'FAILED',dependencies:[],error:'blocked task',executionId:null,leaseOwner:null,leaseExpiresAt:null},
  {id:'recovery1',jobId:j.id,title:'Troubleshoot 1',kind:'work',agentName:'troubleshooter',
    parentTaskId:'original1',state:'BLOCKED',dependencies:[],error:'blocker1',
    failureReason:'external',attempt:2,maxAttempts:2,executionId:null,leaseOwner:null,leaseExpiresAt:null},
  {id:'recovery2',jobId:j.id,title:'Troubleshoot 2',kind:'work',agentName:'troubleshooter',
    parentTaskId:'original1',state:'BLOCKED',dependencies:[],error:'blocker2',
    attempt:2,maxAttempts:2,executionId:null,leaseOwner:null,leaseExpiresAt:null},
  {id:'recoveryPending',jobId:j.id,title:'Human review still pending',kind:'work',agentName:'troubleshooter',
    parentTaskId:'original1',state:'BLOCKED',dependencies:[],error:'requires human',
    escalation:{status:'pending',originalTaskId:'original1'},
    attempt:2,maxAttempts:2,executionId:null,leaseOwner:null,leaseExpiresAt:null},
  {id:'leased',jobId:j.id,title:'Blocked leased',kind:'work',agentName:'troubleshooter',
    parentTaskId:'original1',state:'BLOCKED',dependencies:[],error:'lease still active',
    attempt:2,maxAttempts:2,executionId:'live-exec',leaseOwner:'worker',
    leaseExpiresAt:'2099-01-01T00:00:00Z'},
 ];
 return j;
}

test('isolated task unblock Graph clears only blocked Troubleshooter and refuses human escalation/worker lease',()=>{
 const root=mkdtempSync(join(tmpdir(),'relay-rust-authority-unblock-'));
 try {
  mkdirSync(join(root,'project'));
  writeFileSync(join(root,'.relay-rust-authority-isolated-test'),'isolated-test');
  const f={root,db:join(root,'relay.sqlite'),id:'71',repo:'unblock-repo'};
  call(isolated,['init','--db',f.db]);
  call(isolated,['job','create','--db',f.db,'--id',f.id,'--repo',f.repo,
    '--objective','External blocker resolved','--project-root',join(root,'project'),'--no-review']);
  write(f.db,seed(read(f.db,f.id)));
  const initial=read(f.db,f.id);
  for(const [args,rx] of [
   [unblock(f,'recoveryPending'),/cannot impersonate an authorized human escalation response/],
   [unblock(f,'leased'),/inactive Task without a lease/],
   [unblock(f,'original1'),/effective BLOCKED Troubleshooter/],
   [unblock(f,'missing'),/Task not found/],
   [unblock(f).map((x,i,a)=>a[i-1]==='--repo'?'forged':x),/repository identity mismatch/],
  ]){
   assert.match(call(isolated,args,2),rx);
   assert.deepEqual(read(f.db,f.id),initial);
  }
  const resumed=call(isolated,unblock(f));
  assert.equal(resumed.task.state,'QUEUED');
  assert.equal(resumed.task.attempt,0);
  assert.equal(resumed.task.maxAttempts,3);
  assert.equal(resumed.task.error,null);
  assert.equal(resumed.task.failureReason,undefined);
  assert.equal(resumed.task.unblock.reason,'verified blocker cleared');
  assert.equal(read(f.db,f.id).tasks[3].escalation.status,'pending');
  const after=read(f.db,f.id);
  assert.match(call(isolated,unblock(f),2),/effective BLOCKED Troubleshooter/);
  assert.deepEqual(read(f.db,f.id),after);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('live Task unblock and workflow alias share daemon Graph authority and do not impersonate human response',async()=>{
 const home=mkdtempSync('/tmp/rr-ubl-');
 const root=join(home,'.local/state/agents-relay/rust-live');
 mkdirSync(root,{recursive:true,mode:0o700});chmodSync(root,0o700);
 writeFileSync(join(root,'.relay-rust-live-namespace-v1'),'rust-relay-owned-standalone-namespace-v1\n',{mode:0o600});
 writeFileSync(join(root,'manifest.json'),JSON.stringify({agents:{}}));
 const db=join(root,'relay.sqlite');
 const sql=new DatabaseSync(db);
 sql.exec('PRAGMA journal_mode=WAL; CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL); CREATE TABLE relay_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE agent_snapshot(agent_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL);');
 sql.close();chmodSync(db,0o600);
 const env={...process.env,HOME:home,RELAY_RUST_LIVE_MODE:'pilot-live',RELAY_RUST_EXPERIMENTAL_TEST_ONLY:''};
 const f={db,id:'72',repo:'unblock-repo',socket:join(root,'.rc.sock')};
 let child;
 function start(){
  const proc=spawn(daemon,['--loop','--db',db,'--manifest',join(root,'manifest.json'),
   '--helper',helper,'--interval-ms','5000'],{env,stdio:['ignore','pipe','pipe']});
  proc.err='';proc.stderr.on('data',d=>proc.err+=d);return proc;
 }
 async function ready(){
  for(let i=0;i<110;i++){
   if(existsSync(f.socket))return;
   if(child.exitCode!==null)throw Error('Daemon exited: '+child.err);
   await delay(20);
  }
  throw Error('Daemon socket unavailable');
 }
 async function stop(){
  if(!child||child.exitCode!==null)return;
  child.kill('SIGTERM');
  await Promise.race([new Promise(ok=>child.once('exit',ok)),delay(3000)]);
  if(child.exitCode===null){child.kill('SIGKILL');await new Promise(ok=>child.once('exit',ok));}
 }
 try{
  assert.match(call(env,unblock(f),2),/control socket unavailable/);
  child=start();await ready();
  assert.equal(call(env,['job','create','--db',db,'--id',f.id,'--repo',f.repo,
   '--objective','Unblock external Troubleshooter','--project-root',root,'--no-review']).created,true);
  await stop();child=null;
  write(db,seed(read(db,f.id)));
  child=start();await ready();
  const denied=call(env,['task','unblock','--db',db,'--id',f.id,'--repo',f.repo,
   '--task-id','recoveryPending','--response','please approve'],2);
  assert.match(denied,/cannot consume human --response/);
  const before=read(db,f.id);
  assert.match(call(env,unblock(f,'recoveryPending'),2),/cannot impersonate an authorized human escalation response/);
  assert.match(call(env,unblock(f,'leased'),2),/inactive Task without a lease/);
  assert.deepEqual(read(db,f.id),before);
  const first=call(env,unblock(f));
  assert.equal(first.task.state,'QUEUED');
  assert.equal(first.task.unblock.reason,'verified blocker cleared');
  const alias=['workflow','action','--action','task.unblock','--db',db,'--id',f.id,
   '--repo',f.repo,'--task-id','recovery2','--reason','Graph-owned external clearance'];
  const second=call(env,alias);
  assert.equal(second.task.state,'QUEUED');
  assert.equal(second.task.unblock.reason,'Graph-owned external clearance');
  const result=read(db,f.id);
  assert.deepEqual(result.tasks.slice(1,3).map(t=>t.state),['QUEUED','QUEUED']);
  assert.equal(result.tasks[3].escalation.status,'pending');
  assert.equal(result.tasks[4].leaseOwner,'worker');
  assert.match(call(env,unblock(f),2),/effective BLOCKED Troubleshooter/);
  assert.deepEqual(read(db,f.id),result);
  await stop();child=null;
  // No worker scheduling is allowed to run while inspecting a synthetic test.
  const reloaded=read(db,f.id);
  assert.equal(reloaded.tasks[1].unblock.source,'cli');
  assert.equal(reloaded.tasks[2].unblock.source,'cli');
  assert.equal(reloaded.tasks[3].escalation.status,'pending');
 }finally{if(child)await stop();rmSync(home,{recursive:true,force:true});}
});
