import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrateTaskIds } from '../dist/task-id-migration.js';
import { allocateEntityId } from '../dist/job-task-id-sequence.js';

test('one-time Task ID migration backs up and rewrites snapshots, nested #619 references, and relational ledgers', async()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-task-id-migration-'));const path=join(dir,'relay.sqlite');const backup=join(dir,'backup.sqlite');
 try{
  const db=new DatabaseSync(path);db.exec(`CREATE TABLE migration_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL);CREATE TABLE sequences(repository TEXT,kind TEXT,value INTEGER,PRIMARY KEY(repository,kind));CREATE TABLE execution_process(job_id TEXT,task_id TEXT,execution_id TEXT,PRIMARY KEY(job_id,task_id,execution_id));CREATE TABLE host_invocation_event(job_id TEXT,task_id TEXT,event_id TEXT,PRIMARY KEY(job_id,task_id,event_id));CREATE TABLE host_invocation_decision(job_id TEXT,task_id TEXT,invocation_id TEXT,PRIMARY KEY(job_id,task_id,invocation_id));`);
  const job={id:'619',state:'COMPLETED',tasks:[{id:'coordinator',title:'Coordinator',input:'{"taskId":"worker-a","nested":{"parentTaskId":"coordinator"}}',dagNode:{parentTaskId:'coordinator',nodeId:'review',graphHash:'g'},dependencies:['worker-a'],revision:{originalTaskId:'worker-a',reviewTaskId:'final-review-a'},recoveryForAttempt:1},{id:'worker-a'},{id:'final-review-a'},{id:'revision-1'},{id:'recovery-1'}],plans:[{id:'plan-1',generatedTaskIds:['worker-a']}],review:{taskId:'final-review-a'},reviewRevisionRequests:[{originalTaskId:'worker-a',revisionTaskId:'revision-1'}],projectionRecovery:{taskId:'recovery-1'}};
  db.prepare('INSERT INTO job_snapshot VALUES(?,?,?)').run('619',JSON.stringify(job),'now');
  db.prepare('INSERT INTO execution_process VALUES(?,?,?)').run('619','coordinator','exec');
  db.prepare('INSERT INTO host_invocation_event VALUES(?,?,?)').run('619','coordinator','event');
  db.prepare('INSERT INTO host_invocation_decision VALUES(?,?,?)').run('619','coordinator','invocation');db.close();
  const result=await migrateTaskIds(path,backup);assert.equal(result.taskCount,5);assert.equal(result.maxId,5);assert.ok(existsSync(backup));
  const migrated=new DatabaseSync(path,{readOnly:true});const saved=JSON.parse(migrated.prepare('SELECT json FROM job_snapshot').get().json);
  assert.equal(saved.tasks[0].id,'1');assert.equal(saved.tasks[0].dagNode.parentTaskId,'1');assert.equal(saved.tasks[0].dependencies[0],'2');
  assert.deepEqual(JSON.parse(saved.tasks[0].input),{taskId:'2',nested:{parentTaskId:'1'}});
  assert.equal(saved.tasks[0].revision.originalTaskId,'2');assert.equal(saved.review.taskId,'3');
  assert.equal(saved.reviewRevisionRequests[0].revisionTaskId,'4');assert.equal(saved.projectionRecovery.taskId,'5');
  assert.equal(migrated.prepare('SELECT task_id FROM execution_process').get().task_id,'1');
  assert.equal(migrated.prepare('SELECT task_id FROM host_invocation_event').get().task_id,'1');
  assert.equal(migrated.prepare('SELECT task_id FROM host_invocation_decision').get().task_id,'1');migrated.close();
  assert.equal(allocateEntityId(join(dir,'stores'),'repo','task'),'6');
  assert.equal((await migrateTaskIds(path,backup)).alreadyMigrated,true);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('Task ID migration rejects ACTIVE Jobs before changing durable data',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-task-id-active-'));const path=join(dir,'relay.sqlite');
 try{const db=new DatabaseSync(path);db.exec('CREATE TABLE migration_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL)');db.prepare('INSERT INTO job_snapshot VALUES(?,?,?)').run('active','{"id":"active","state":"ACTIVE","tasks":[]}','now');db.close();
  await assert.rejects(migrateTaskIds(path,join(dir,'backup.sqlite')),/Job active is ACTIVE/);
  const read=new DatabaseSync(path,{readOnly:true});assert.equal(read.prepare('SELECT json FROM job_snapshot').get().json,'{"id":"active","state":"ACTIVE","tasks":[]}');read.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('historical duplicate Planner IDs preserve both Tasks while references select first owner',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-numeric-duplicate-'));
 const path=join(dir,'relay.sqlite'),backup=join(dir,'before.sqlite');
 try{
  const db=new DatabaseSync(path);
  db.exec(`CREATE TABLE migration_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE sequences(repository TEXT,kind TEXT,value INTEGER,PRIMARY KEY(repository,kind));
    CREATE TABLE workflow_event_outbox(event_key TEXT PRIMARY KEY,event_id TEXT,payload_json TEXT,state TEXT,created_at TEXT,published_at TEXT);`);
  db.prepare("INSERT INTO sequences VALUES('*','task',100)").run();
  const tasks=[{id:'plan-9',kind:'planner',title:'First attempt',parentTaskId:null,dependencies:[]},
    {id:'plan-9',kind:'planner',title:'Second attempt',parentTaskId:null,dependencies:[]},
    {id:'coordinator',agentGraph:'flowchart TD\nA[agent:a]',title:'Coordinator',parentTaskId:null,
      result:{summary:'DAG completed',data:{nodes:{A:'dag-coordinator-A'}}},dependencies:[]},
    {id:'dag-coordinator-A',title:'a',agentName:'a',parentTaskId:'coordinator',
      dagNode:{parentTaskId:'coordinator',nodeId:'A',graphHash:'hash'},dependencies:[]}];
  db.prepare('INSERT INTO job_snapshot VALUES(?,?,?)').run('90',JSON.stringify({id:'90',state:'COMPLETED',tasks,plans:[{id:'plan-9',generatedTaskIds:['plan-9']}]}),'now');
  db.prepare('INSERT INTO workflow_event_outbox VALUES(?,?,?,?,?,?)').run('evt','event',JSON.stringify({job_id:'90',task_id:'dag-coordinator-A',parent_task_id:'coordinator',data:{originalTaskId:'plan-9'}}),'published','now','now');
  db.close();
  const result=await migrateTaskIds(path,backup);
  assert.equal(result.taskCount,4);assert.equal(result.duplicateTaskRecords,1);assert.equal(result.maxId,100);
  const copy=new DatabaseSync(path,{readOnly:true});
  const saved=JSON.parse(copy.prepare('SELECT json FROM job_snapshot').get().json);
  assert.deepEqual(saved.tasks.map(task=>task.id),['1','2','3','4']);
  assert.equal(saved.plans[0].generatedTaskIds[0],'1');
  assert.equal(saved.tasks[2].result.data.nodes.A,'4');
  assert.equal(saved.tasks[3].dagNode.parentTaskId,'3');
  const event=JSON.parse(copy.prepare('SELECT payload_json FROM workflow_event_outbox').get().payload_json);
  assert.equal(event.task_id,'4');assert.equal(event.parent_task_id,'3');assert.equal(event.data.originalTaskId,'1');
  copy.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
