import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowActionLedger } from '../dist/workflow/action-ledger.js';
import { workflowCliResult } from '../dist/cli-workflow.js';
test('CLI graph discovery, inspect, where, evaluate are read-only', () => {
  assert.ok(workflowCliResult(['discover']).graphs.includes('task-lifecycle.mmd'));
  assert.ok(workflowCliResult(['inspect','--graph','task-lifecycle.mmd']).nodes.length);
  assert.ok(workflowCliResult(['where','--id','effect.launchTask']).length);
  assert.equal(workflowCliResult(['evaluate','--graph','task-lifecycle.mmd','--state','DRAFT','--event','queue']).mode, 'dry-run');
});
test('CLI rejects unauthorized actions and absent durable trace', () => {
  assert.throws(() => workflowCliResult(['action','--id','effect.mergePullRequest']), /authorization/);
  assert.throws(() => workflowCliResult(['trace']), /requires existing/);
  assert.throws(() => workflowCliResult(['inspect','--graph','main.mmd']), /unknown executable/);
});

test('CLI trace reads durable SQLite action audit without mutating it',()=>{
 const folder=mkdtempSync(join(tmpdir(),'relay-cli-trace-'));
 try {
  const path=join(folder,'workflow.sqlite');
  const db=new DatabaseSync(path);
  const ledger=new WorkflowActionLedger(db);
  ledger.reserve({executionId:'e1',generation:1,graph:'task-lifecycle',actionId:'effect.launchTask',attemptKey:'try1'}, {accepted:true,source:'QUEUED',target:'RUNNING',actions:[{id:'effect.launchTask'}]}, 'postcondition');
  db.close();
  const result=workflowCliResult(['trace','--sqlite',path,'--attempt-key','try1']);
  assert.equal(result.trace.execution_id,'e1');
  assert.equal(result.trace.outcome,'Unknown');
  assert.equal(workflowCliResult(['trace','--sqlite',path,'--attempt-key','absent']).trace,null);
 } finally {rmSync(folder,{recursive:true,force:true});}
});

test('CLI audits every executable graph action without bypassing guards', () => {
 const catalog=workflowCliResult(['actions']);
 assert.equal(catalog.count,47);
 assert.equal(catalog.actions.length,catalog.count);
 assert.ok(catalog.actions.every(action=>action.graphReferences.length>0 && action.cli.includes('inspect-only')));
 assert.ok(catalog.actions.some(action=>action.id==='effect.launchTask'));
 assert.equal(catalog.taskControls.length,6);
 assert.match(catalog.warning,/No direct CLI bypass/);
});
