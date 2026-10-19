import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {verifyAuthoritativeCondition} from '../dist/workflow/authoritative-conditions.js';
import {workflowCliResult} from '../dist/cli-workflow.js';

test('SQLite facts, not client booleans, determine queued/succeeded/routing postconditions',()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-authority-')); const path=join(dir,'state.sqlite');
 try{
  const db=new DatabaseSync(path);
  db.exec('CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT,updated_at TEXT); CREATE TABLE execution_process(job_id TEXT,task_id TEXT,execution_id TEXT,ended_at TEXT)');
  const task={id:'worker',state:'QUEUED',executionId:null,leaseOwner:null,executionHistory:[{id:'old',attempt:1}]};
  const job={id:'481',state:'ACTIVE',executionMode:'autonomous',tasks:[task],plans:[]};
  const write=()=>db.prepare('INSERT OR REPLACE INTO job_snapshot VALUES(?,?,?)').run('481',JSON.stringify(job),new Date().toISOString());write();
  assert.equal(verifyAuthoritativeCondition(db,'481','task.queued','worker'),'Verified');
  assert.equal(verifyAuthoritativeCondition(db,'481','task.routing-cleared','worker'),'Verified');
  assert.equal(verifyAuthoritativeCondition(db,'481','task.execution-stopped','worker','old'),'Unknown');
  assert.equal(verifyAuthoritativeCondition(db,'481','job.objective-verified'),'Failed');
  assert.equal(verifyAuthoritativeCondition(db,'481','job.completed'),'Failed');
  db.prepare('INSERT INTO execution_process VALUES(?,?,?,?)').run('481','worker','old',new Date().toISOString());
  assert.equal(verifyAuthoritativeCondition(db,'481','task.execution-stopped','worker','old'),'Verified');
  task.state='SUCCEEDED';write();db.close();
  const actual=workflowCliResult(['verify','--sqlite',path,'--job','481','--task','worker','--condition','task.succeeded']);
  assert.equal(actual.outcome,'Verified');
  assert.throws(()=>workflowCliResult(['verify','--sqlite',path,'--job','481','--condition','arbitrary.truth']),/supported/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
