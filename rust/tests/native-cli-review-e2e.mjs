import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';

const target=process.env.CARGO_TARGET_DIR??resolve(import.meta.dirname,'../target');
const cli=join(target,'debug/relay-native-job');
const env={...process.env,RELAY_RUST_EXPERIMENTAL_TEST_ONLY:'isolated-test'};
function call(args,exit=0){
 const result=spawnSync(cli,args,{env,encoding:'utf8',timeout:10000});
 assert.equal(result.status,exit,result.stderr||result.stdout);
 return exit===0?JSON.parse(result.stdout.trim()):result.stderr;
}
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'relay-rust-authority-review-cli-'));
 const project=join(root,'project');mkdirSync(join(project,'output'),{recursive:true});
 const db=join(root,'relay.sqlite'),graph=join(project,'graph.mmd'),input=join(project,'input.md');
 const output=join(project,'output','artifact.json');
 writeFileSync(join(root,'.relay-rust-authority-isolated-test'),'isolated-test');
 writeFileSync(graph,'flowchart TD\nbuilder[agent:builder]\n');writeFileSync(input,'review fixture');
 call(['init','--db',db]);
 const created=call(['create','--db',db,'--project-root',project,'--graph-file',graph,
  '--input-file',input,'--output-path',output,'--title','Review CLI fixture',
  '--repository','review-fixture','--request-key','review-cli']);
 call(['activate','--db',db,'--job-id',created.jobId]);
 const sql=new DatabaseSync(db);
 try{
  const row=sql.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get(created.jobId);
  const job=JSON.parse(row.json);job.state='ACTIVE';job.updatedAt='2026-11-14T12:00:00.000Z';
  const task=job.tasks.find(t=>t.kind!=='coordinator')??job.tasks[0];
  task.state='RUNNING';task.executionId='exec-current';task.updatedAt=job.updatedAt;
  sql.prepare('UPDATE job_snapshot SET json=? WHERE job_id=?').run(JSON.stringify(job),created.jobId);
  return {root,db,jobId:created.jobId,taskId:task.id};
 }finally{sql.close();}
}
function seedAwaitingInvocation(f){
 const sql=new DatabaseSync(f.db);
 try{
  const row=sql.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get(f.jobId);
  const job=JSON.parse(row.json),task=job.tasks.find(t=>t.id===f.taskId);
  task.state='AWAITING_DECISION';
  task.interactiveInvocation={invocationId:'inv-current',executionId:'exec-current',revision:'sha256:fixture',status:'awaiting_decision'};
  sql.prepare('UPDATE job_snapshot SET json=? WHERE job_id=?').run(JSON.stringify(job),f.jobId);
 }finally{sql.close();}
}
const interactive=(f,action,execution='exec-current',extra=[])=>[
 'review','interactive',action,'--db',f.db,'--id',f.jobId,'--task-id',f.taskId,
 '--execution-id',execution,...extra];

test('Native interactive review rejects unauthenticated begin and never manufactures approval',()=>{
 const f=fixture();try{
  assert.match(call(interactive(f,'begin'),2),/UNSUPPORTED: begin requires an authenticated host invocation/);
  assert.match(call(interactive(f,'begin','exec-stale'),2),/UNSUPPORTED: begin requires an authenticated host invocation/);
  assert.match(call(interactive(f,'ready'),2),/UNSUPPORTED: ready requires a verified, authenticated host decision receipt/);
  assert.match(call(interactive(f,'ready','exec-current',['--decision','approved']),2),/unrecognized option --decision/);
  assert.match(call(interactive(f,'wait'),2),/UNSUPPORTED: wait transition/);
  const sql=new DatabaseSync(f.db);
  try{
   const job=JSON.parse(sql.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get(f.jobId).json);
   const task=job.tasks.find(t=>t.id===f.taskId);
   assert.equal(task.state,'RUNNING');assert.equal(task.executionId,'exec-current');
   assert.equal(task.interactiveInvocation,undefined,'unauthenticated begin created no invocation');
   assert.equal(task.result,null,'no approval or synthetic completion');
  }finally{sql.close();}
  const aborted=call(interactive(f,'abort'));
  assert.equal(aborted.aborted,false);
  assert.match(call(interactive(f,'ready'),2),/UNSUPPORTED: ready requires/);
 }finally{rmSync(f.root,{recursive:true,force:true});}
});

test('Native review wait replay is execution-bound; forged and missing approval fail closed',()=>{
 const f=fixture();try{
  seedAwaitingInvocation(f);
  const firstWait=call(interactive(f,'wait'));
  const replayWait=call(interactive(f,'wait'));
  assert.equal(firstWait.waiting,true);assert.equal(replayWait.waiting,true);
  assert.match(call(interactive(f,'wait','old-execution'),2),/UNSUPPORTED: wait transition/);
  const forged=interactive(f,'ready','exec-current',['--receipt','{"decision":"approved"}']);
  assert.match(call(forged,2),/unrecognized option --receipt/);
  assert.match(call(interactive(f,'ready','old-execution'),2),/UNSUPPORTED: ready requires/);
  assert.match(call(['review','run','--db',f.db,'--id',f.jobId],2),/UNSUPPORTED: review run/);
  const snapshot=call(['review','job','--db',f.db,'--id',f.jobId]);
  assert.equal(snapshot.jobId,f.jobId);assert.equal(snapshot.status,'observed');
 }finally{rmSync(f.root,{recursive:true,force:true});}
});

test('Blocker and projection paths explicitly reject unsupported unsafe effects',()=>{
 const f=fixture();try{
  for(const args of [
   ['blocker','ensure','--db',f.db,'--id',f.jobId],
   ['blocker','add','--db',f.db,'--id',f.jobId],
   ['blocker','resolve','--db',f.db,'--id',f.jobId],
   ['projection','conflicts','--db',f.db,'--id',f.jobId],
   ['projection','resolve','--db',f.db,'--id',f.jobId,'--projection-id','1','--action','requeue'],
  ]) assert.match(call(args,2),/UNSUPPORTED:/);
  assert.equal(call(['blocker','show','--db',f.db,'--id',f.jobId]).job.id,f.jobId);
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
