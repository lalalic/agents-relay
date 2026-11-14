import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { SQLiteRelayStore } from '../../dist/relay-store.js';
const binary = resolve(import.meta.dirname, '../target/debug/relay-native-daemon');
const helper = resolve(import.meta.dirname, '../target/debug/relay-worker-helper');
const timestamp = '2026-11-13T20:00:00.000Z';
const env = {...process.env, RELAY_RUST_EXPERIMENTAL_TEST_ONLY:'isolated-test'};
const script = `printf '{"jobId":"%s","taskId":"%s","executionId":"%s","status":"COMPLETED","output":{"stage":"visioner"}}' "$RELAY_JOB_ID" "$RELAY_TASK_ID" "$RELAY_EXECUTION_ID" > "$RELAY_RESULT_PATH"`;
const editorScript = `printf '{"jobId":"%s","taskId":"%s","executionId":"%s","status":"COMPLETED","output":{"stage":"editor"}}' "$RELAY_JOB_ID" "$RELAY_TASK_ID" "$RELAY_EXECUTION_ID" > "$RELAY_RESULT_PATH"`;
const scriptDriver = `import {readFileSync,writeFileSync} from 'node:fs';
const r=JSON.parse(readFileSync(process.env.RELAY_TASK_REQUEST_PATH,'utf8'));
const input=JSON.parse(r.input);
const stage=process.argv[2];
const output={stage,predecessor:stage==='editor'?input.predecessorOutputs.director.stage:null,taskId:input.taskId};
writeFileSync(process.env.RELAY_RESULT_PATH,JSON.stringify({jobId:r.jobId,taskId:r.taskId,executionId:r.executionId,status:'COMPLETED',output}));`;
const driver = `import {readFileSync,writeFileSync} from 'node:fs';
const r=JSON.parse(readFileSync(process.env.RELAY_TASK_REQUEST_PATH,'utf8'));
const input=JSON.parse(r.input);
const output={stage:'director',source:input.predecessorOutputs.visioner?.stage||null};
writeFileSync(process.env.RELAY_RESULT_PATH,JSON.stringify({type:'task.completed',jobId:r.jobId,taskId:r.taskId,executionId:r.executionId,leaseOwner:r.leaseOwner,attempt:r.attempt,adapter:'codex',routing:r.routing,workerSelection:r.workerSelection,status:'COMPLETED',summary:'reviewed director story',output}));`;
function fixture(withRouter=true) {
 const root=mkdtempSync(join(tmpdir(),'relay-rust-authority-'));
 const db=join(root,'relay.sqlite'), manifest=join(root,'manifest.json'), worker=join(root,'model-worker.mjs'), scriptWorker=join(root,'script-worker.mjs');
 writeFileSync(join(root,'.relay-rust-authority-isolated-test'),'isolated-test');
 writeFileSync(worker,driver);writeFileSync(scriptWorker,scriptDriver);
 const model={kind:'model',executable:process.execPath,args:[worker]};
 if(withRouter){model.routing={provider:'test-provider',model:'test-model',decidedBy:'trusted-pilot',decidedAt:timestamp};model.workerSelection={workerId:'test-codex',adapter:'codex',selectedBy:'trusted-pilot',selectedAt:timestamp};}
 writeFileSync(manifest,JSON.stringify({agents:{'vlog-visioner':{kind:'script',executable:process.execPath,args:[scriptWorker,'visioner']},'vlog-director':model,'vlog-editor':{kind:'script',executable:process.execPath,args:[scriptWorker,'editor']}}}));
 const args=['--once','--db',db,'--manifest',manifest,'--helper',helper];
 return {root,db,args};
}
async function seed(f, outputPath=join(f.root,'episode-result.json')) {
 const store=new SQLiteRelayStore(f.db);
 const coordinator={id:'1718',jobId:'629',title:'Coordinator',kind:'work',agentGraph:'flowchart TD\nvisioner[agent:vlog-visioner] --> director[agent:vlog-director]\ndirector --> editor[agent:vlog-editor]',
 input:'Build authentic source-linked Vlog story',output:{kind:'file',path:outputPath},
 state:'QUEUED',attempt:0,maxAttempts:3,dependencies:[],adapter:'codex',timeoutMs:2500,
 leaseOwner:null,leaseExpiresAt:null,executionId:null,result:null,createdAt:timestamp,updatedAt:timestamp};
 try { await store.saveJob({id:'629',title:'Rust Vlog-like DAG isolated E2E',repository:'vlog',projectRoot:f.root,state:'ACTIVE',reviewEnabled:true,prNumber:0,createdAt:timestamp,updatedAt:timestamp,tasks:[coordinator]}); }
 finally {store.close();}
}
function once(f) {
 const child=spawnSync(binary,f.args,{env,encoding:'utf8',timeout:15000});
 assert.equal(child.status,0,child.stderr);
 return JSON.parse(child.stdout.trim()).report;
}
async function read(f) {
 const store=new SQLiteRelayStore(f.db);
 try{return await store.loadJob('629');}finally{store.close();}
}
test('Rust daemon drives Vlog-like DAG from Coordinator to Script/Model/Script with verified predecessor output',async()=>{
 const f=fixture();
 try{
  await seed(f);
  const first=once(f);assert.equal(first.tasksQueued,1,JSON.stringify(first));assert.equal(first.tasksSucceeded,1);
  let job=await read(f);
  assert.deepEqual(job.tasks.map(t=>t.state),['RUNNING','SUCCEEDED']);
  const second=once(f);assert.equal(second.tasksQueued,1,JSON.stringify(second));assert.equal(second.tasksSucceeded,1,JSON.stringify(second));
  job=await read(f);
  assert.equal(job.tasks[2].adapter,'codex');assert.equal(JSON.parse(job.tasks[2].input).predecessorOutputs.visioner.stage,'visioner');
  assert.equal(job.tasks[2].result.data.output.source,'visioner');
  const third=once(f);assert.equal(third.tasksQueued,1,JSON.stringify(third));assert.equal(third.tasksSucceeded,1);
  job=await read(f);
  assert.equal(JSON.parse(job.tasks[3].input).predecessorOutputs.director.stage,'director');
  assert.equal(job.tasks[3].result.data.output.predecessor,'director','Script consumed execution-bound predecessorOutputs');
  assert.equal(job.tasks[0].state,'SUCCEEDED','Coordinator must complete from terminal child evidence');
  assert.equal(job.state,'ACTIVE','No specialist Final Review or automatic user approval');
  assert.equal(once(f).tasksClaimed,0,'A restart must not repeat completed stages');
  assert.deepEqual(job.tasks.map(t=>t.state),Array(4).fill('SUCCEEDED'));
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
test('Native DAG refuses Model materialization with no trusted Router decision; never falsely finishes',async()=>{
 const f=fixture(false);
 try{
  await seed(f);once(f);
  const second=once(f);
  assert.match(second.blocked.join(' '),/explicit trusted Router decision/);
  const job=await read(f);
  assert.equal(job.tasks[0].state,'RUNNING');assert.equal(job.tasks.length,2);
 }finally{rmSync(f.root,{recursive:true,force:true});}
});

test('Native DAG rejects caller-supplied Coordinator output outside isolated root',async()=>{
 const f=fixture();
 try{
  await seed(f,join(tmpdir(),'relay-rust-output-escape','out.json'));
  const result=once(f);
  assert.match(result.blocked.join(' '),/DAG output path outside isolated root/);
  const job=await read(f);
  assert.equal(job.tasks.length,1,'unsafe DAG must not materialize a child');
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
