import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {WorkflowActionLedger} from '../../dist/workflow/action-ledger.js';
const root=fileURLToPath(new URL('../../',import.meta.url));
const cli=join(root,'dist/cli.js');
const run=(args,env)=>execFileSync(process.execPath,[cli,'workflow',...args],{cwd:root,encoding:'utf8',timeout:12000,env:{...process.env,AGENTS_RELAY_STORE_DIR:env}});
test('L3 CLI enumerates all 48 canonical Graph Actions and can locate each owning graph',()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-cli-actions-l3-'));
 try {
  const {count,actions}=JSON.parse(run(['actions'],dir));
  assert.equal(count,48);
  for(const entry of actions){
   assert.ok(entry.graphReferences.length,entry.id);
   const refs=JSON.parse(run(['where','--id',entry.id],dir));
   assert.ok(refs.some(ref=>ref.kind==='action'),entry.id);
   assert.equal(entry.cli,'inspect-only; execution requires owning Graph runtime');
  }
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('L3 CLI reads real SQLite action ledger trace and fails closed against direct unsafe effect',()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-cli-sqlite-l3-'));
 const path=join(dir,'workflow.sqlite');
 try {
  const db=new DatabaseSync(path);
  const ledger=new WorkflowActionLedger(db);
  ledger.reserve({executionId:'execution-A',generation:2,graph:'task-lifecycle.mmd',actionId:'effect.launchTask',attemptKey:'job/task/execution-A/launch'}, {accepted:true,source:'QUEUED',target:'QUEUED',actions:[{id:'effect.launchTask'}]},'worker.started');
  db.close();
  const trace=JSON.parse(run(['trace','--sqlite',path,'--attempt-key','job/task/execution-A/launch'],dir)).trace;
  assert.equal(trace.execution_id,'execution-A');
  assert.equal(trace.generation,2);
  assert.equal(trace.action_id,'effect.launchTask');
  assert.equal(trace.outcome,'Unknown');
  for (const {id} of JSON.parse(run(['actions'],dir)).actions) {
   assert.throws(()=>run(['action','--action',id,'--repo','local/isolated','--id','job','--task-id','task'],dir), /supported Graph-authorized task Action ID/, id);
  }
  const again=JSON.parse(run(['trace','--sqlite',path,'--attempt-key','job/task/execution-A/launch'],dir)).trace;
  assert.deepEqual(again,trace,'failed CLI attempt must not modify ledger');
 } finally {rmSync(dir,{recursive:true,force:true});}
});
