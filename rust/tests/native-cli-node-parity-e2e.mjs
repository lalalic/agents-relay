import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const dir=process.env.CARGO_TARGET_DIR??resolve(import.meta.dirname,'../target');
const cli=join(dir,'debug/relay-native-job');
const helper=join(dir,'debug/relay-worker-helper');
const env={...process.env,RELAY_RUST_EXPERIMENTAL_TEST_ONLY:'isolated-test'};
function invoke(args,expected=0){
 const run=spawnSync(cli,args,{encoding:'utf8',env,timeout:25000});
 assert.equal(run.status,expected,run.stderr||run.stdout);
 return expected===0 ? (args[0]==='job' && args[1]==='run' ? run.stdout : (run.stdout.trim().startsWith('{')||run.stdout.trim().startsWith('[')? JSON.parse(run.stdout):run.stdout)) : run.stderr;
}
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'relay-rust-authority-'));
 mkdirSync(join(root,'project')); mkdirSync(join(root,'project','output'));
 writeFileSync(join(root,'.relay-rust-authority-isolated-test'),'isolated-test');
 const db=join(root,'relay.sqlite');
 const graph=join(root,'project','graph.mmd');
 writeFileSync(graph,'flowchart TD\nbuild[agent:builder] --> verify[agent:verifier]\n');
 const input=join(root,'project','input.md');
 writeFileSync(input,'Rust-native foreground CLI two-stage Coordinator E2E');
 const worker=join(root,'worker.mjs');
 writeFileSync(worker,[
 'import {readFileSync,writeFileSync} from "node:fs";',
 'const request=JSON.parse(readFileSync(process.env.RELAY_TASK_REQUEST_PATH,"utf8"));',
 'const input=JSON.parse(request.input);',
 'const role=request.agentName;',
 'if(role==="verifier" && input.predecessorOutputs?.build?.stage!=="builder") process.exit(3);',
 'const output={stage:role==="builder"?"builder":"verifier",source:input.predecessorOutputs?.build?.stage||null};',
 'writeFileSync(process.env.RELAY_RESULT_PATH,JSON.stringify({jobId:request.jobId,taskId:request.taskId,executionId:request.executionId,status:"COMPLETED",output}));'
 ].join('\n'));
 const manifest=join(root,'manifest.json');
 writeFileSync(manifest,JSON.stringify({agents:{
  builder:{kind:'script',executable:process.execPath,args:[worker]},
  verifier:{kind:'script',executable:process.execPath,args:[worker]}
 }}));
 return {root,db,graph,input,manifest,output:join(root,'project','output','result.json')};
}
test('Node spelling: native Rust job/task show/list/events reject wrong bindings',()=>{
 const f=fixture();
 try{
  invoke(['init','--db',f.db]);
  const created=invoke(['create','--db',f.db,'--project-root',join(f.root,'project'),
   '--graph-file',f.graph,'--input-file',f.input,'--output-path',f.output,
   '--title','Rust CLI parity','--repository','calc','--request-key','cli-parity-1']);
  assert.equal(invoke(['job','show','--db',f.db,'--id',created.jobId,'--repo','calc']).id,created.jobId);
  assert.equal(invoke(['job','list','--db',f.db,'--repo','calc']).length,1);
  assert.equal(invoke(['job','list','--db',f.db,'--repo','unknown']).length,0);
  assert.equal(invoke(['task','list','--db',f.db,'--id',created.jobId]).length,1);
  assert.equal(invoke(['task','show','--db',f.db,'--id',created.jobId,'--task-id',created.coordinatorTaskId]).state,'QUEUED');
  const events=invoke(['task','events','--db',f.db,'--id',created.jobId,'--task-id',created.coordinatorTaskId,
   '--limit','3','--order','asc','--after','0']);
  assert.equal(events.order,'oldest-first');
  assert.match(invoke(['job','show','--db',f.db,'--id',created.jobId,'--repo','other'],2),/repository identity mismatch/);
  assert.match(invoke(['task','events','--db',f.db,'--id',created.jobId,'--task-id',created.coordinatorTaskId,
    '--limit','61'],2),/--limit/);
  assert.match(invoke(['task','list','--db',f.db,'--id',created.jobId,'--undocumented'],2),/unsupported CLI option/);
 } finally{rmSync(f.root,{recursive:true,force:true});}
});
test('Node spelling: native Rust job run --foreground completes real Coordinator and successor DAG',()=>{
 const f=fixture();
 try{
  invoke(['init','--db',f.db]);
  const created=invoke(['create','--db',f.db,'--project-root',join(f.root,'project'),
   '--graph-file',f.graph,'--input-file',f.input,'--output-path',f.output,
   '--title','Rust CLI foreground parity','--repository','calc','--request-key','cli-parity-2']);
  assert.match(invoke(['job','run','--db',f.db,'--id',created.jobId,
   '--task-id',created.coordinatorTaskId,'--foreground','--concurrency','0'],2),/--concurrency/);
  assert.equal(invoke(['job','show','--db',f.db,'--id',created.jobId]).state,'DRAFT',
    'invalid foreground parameters must never activate a draft Job');
  const out=invoke(['job','run','--db',f.db,'--id',created.jobId,'--task-id',created.coordinatorTaskId,
   '--repo','calc','--foreground','--manifest',f.manifest,'--helper',helper,
   '--concurrency','2','--interval-ms','100']);
  const events=out.trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(events[0].event,'job.foreground.started');
  assert.equal(events[0].mode,'owner');
  assert.equal(events.at(-1).event,'job.foreground.terminal');
  assert.equal(events.at(-1).state,'COMPLETED');
  const job=invoke(['job','show','--db',f.db,'--id',created.jobId]);
  assert.equal(job.state,'COMPLETED');
  assert.equal(job.reviewEnabled,false);
  assert.deepEqual(job.tasks.map(t=>t.state),['SUCCEEDED','SUCCEEDED','SUCCEEDED']);
  assert.equal(job.tasks[2].result.data.output.source,'builder');
  assert.match(invoke(['job','run','--db',f.db,'--id',created.jobId,'--task-id','not-coordinator','--foreground'],2),/Coordinator Task not found/);
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
test('retired legacy merge and explicit help fail safely without Node fallback',()=>{
 assert.match(invoke(['--help']),/job run/);
 assert.match(invoke(['job','run','--help']),/foreground/);
 assert.match(invoke(['job','merge'],2),/retired.*Graph-owned/);
});
