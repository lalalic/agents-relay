import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowActionLedger } from '../dist/workflow/action-ledger.js';
import { workflowCliResult } from '../dist/cli-workflow.js';
import { buildWorkflowUsageIndex, defaultWorkflowDirectory, executableGraphs } from '../dist/workflow/usage-index.js';
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
 const canonicalActions=[...new Set(buildWorkflowUsageIndex(executableGraphs(defaultWorkflowDirectory())).filter(item=>item.kind==='action').map(item=>item.id))].sort();
 assert.equal(catalog.count,canonicalActions.length);
 assert.equal(catalog.actions.length,catalog.count);
 assert.deepEqual(catalog.actions.map(action=>action.id),canonicalActions);
 assert.ok(catalog.actions.every(action=>action.graphReferences.length>0 && action.cli.includes('inspect-only')));
 assert.ok(catalog.actions.every(action=>action.graphReferences.every(reference=>canonicalActions.includes(action.id) && reference.kind==='action')));
 assert.equal(catalog.actions.some(action=>action.id==='effect.launchShortcut'),false);
 assert.equal(catalog.actions.some(action=>action.id==='effect.resumeShortcut'),false);
 assert.ok(catalog.actions.some(action=>action.id==='effect.launchTask'));
 const taskGraph=executableGraphs(defaultWorkflowDirectory()).get('task-lifecycle.mmd');
 assert.ok(taskGraph);
 const guardedBy=(id,guard)=>{
  const action=[...taskGraph.nodes.values()].find(node=>node.kind==='action'&&node.semanticId===id);
  assert.ok(action,`missing graph action ${id}`);
  return taskGraph.edges.filter(edge=>edge.to===action.id).some(edge=>{
   const predecessor=taskGraph.nodes.get(edge.from);
   return predecessor?.kind==='guard'&&predecessor.semanticId===guard;
  });
 };
 assert.ok([...taskGraph.nodes.values()].some(n=>n.kind==='action'&&n.semanticId==='effect.launchTask'));
 assert.equal([...taskGraph.nodes.values()].some(n=>n.kind==='action'&&n.semanticId==='effect.launchShortcut'),false);

 assert.equal(catalog.taskControls.length,6);
 assert.match(catalog.warning,/No direct CLI bypass/);
});
