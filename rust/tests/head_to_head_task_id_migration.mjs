// Direct Node/Rust differential E2E for src/task-id-migration.ts: never use production SQLite; compare cloned temporary databases, verified backups and atomic updates.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,copyFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {migrateTaskIds} from '../../dist/task-id-migration.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const binary=resolve(root,'rust/target/debug/relay-rust2-parity');
let built=false;
function rust(request){
 if(!built){const build=spawnSync('cargo',['build','--offline','--manifest-path','rust/Cargo.toml'],{cwd:root,encoding:'utf8',timeout:90000});assert.equal(build.status,0,build.stderr);built=true;}
 const result=spawnSync(binary,[],{input:JSON.stringify({op:'migrateTaskIds',...request})+'\n',encoding:'utf8',timeout:20000,maxBuffer:5*1024*1024});
 assert.equal(result.status,0,`${result.error}: ${result.stderr}`);return JSON.parse(result.stdout.trim());
}
const temp=()=>mkdtempSync(join(tmpdir(),'rust2-task-id-migration-'));
const baseSql=`
 CREATE TABLE migration_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE TABLE sequences(repository TEXT,kind TEXT,value INTEGER,PRIMARY KEY(repository,kind));
 CREATE TABLE execution_process(job_id TEXT,task_id TEXT,execution_id TEXT,PRIMARY KEY(job_id,task_id,execution_id));
 CREATE TABLE host_invocation_event(job_id TEXT,task_id TEXT,event_id TEXT,PRIMARY KEY(job_id,task_id,event_id));
 CREATE TABLE host_invocation_decision(job_id TEXT,task_id TEXT,invocation_id TEXT,PRIMARY KEY(job_id,task_id,invocation_id));
 CREATE TABLE workflow_event_outbox(event_key TEXT PRIMARY KEY,event_id TEXT,payload_json TEXT,state TEXT,created_at TEXT,published_at TEXT);
 CREATE TABLE idempotency(kind TEXT,request_key TEXT PRIMARY KEY,entity_id TEXT);
 CREATE TABLE job_custom(scope_job_id TEXT,task_id TEXT,data_json TEXT,metadata_json TEXT);
 CREATE TABLE job_events(job_id TEXT,task_id TEXT,event_json TEXT);
`;
const projectJob={id:'619',state:'COMPLETED',tasks:[
 {id:'coordinator',title:'Coordinator',input:'{"taskId":"worker-a","nested":{"parentTaskId":"coordinator"}}',
  dagNode:{parentTaskId:'coordinator',nodeId:'review',graphHash:'g'},dependencies:['worker-a'],
  revision:{originalTaskId:'worker-a',reviewTaskId:'final-review-a'},recoveryForAttempt:1},
 {id:'worker-a',agentName:'editor',dagNode:{nodeId:'edit'},parentTaskId:'coordinator'},
 {id:'final-review-a',agentName:'job-acceptance-reviewer'},
 {id:'revision-1',agentName:'reviewer'},
 {id:'recovery-1',agentName:'troubleshooter'},
],plans:[{id:'plan-1',generatedTaskIds:['worker-a']}],review:{taskId:'final-review-a'},
  reviewRevisionRequests:[{originalTaskId:'worker-a',revisionTaskId:'revision-1'}],projectionRecovery:{taskId:'recovery-1'}};
