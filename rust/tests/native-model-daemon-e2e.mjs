import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,readdirSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {SQLiteRelayStore} from '../../dist/relay-store.js';
import {DatabaseSync} from 'node:sqlite';
const binary=resolve(import.meta.dirname,'../target/debug/relay-native-daemon');
const helper=resolve(import.meta.dirname,'../target/debug/relay-worker-helper');
const fixed='2026-11-13T20:00:00.000Z';
const env={...process.env,RELAY_RUST_EXPERIMENTAL_TEST_ONLY:'isolated-test'};
const driver=`import {readFileSync,writeFileSync} from 'node:fs';
const request=JSON.parse(readFileSync(process.env.RELAY_TASK_REQUEST_PATH,'utf8'));
const mode=process.argv[2];
if(mode==='missing')process.exit(0);
const event={type:'task.completed',jobId:request.jobId,taskId:request.taskId,
 executionId:request.executionId,leaseOwner:request.leaseOwner,attempt:request.attempt,
 adapter:request.adapter,routing:request.routing,workerSelection:request.workerSelection,status:'COMPLETED',
 summary:'Model worker submitted terminal task event',
 output:{model:request.routing.model,receivedInput:request.input}};
if(mode==='stale')event.executionId='previous-execution';
if(mode==='wrong-route')event.routing={...request.routing,model:'different-model'};
if(mode==='wrong-type')event.type='process.exited';
writeFileSync(process.env.RELAY_RESULT_PATH,JSON.stringify(event));
`;
function fixture(mode='ok'){
 const root=mkdtempSync(join(tmpdir(),'relay-rust-authority-'));
 const db=join(root,'relay.sqlite'),manifest=join(root,'manifest.json'),worker=join(root,'model-worker.mjs');
 writeFileSync(join(root,'.relay-rust-authority-isolated-test'),'test-only');
 writeFileSync(worker,driver);
 writeFileSync(manifest,JSON.stringify({agents:{alpha:{kind:'model',executable:process.execPath,args:[worker,mode]}}}));
 return {root,db,manifest,worker,args:['--once','--db',db,'--manifest',manifest,'--helper',helper]};
}
function task(){return {jobId:'91',id:'101',kind:'work',agentName:'alpha',parentTaskId:null,dependencies:[],
 adapter:'codex',capabilities:['model'],
 workerSelection:{workerId:'test-codex',adapter:'codex',capabilities:['model'],selectedBy:'worker-router',selectedAt:fixed},
 routing:{provider:'test-provider',model:'test-model',decidedBy:'model-router',decidedAt:fixed},
 input:'Build a short outline for my task',state:'QUEUED',attempt:0,maxAttempts:3,leaseOwner:null,
 leaseExpiresAt:null,executionId:null,threadId:null,result:null,error:null,timeoutMs:5000,
 createdAt:fixed,updatedAt:fixed};}
async function seed(f,t){
 const store=new SQLiteRelayStore(f.db);
 try{await store.saveJob({id:'91',title:'isolated native model',repository:'test',projectRoot:f.root,
  state:'ACTIVE',reviewEnabled:true,prNumber:0,createdAt:fixed,updatedAt:fixed,tasks:[t]});}
 finally{store.close();}
}
function execute(f){
 const result=spawnSync(binary,f.args,{encoding:'utf8',timeout:10000,env});
 assert.equal(result.status,0,result.stderr);
 return JSON.parse(result.stdout.trim()).report;
}
async function run(mode='ok',mutate){
 const f=fixture(mode);let store;
 try{
  const original=task();if(mutate)mutate(original,f);
  await seed(f,original);
  const report=execute(f);
  store=new SQLiteRelayStore(f.db);
  const job=await store.loadJob('91');
  return {report,job,db:f.db};
 }finally{store?.close();rmSync(f.root,{recursive:true,force:true});}
}
test('single node: configured Model executor reads immutable Task input, reports matching terminal event',async()=>{
 const {report,job}=await run('ok');
 assert.equal(report.tasksClaimed,1,JSON.stringify(report));
 assert.equal(report.tasksSucceeded,1,JSON.stringify(report));
 assert.equal(job.tasks[0].state,'SUCCEEDED');
 assert.equal(job.tasks[0].result.data.output.model,'test-model');
 assert.equal(job.tasks[0].result.data.output.receivedInput,'Build a short outline for my task');
 assert.match(job.tasks[0].result.summary,/Model worker submitted/);
 assert.equal(job.state,'ACTIVE','Model terminal event must not fabricate Final Review approval');
});
for(const mode of ['missing','stale','wrong-route','wrong-type']){
 test(`model process exit 0 with ${mode} terminal evidence never succeeds`,async()=>{
  const {report,job}=await run(mode);
  assert.equal(report.tasksClaimed,1);
  assert.equal(report.tasksSucceeded,0);
  assert.equal(report.tasksFailed,1);
  assert.equal(job.tasks[0].state,'FAILED');
  assert.equal(job.tasks[0].result,null);
  assert.match(job.tasks[0].error,/receipt|event|terminal|route/i);
 });
}
test('model executor cannot run without durable provider/model routing',async()=>{
 const {report,job}=await run('ok',t=>{delete t.routing;});
 assert.equal(report.tasksClaimed,0);
 assert.match(report.blocked.join(' '),/Model Task missing routing/);
 assert.equal(job.tasks[0].state,'QUEUED');
});
test('Model worker cannot impersonate Script manifest role',async()=>{
 const {report,job}=await run('ok',(t,f)=>{
  writeFileSync(f.manifest,JSON.stringify({agents:{alpha:{kind:'script',executable:process.execPath,args:[f.worker]}}}));
 });
 assert.equal(report.tasksClaimed,0);
 assert.match(report.blocked.join(' '),/kind does not match/);
 assert.equal(job.tasks[0].state,'QUEUED');
});
test('Review Agent is never self-approved through ordinary Model completion',async()=>{
 const {report,job}=await run('ok',t=>{t.agentName='job-acceptance-reviewer';});
 assert.equal(report.tasksClaimed,0);
 assert.equal(job.tasks[0].state,'QUEUED');
 assert.equal(job.state,'ACTIVE');
});

test('Model Worker Router mismatch is not converted to Codex execution',async()=>{
 const {report,job}=await run('ok',t=>{t.workerSelection.adapter='chatgpt';});
 assert.equal(report.tasksClaimed,0);
 assert.match(report.blocked.join(' '),/Worker Router selection/);
 assert.equal(job.tasks[0].state,'QUEUED');
});

test('denied Model claim cleans its private request file on repeated ticks',async()=>{
 const f=fixture('ok');let store;
 try{
  const t=task();t.agentName='job-acceptance-reviewer';
  // Keep a configured executor to reach the Graph claim gate.
  writeFileSync(f.manifest,JSON.stringify({agents:{'job-acceptance-reviewer':{
   kind:'model',executable:process.execPath,args:[f.worker,'ok']}}}));
  await seed(f,t);
  for(let i=0;i<3;i++){
   const report=execute(f);
   assert.equal(report.tasksClaimed,0);
   assert.match(report.blocked.join(' '),/not eligible/);
  }
  const dir=join(f.root,'.relay-rust-native-executions','91','101');
  assert.equal(existsSync(dir),true);
  assert.deepEqual(readdirSync(dir),[], 'rejected Model launches cannot accumulate request files');
  store=new SQLiteRelayStore(f.db);
  assert.equal((await store.loadJob('91')).tasks[0].state,'QUEUED');
 }finally{store?.close();rmSync(f.root,{recursive:true,force:true});}
});
