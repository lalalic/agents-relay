import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';

const exe=resolve(import.meta.dirname,'../target/debug/relay-native-job');
const env={...process.env,RELAY_RUST_EXPERIMENTAL_TEST_ONLY:'isolated-test'};
const invoke=(root,db,...args)=>spawnSync(exe,['job',...args,'--db',db],{encoding:'utf8',env:{...env,AGENTS_RELAY_STORE_DIR:root}});
const call=(root,db,...args)=>{const r=invoke(root,db,...args);assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout)};
function fixture(){const root=mkdtempSync(join(tmpdir(),'relay-rust-authority-job-cli-'));writeFileSync(join(root,'.relay-rust-authority-isolated-test'),'isolated-test');return {root,db:join(root,'relay.sqlite')};}
function putJob(db,job){const sql=new DatabaseSync(db);try{sql.exec('CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL)');sql.prepare('INSERT INTO job_snapshot(job_id,json,updated_at) VALUES(?,?,?)').run(job.id,JSON.stringify(job),job.updatedAt);}finally{sql.close();}}
test('Node-shaped Job create/update/pause/resume/cancel persist safe transitions in isolated SQLite',async()=>{
 const v=fixture();try{
  const init=spawnSync(exe,['init','--db',v.db],{encoding:'utf8',env:{...env,AGENTS_RELAY_STORE_DIR:v.root}});assert.equal(init.status,0,init.stderr);
  const created=call(v.root,v.db,'create','--repo','sample','--title','Initial','--objective','Objective','--project-root',v.root);
  const id=created.job.id;assert.equal(created.job.state,'DRAFT');
  const update=call(v.root,v.db,'update','--repo','sample','--id',id,'--title','Changed','--priority','P1','--no-review');
  assert.equal(update.job.title,'Changed');assert.equal(update.job.priority,'P1');assert.equal(update.job.reviewEnabled,false);
  const paused=call(v.root,v.db,'pause','--repo','sample','--id',id);assert.ok(paused.job.pause);
  const resumed=call(v.root,v.db,'resume','--repo','sample','--id',id);assert.equal(resumed.job.pause,undefined);
  const sqlBeforeCancel=new DatabaseSync(v.db);try{const saved=JSON.parse(sqlBeforeCancel.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get(id).json);saved.tasks=[{id:'3',jobId:id,state:'QUEUED',attempt:0,maxAttempts:3,executionId:null,leaseOwner:null,leaseExpiresAt:null}];sqlBeforeCancel.prepare('UPDATE job_snapshot SET json=? WHERE job_id=?').run(JSON.stringify(saved),id);}finally{sqlBeforeCancel.close();}
  const cancelled=call(v.root,v.db,'cancel','--repo','sample','--id',id);assert.equal(cancelled.job.state,'CANCELLED');assert.equal(cancelled.job.tasks[0].state,'CANCELLED');
  const sql=new DatabaseSync(v.db);try{assert.deepEqual(JSON.parse(sql.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get(id).json),cancelled.job);}finally{sql.close();}
  const beforeDuplicate=readFileSync(v.db);const duplicate=invoke(v.root,v.db,'cancel','--repo','sample','--id',id);assert.equal(duplicate.status,2);assert.match(duplicate.stderr,/denied cancellation/);assert.deepEqual(readFileSync(v.db),beforeDuplicate,'terminal duplicate has no second mutation');
 }finally{rmSync(v.root,{recursive:true,force:true});}
});
test('invalid arguments, repository mismatch, unsafe active cancel and unblock leave SQLite unchanged',async()=>{
 const v=fixture();try{
  const job={id:'91',title:'Keep',objective:'Objective',repository:'sample',projectRoot:v.root,state:'ACTIVE',runtimeStatus:'RUNNING',prNumber:0,reviewEnabled:false,autoMerge:false,createdAt:'2026-11-13T16:00:00.000Z',updatedAt:'2026-11-13T16:00:00.000Z',tasks:[{id:'7',state:'RUNNING',attempt:1,maxAttempts:3,executionId:'live-exec',leaseOwner:'daemon',leaseExpiresAt:'2026-11-14T00:00:00.000Z'}],plans:[]};putJob(v.db,job);
  const before=readFileSync(v.db);
  for(const [args,pattern] of [
   [['update','--repo','sample','--id','91','--priority','P9'],/priority/],
   [['pause','--repo','wrong','--id','91'],/binding mismatch/],
   [['cancel','--repo','sample','--id','91'],/active execution/],
   [['unblock','--repo','sample','--id','91','--reason','go'],/incomplete/],
   [['update','--repo','sample','--id','91','--title','A','--title','B'],/duplicate option/],
  ]){const r=invoke(v.root,v.db,...args);assert.equal(r.status,2,r.stderr);assert.match(r.stderr,pattern);assert.deepEqual(readFileSync(v.db),before);}
 }finally{rmSync(v.root,{recursive:true,force:true});}
});
test('pause refuses a daemon-owned running execution without clearing its lease',async()=>{
 const v=fixture();try{
  const job={id:'92',title:'Keep',objective:'Objective',repository:'sample',projectRoot:v.root,state:'ACTIVE',runtimeStatus:'RUNNING',prNumber:0,reviewEnabled:false,autoMerge:false,createdAt:'2026-11-13T16:00:00.000Z',updatedAt:'2026-11-13T16:00:00.000Z',tasks:[{id:'8',state:'RUNNING',attempt:1,maxAttempts:3,executionId:'owned',leaseOwner:'daemon',leaseExpiresAt:'2026-11-14T00:00:00.000Z'}],plans:[]};putJob(v.db,job);
  const before=readFileSync(v.db);const r=invoke(v.root,v.db,'pause','--repo','sample','--id','92');assert.equal(r.status,2,r.stderr);assert.match(r.stderr,/daemon-coordinated/);assert.deepEqual(readFileSync(v.db),before);
 }finally{rmSync(v.root,{recursive:true,force:true});}
});