const duplicateJob={id:'90',state:'COMPLETED',tasks:[
 {id:'plan-9',kind:'planner',title:'First attempt',parentTaskId:null,dependencies:[]},
 {id:'plan-9',kind:'planner',title:'Second attempt',parentTaskId:null,dependencies:[]},
 {id:'coordinator',agentGraph:'flowchart TD\nA[agent:a]',title:'Coordinator',parentTaskId:null,
  result:{summary:'DAG completed',data:{nodes:{A:'dag-coordinator-A'}}},dependencies:[]},
 {id:'dag-coordinator-A',title:'a',agentName:'a',parentTaskId:'coordinator',
  dagNode:{parentTaskId:'coordinator',nodeId:'A',graphHash:'hash'},dependencies:[]},
],plans:[{id:'plan-9',generatedTaskIds:['plan-9']}],review:{taskId:'plan-9'}};
const nestedJob={id:'12',state:'CANCELLED',tasks:[
 {id:'old-1',title:'First task',parentTaskId:'orchestrator',dependencyValidity:{'old-2':'revalidate'},
   dependencyVector:{'old-2':'old-2:source-hash'},dependencies:['old-2'],generatedTaskIds:['old-2'],restateTaskIds:['old-1'],
   metadata:{source:{originalTaskId:'old-1',targetTaskId:'old-2'}},result:{value:{jobId:'12',dependencies:['old-2'],parentTaskId:'old-1',id:'old-2',nodes:{A:'old-2'}}}},
 {id:'old-2',agentName:'designer',dagNode:{nodeId:'face'},parentTaskId:'old-1'},
],plans:[{id:'plan-12',next_tasks:[{id:'old-2',parentTaskId:'old-1',dependencies:['old-1']}]}]};
function populate(path,mode){
 const db=new DatabaseSync(path);db.exec(baseSql);
 if(mode==='active'){
  db.prepare('INSERT INTO job_snapshot VALUES(?,?,?)').run('active',JSON.stringify({id:'active',state:'ACTIVE',tasks:[]}),'now');
 } else if(mode==='invalid-task'){
  db.prepare('INSERT INTO job_snapshot VALUES(?,?,?)').run('51',JSON.stringify({id:'51',state:'COMPLETED',tasks:[{id:null}]}),'now');
 } else if(mode==='colliding'){
  const job={id:'9',state:'COMPLETED',tasks:[{id:'2',title:'First old task'},
   {id:'1',title:'Second old task'}, {id:'3',title:'Third old task'}]};
  db.prepare('INSERT INTO job_snapshot VALUES(?,?,?)').run('9',JSON.stringify(job),'now');
  for(const id of ['2','1','3'])db.prepare('INSERT INTO execution_process VALUES(?,?,?)').run('9',id,'shared-execution');
 } else if(mode==='unicode'){
  const job={id:'24',state:'COMPLETED',tasks:[{id:'任务①',title:'设计 3D',dependencies:['🐼']},
    {id:'🐼',title:'Visioner',parentTaskId:'任务①',input:'{bad input',restateTaskIds:['任务①']}],
    plans:[{next_tasks:[{id:'🐼',parentTaskId:'任务①',dependencies:['任务①']}]}]};
  db.prepare('INSERT INTO job_snapshot VALUES(?,?,?)').run('24',JSON.stringify(job),'now');
 } else if(mode==='already-migrated'){
  db.prepare('INSERT INTO migration_metadata VALUES(?,?)').run('task_id_numeric_migration','complete');
  db.prepare("INSERT INTO sequences VALUES('*','task',75)").run();
 } else {
  const jobs=mode==='multi'?[projectJob,duplicateJob,nestedJob]:mode==='duplicate'?[duplicateJob]:mode==='empty'?[]:[projectJob];
  for(const job of jobs){db.prepare('INSERT INTO job_snapshot VALUES(?,?,?)').run(job.id,JSON.stringify(job),'now');}
  if(mode==='duplicate'||mode==='multi')db.prepare("INSERT INTO sequences VALUES('*','task',100)").run();
  const first=jobs[0];
  if(first){
   const job=first.id,task=first.tasks[0].id;
   db.prepare('INSERT INTO execution_process VALUES(?,?,?)').run(job,task,'exec');
   db.prepare('INSERT INTO host_invocation_event VALUES(?,?,?)').run(job,task,'ev');
   db.prepare('INSERT INTO host_invocation_decision VALUES(?,?,?)').run(job,task,'inv');
   db.prepare('INSERT INTO job_custom VALUES(?,?,?,?)').run(job,task,JSON.stringify({taskId:task,revisionTaskId:task}),JSON.stringify({parentTaskId:task}));
   db.prepare('INSERT INTO job_events VALUES(?,?,?)').run(job,task,JSON.stringify({job_id:job,task_id:task,extra:{parentTaskId:task}}));
  }
  if(jobs.some(job=>job.id==='90')){
   db.prepare('INSERT INTO workflow_event_outbox VALUES(?,?,?,?,?,?)').run('e90','event',JSON.stringify({job_id:'90',task_id:'dag-coordinator-A',parent_task_id:'coordinator',data:{originalTaskId:'plan-9'}}),'published','now','now');
  }
  if(jobs.some(job=>job.id==='619')){
   db.prepare('INSERT INTO workflow_event_outbox VALUES(?,?,?,?,?,?)').run('e619','event',JSON.stringify({job_id:'619',task_id:'worker-a',parent_task_id:'coordinator'}),'published','now','now');
  }
  if(mode==='multi'){
   const add=(kind,key,id)=>db.prepare('INSERT INTO idempotency VALUES(?,?,?)').run(kind,key,id);
   add('task','job:619:owned','worker-a');add('task','job:90:owned','coordinator');
   add('task','global-id-ambiguous','coordinator');add('task','unused','nonexistent');
   add('job','unrelated','coordinator');
  }
 }
 db.close();
}
function snapshot(path){
 const db=new DatabaseSync(path,{readOnly:true});
 try{
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>row.name);
  const output={};
  for(const table of tables){
   output[table]=db.prepare(`SELECT * FROM "${table.replaceAll('"','""')}" ORDER BY rowid`).all().map(record=>Object.fromEntries(Object.entries(record).map(([key,value])=>[key,typeof value==='bigint'?Number(value):value])));
  }
  return output;
 }finally{db.close();}
}
async function nodeResult(path,backup){try{return {ok:true,value:await migrateTaskIds(path,backup)}}catch(error){return {ok:false,error:error.message}}}
function normalize(result){
 if(result.ok)return {ok:true,value:{...result.value,backupPath:'<fixture-backup>'}};
 if(result.error?.startsWith('Backup already exists: '))return {ok:false,error:'Backup already exists: <fixture-backup>'};
 return result;
}

