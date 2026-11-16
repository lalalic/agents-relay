import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';

const cli=resolve(process.env.CARGO_TARGET_DIR ?? resolve(import.meta.dirname,'../target'), 'debug/relay-native-job');
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'relay-rust-authority-task-mutation-'));
 mkdirSync(join(root,'project/output'),{recursive:true});writeFileSync(join(root,'.relay-rust-authority-isolated-test'),'test-only');
 const db=join(root,'relay.sqlite'),env={...process.env,AGENTS_RELAY_STORE_DIR:join(root,'node-store'),RELAY_RUST_EXPERIMENTAL_TEST_ONLY:'isolated-test'};
 mkdirSync(env.AGENTS_RELAY_STORE_DIR);const call=(args,expected=0)=>{const r=spawnSync(cli,args,{env,encoding:'utf8',timeout:12000});assert.equal(r.status,expected,r.stderr||r.stdout);return expected?`${r.stderr}${r.stdout}`:JSON.parse(r.stdout.trim())};
 const input=join(root,'project/input.md'),graph=join(root,'project/graph.mmd'),output=join(root,'project/output/dag.json');writeFileSync(input,'Coordinator input');writeFileSync(graph,'flowchart TD\nbuilder[agent:builder]\n');
 call(['init','--db',db]);const job=call(['create','--db',db,'--project-root',join(root,'project'),'--graph-file',graph,'--input-file',input,'--output-path',output,'--title','Task mutation fixture','--repository','agents-relay','--request-key','root-job']);
 return {root,db,env,call,jobId:job.jobId,coordinatorId:job.coordinatorTaskId};
}
function close(f){rmSync(f.root,{recursive:true,force:true})}
function create(f,extra=[]){return f.call(['task','create','--db',f.db,'--id',f.jobId,'--repo','agents-relay','--input','durable task input','--output','file','--output-path',join(f.root,'project/output/task.md'),...extra])}
function snapshot(f){const db=new DatabaseSync(f.db);try{return JSON.parse(db.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get(f.jobId).json)}finally{db.close()}}
function patchTask(f,id,patch){const db=new DatabaseSync(f.db);try{const j=snapshot(f),t=j.tasks.find(x=>x.id===id);Object.assign(t,patch);db.prepare('UPDATE job_snapshot SET json=? WHERE job_id=?').run(JSON.stringify(j),f.jobId)}finally{db.close()}}

test('native task identity aliases and repository binding are checked before mutation',()=>{
 const f=fixture();try{const before=snapshot(f);assert.match(f.call(['task','create','--db',f.db,'--id',f.jobId,'--repo','wrong','--input','x','--output','file','--output-path',join(f.root,'project/output/x')],2),/repository identity mismatch/);assert.deepEqual(snapshot(f),before);
  const made=create(f);assert.equal(made.jobId,f.jobId);assert.equal(made.task.id,made.taskId);
  assert.match(f.call(['task','update','--db',f.db,'--id',f.jobId,'--job-id','other','--task-id',made.taskId,'--title','x'],2),/mismatch/);
  assert.match(f.call(['task','update','--db',f.db,'--id',f.jobId,'--task-id',made.taskId,'--title','x','--surprise','no'],2),/unrecognized task update option/);
 }finally{close(f)}
});

test('Task update validates first, commits supported metadata, and is durable across CLI restarts',()=>{
 const f=fixture();try{const made=create(f),before=snapshot(f);assert.match(f.call(['task','update','--db',f.db,'--id',f.jobId,'--task-id',made.taskId,'--priority','P9'],2),/priority/);assert.deepEqual(snapshot(f),before);
  const updated=f.call(['task','update','--db',f.db,'--id',f.jobId,'--repo','agents-relay','--task-id',made.taskId,'--title','Updated native task','--priority','P1','--story-size','L']);assert.equal(updated.task.title,'Updated native task');assert.equal(updated.task.priority,'P1');assert.equal(updated.task.storySize,'L');
  const reread=f.call(['task','show','--db',f.db,'--id',f.jobId,'--repo','agents-relay','--task-id',made.taskId]);assert.equal(reread.title,'Updated native task');assert.equal(reread.priority,'P1');
 }finally{close(f)}
});

test('native cancel rejects stuck leases and invalid transitions without changing the snapshot',()=>{
 const f=fixture();try{const made=create(f);patchTask(f,made.taskId,{state:'RUNNING',executionId:'exec-stuck',leaseOwner:'worker',leaseExpiresAt:'2000-01-01T00:00:00Z'});const before=snapshot(f);
  assert.match(f.call(['task','cancel','--db',f.db,'--id',f.jobId,'--task-id',made.taskId,'--reason','stop'],2),/unleased DRAFT or QUEUED/);assert.deepEqual(snapshot(f),before);
  assert.match(f.call(['task','retry','--db',f.db,'--id',f.jobId,'--task-id',made.taskId],2),/inactive FAILED Task/);assert.deepEqual(snapshot(f),before);
 }finally{close(f)}
});

