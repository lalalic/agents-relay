import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {pausedAndQuiescent,assertIdleDatabase} from './release-native.mjs';
test('pause requires explicit fencing',()=>{
  const job={id:'738',state:'ACTIVE',pause:{requestedAt:'now'},tasks:[{state:'QUEUED'}],plans:[]};
  assert(pausedAndQuiescent(job));
  for(const change of [{pause:null},{tasks:null},{plans:null},{tasks:[{executionId:'live'}]},
    {tasks:[{pausedExecution:{id:'pending'}}]},{plans:[{executionId:'live'}]},{plans:[{pausedExecutionId:'pending'}]}])
    assert(!pausedAndQuiescent({...job,...change}));
});
test('actual isolated SQLite release gate refuses active Jobs and process groups',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'relay-release-guard-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'relay.sqlite');
  const db=new DatabaseSync(file);
  t.after(()=>db.close());
  db.exec('CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT); CREATE TABLE execution_process(pid INTEGER,pgid INTEGER,ended_at TEXT)');
  const put=j=>db.prepare('INSERT OR REPLACE INTO job_snapshot VALUES (?,?)').run(j.id,JSON.stringify(j));
  const job={id:'738',state:'ACTIVE',pause:{requestedAt:'now'},tasks:[],plans:[]};
  put(job);
  assert.throws(()=>assertIdleDatabase(file,[],()=>false),/nonterminal Jobs/);
  assert.equal(assertIdleDatabase(file,['738'],()=>false),1);
  put({...job,id:'739'});
  assert.throws(()=>assertIdleDatabase(file,['738'],()=>false),/739/);
  put({...job,id:'739',state:'COMPLETED'});
  assert.equal(assertIdleDatabase(file,['738'],()=>false),2);
  db.exec('INSERT INTO execution_process VALUES(1000,1001,NULL)');
  assert.throws(()=>assertIdleDatabase(file,['738'],pid=>pid===-1001),/active worker/);
  assert.equal(assertIdleDatabase(file,['738'],()=>false),2);
});