test('offline SQLite Node/Rust migrations produce identical durable rows and verified backups',async()=>{
 let count=0;
 for(const mode of ['project','duplicate','multi','empty','already-migrated','colliding','unicode']){
  const dir=temp();
  try{
   const node=join(dir,'node.sqlite'),rustPath=join(dir,'rust.sqlite');
   const nodeBackup=join(dir,'node.backup.sqlite'),rustBackup=join(dir,'rust.backup.sqlite');
   populate(node,mode);copyFileSync(node,rustPath);
   const before=snapshot(node);
   const expected=await nodeResult(node,nodeBackup);
   const actual=rust({databasePath:rustPath,backupPath:rustBackup});
   assert.deepEqual(normalize(actual),normalize(expected),`Summary mismatch ${mode}`);
   assert.deepEqual(snapshot(rustPath),snapshot(node),`Current SQLite differs ${mode}`);
   if(!['already-migrated'].includes(mode)){
    assert(existsSync(nodeBackup)&&existsSync(rustBackup));
    assert.deepEqual(snapshot(nodeBackup),before,`Node backup differs ${mode}`);
    assert.deepEqual(snapshot(rustBackup),before,`Rust backup differs ${mode}`);
   }else{assert(!existsSync(nodeBackup)&&!existsSync(rustBackup));}
   if(expected.ok&&!expected.value.alreadyMigrated){
    const nodeAgain=await nodeResult(node,nodeBackup);
    const rustAgain=rust({databasePath:rustPath,backupPath:rustBackup});
    assert.deepEqual(normalize(rustAgain),normalize(nodeAgain),`Second invocation should be idempotent: ${mode}`);
   }
   count++;
  }finally{rmSync(dir,{recursive:true,force:true})}
 }
 console.log(`Verified ${count} complete SQLite Node/Rust migration and original-backup snapshots`);
});

test('migration preflight rejects ACTIVE jobs, malformed Task IDs and existing backups without mutating SQLite',async()=>{
 let checked=0;
 for(const mode of ['active','invalid-task','project']){
  const dir=temp();
  try{
   const n=join(dir,'node.sqlite'),r=join(dir,'rust.sqlite');const nb=join(dir,'node.bak'),rb=join(dir,'rust.bak');
   populate(n,mode);copyFileSync(n,r);
   if(mode==='project'){const fs=await import('node:fs');fs.writeFileSync(nb,'existing');fs.writeFileSync(rb,'existing');}
   const before=snapshot(n);
   const node=await nodeResult(n,nb);const rustResult=rust({databasePath:r,backupPath:rb});
   assert.deepEqual(normalize(rustResult),normalize(node),`Preflight mismatch ${mode}`);
   assert.equal(node.ok,false);
   assert.deepEqual(snapshot(n),before);assert.deepEqual(snapshot(r),before);
   checked++;
  }finally{rmSync(dir,{recursive:true,force:true})}
 }
 console.log(`Verified ${checked} fail-closed preflight cases without any source SQLite modifications`);
});


test('migration rolls back every SQLite writer if a late relational CHECK fails; verified source backup remains intact',async()=>{
 const dir=temp();
 try{
  const node=join(dir,'node.sqlite'),rustPath=join(dir,'rust.sqlite');
  const nodeBackup=join(dir,'node.backup.sqlite'),rustBackup=join(dir,'rust.backup.sqlite');
  populate(node,'project');
  const db=new DatabaseSync(node);
  db.exec("CREATE TABLE blocked_reference(job_id TEXT,task_id TEXT CHECK(task_id='coordinator'));");
  db.prepare('INSERT INTO blocked_reference VALUES(?,?)').run('619','coordinator');db.close();
  copyFileSync(node,rustPath);
  const before=snapshot(node);
  const expected=await nodeResult(node,nodeBackup);
  const actual=rust({databasePath:rustPath,backupPath:rustBackup});
  assert.equal(expected.ok,false);assert.equal(actual.ok,false);
  assert.match(expected.error,/CHECK constraint failed/);
  assert.match(actual.error,/CHECK constraint failed/);
  assert.deepEqual(snapshot(node),before,'Node must rollback');
  assert.deepEqual(snapshot(rustPath),before,'Rust must rollback');
  assert(existsSync(nodeBackup)&&existsSync(rustBackup),'The verified backup must survive a failed transaction');
  assert.deepEqual(snapshot(nodeBackup),before,'Node pre-migration backup was modified');
  assert.deepEqual(snapshot(rustBackup),before,'Rust pre-migration backup was modified');
  console.log('Verified complete transactional rollback and pre-migration backup after SQL CHECK failure');
 }finally{rmSync(dir,{recursive:true,force:true})}
});