test('unblock requires effective Troubleshooter ownership and follows Task Lifecycle Graph',()=>{
 const f=fixture();try{const made=create(f);patchTask(f,made.taskId,{state:'BLOCKED',agentName:'troubleshooter',kind:'work',error:'blocked',attempt:2,maxAttempts:2});
  const result=f.call(['task','unblock','--db',f.db,'--id',f.jobId,'--repo','agents-relay','--task-id',made.taskId,'--reason','verified resolution']);
  assert.equal(result.task.state,'QUEUED');assert.equal(result.task.attempt,0);assert.equal(result.task.maxAttempts,3);assert.equal(result.task.error,null);assert.equal(result.task.unblock.reason,'verified resolution');
 }finally{close(f)}
});

test('retry extends the bounded attempt window, clears stale route and remains durable',()=>{
 const f=fixture();try{const made=create(f);patchTask(f,made.taskId,{state:'FAILED',attempt:3,maxAttempts:3,error:'failed',failureReason:'script_error',routing:{provider:'old'},workerSelection:{workerId:'old'}});
  const retried=f.call(['task','retry','--db',f.db,'--id',f.jobId,'--repo','agents-relay','--task-id',made.taskId]);assert.equal(retried.task.state,'QUEUED');assert.equal(retried.task.maxAttempts,6);assert.equal(retried.task.error,null);assert.equal(Object.hasOwn(retried.task,'routing'),false);
  const again=f.call(['task','show','--db',f.db,'--id',f.jobId,'--task-id',made.taskId]);assert.equal(again.state,'QUEUED');assert.equal(again.maxAttempts,6);
 }finally{close(f)}
});

test('Rust live namespace refuses direct Task CLI mutation while daemon owns SQLite',()=>{
 const f=fixture();try{
  const before=snapshot(f);
  const r=spawnSync(cli,['task','create','--db',f.db,'--id',f.jobId,'--repo','agents-relay',
   '--input','x','--output','file','--output-path',join(f.root,'project/output/task.txt')],{
   env:{...f.env,RELAY_RUST_LIVE_MODE:'pilot-live'},encoding:'utf8',timeout:12000});
  assert.equal(r.status,2);assert.match(r.stderr,/daemon-owned control|Rust live namespace refuses production or alias paths/);
  assert.deepEqual(snapshot(f),before);
 }finally{close(f)}
});
test('native CLI rejects human escalation response impersonation and unsupported review mutations',()=>{
 const f=fixture();try{const made=create(f);patchTask(f,made.taskId,{state:'BLOCKED',agentName:'troubleshooter',kind:'work',escalation:{status:'pending'}});const before=snapshot(f);
  assert.match(f.call(['task','unblock','--db',f.db,'--id',f.jobId,'--task-id',made.taskId,'--response','approved'],2),/cannot impersonate an authorized human/);assert.deepEqual(snapshot(f),before);
  assert.match(f.call(['task','classify','--db',f.db,'--id',f.jobId,'--task-id',made.taskId,'--classification','superseded','--target-task-id','999'],2),/task classify requires --repo/);assert.deepEqual(snapshot(f),before);
 }finally{close(f)}
});

test('workflow action routes retry/cancel/unblock through the same Graph-authorized native Task effects',()=>{
 const f=fixture();try{
  const made=create(f);
  const base=['workflow','action','--db',f.db,'--id',f.jobId,'--repo','agents-relay','--task-id',made.taskId];
  patchTask(f,made.taskId,{state:'FAILED',error:'failure',attempt:3,maxAttempts:3,routing:{provider:'old'}});
  const result=f.call([...base,'--action','task.retry']);
  assert.equal(result.task.state,'QUEUED');assert.equal(result.task.maxAttempts,6);
  const cancelled=f.call([...base,'--action','task.cancel','--reason','operator cancel']);
  assert.equal(cancelled.task.state,'CANCELLED');
  const persisted=snapshot(f).tasks.find(t=>t.id===made.taskId);
  assert.equal(persisted.state,'CANCELLED');
  const before=snapshot(f);
  assert.match(f.call([...base,'--action','task.recover','--recovery-task-id','999'],2),/Troubleshooter recovery Task not found/);
  assert.deepEqual(snapshot(f),before,'unsupported recovery must not mutate SQLite');
  assert.match(f.call([...base,'--action','task.retry','--reason','ignored'],2),/refusing to silently ignore/);
  assert.deepEqual(snapshot(f),before);
 }finally{close(f)}
});
test('workflow action live Task writes refuse an unowned second SQLite writer',()=>{
 const f=fixture();try{
  const made=create(f),before=snapshot(f);
  const r=spawnSync(cli,['workflow','action','--db',f.db,'--id',f.jobId,
   '--repo','agents-relay','--task-id',made.taskId,'--action','task.cancel','--reason','stop'],{
    env:{...f.env,RELAY_RUST_LIVE_MODE:'pilot-live'},encoding:'utf8',timeout:12000});
  assert.equal(r.status,2);assert.match(r.stderr,/daemon-owned control|Rust live namespace refuses production or alias paths/);
  assert.deepEqual(snapshot(f),before);
 }finally{close(f)}
});
