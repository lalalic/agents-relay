import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { taskExecutionContext } from '../../dist/task-context.js';

const cli=join(process.env.CARGO_TARGET_DIR ?? resolve(import.meta.dirname,'../target'),'debug/relay-native-job');
const env={...process.env,RELAY_RUST_EXPERIMENTAL_TEST_ONLY:'isolated-test'};
function call(args,expected=0){
  const r=spawnSync(cli,args,{encoding:'utf8',env,timeout:12000});
  assert.equal(r.status,expected,r.stderr||r.stdout);
  return expected===0?JSON.parse(r.stdout):r.stderr;
}
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'relay-rust-authority-task-context-'));
  mkdirSync(join(root,'project'));
  writeFileSync(join(root,'.relay-rust-authority-isolated-test'),'isolated-test');
  const db=join(root,'relay.sqlite');call(['init','--db',db]);
  const created=call(['job','create','--db',db,'--repo','example','--objective','Test execution binding',
    '--title','Task context check','--project-root',join(root,'project'),'--id','53']);
  assert.equal(created.job.id,'53');
  const task=(key)=>call(['task','create','--db',db,'--id','53','--repo','example','--input',`Work ${key}`,
    '--title',key,'--output','file','--output-path',join(root,'project',`${key}.md`)]).taskId;
  const parent=task('failing-worker'),reviewer=task('reviewer'),troubleshooter=task('troubleshooter');
  const sqlite=new DatabaseSync(db);
  const raw=sqlite.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get('53').json;
  const j=JSON.parse(raw);
  const worker=j.tasks.find(t=>t.id===parent);
  worker.state='SUCCEEDED';worker.executionId='worker-exec';worker.result={output:'evidence'};worker.comments=[{id:'c1',message:'Worker evidence',at:'2026-11-15T16:00:00Z'}];
  const rev=j.tasks.find(t=>t.id===reviewer);
  rev.state='RUNNING';rev.executionId='review-exec';rev.agentName='job-acceptance-reviewer';rev.dependencies=[parent,'missing-dependency'];
  rev.comments=[{id:'c2',message:'Review requested',at:'2026-11-15T16:01:00Z'}];rev.planningDecisionId='plan-x';
  const trouble=j.tasks.find(t=>t.id===troubleshooter);
  trouble.state='QUEUED';trouble.executionId='trouble-exec';trouble.agentName='troubleshooter';trouble.parentTaskId=parent;
  trouble.comments=[{id:'c3',message:'Investigate',at:'2026-11-15T16:02:00Z'}];
  j.plans=[{id:'plan-x',status:'SUCCEEDED',assessment:'test'}];
  sqlite.prepare('UPDATE job_snapshot SET json=? WHERE job_id=?').run(JSON.stringify(j),'53');
  sqlite.close();
  return {root,db,job:j,parent,reviewer,troubleshooter};
}
const read=(f,action,id,execution)=>['task',action,'--db',f.db,'--id','53','--repo','example','--task-id',id,
  ...(execution?['--execution-id',execution]:[])];

test('native task context matches actual Node execution context for final reviewer and troubleshooter',()=>{
  const f=fixture();try{
    const before=readFileSync(f.db);
    for(const [id,execution] of [[f.reviewer,'review-exec'],[f.troubleshooter,'trouble-exec']]){
      const expected=taskExecutionContext(f.job,id,execution);
      const actual=call(read(f,'context',id,execution));
      assert.deepEqual(actual,JSON.parse(JSON.stringify(expected)));
      assert.deepEqual(call(read(f,'context',id,execution)),actual,'process restart returns durable snapshot');
    }
    assert.equal(call(read(f,'comments',f.reviewer)).length,1);
    assert.equal(call(read(f,'comments',f.troubleshooter))[0].message,'Investigate');
    assert.deepEqual(readFileSync(f.db),before,'Task context/comments are strictly read-only');
  }finally{rmSync(f.root,{recursive:true,force:true});}
});

test('Task context rejects stale execution, terminal Task, missing Task and repository spoofing',()=>{
  const f=fixture();try{
    const before=readFileSync(f.db);
    assert.match(call(read(f,'context',f.reviewer,'stale-exec'),2),/Stale Task execution/);
    assert.match(call(read(f,'context',f.parent,'worker-exec'),2),/Stale Task execution/);
    assert.match(call(read(f,'context',f.reviewer),2),/requires --execution-id/);
    assert.match(call([...read(f,'context',f.reviewer,'review-exec'),'--execution-id','other'],2),/duplicate option/);
    assert.match(call(['task','context','--db',f.db,'--id','53','--repo','wrong','--task-id',f.reviewer,'--execution-id','review-exec'],2),/repository identity mismatch/);
    assert.match(call(read(f,'comments','unknown'),2),/Task unknown not found/);
    assert.match(call([...read(f,'comments',f.reviewer),'--execution-id','review-exec'],2),/unsupported CLI option/);
    assert.deepEqual(readFileSync(f.db),before);
  }finally{rmSync(f.root,{recursive:true,force:true});}
});
