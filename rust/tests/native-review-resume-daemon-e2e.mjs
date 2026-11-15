import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {SQLiteRelayStore} from '../../dist/relay-store.js';
const binary=resolve(import.meta.dirname,'../target/debug/relay-native-daemon');
const helper=resolve(import.meta.dirname,'../target/debug/relay-worker-helper');
const fixtureTool=resolve(import.meta.dirname,'../target/debug/examples/interop_fixture');
const t0='2026-11-13T20:00:00.000Z';
const env={...process.env,RELAY_RUST_EXPERIMENTAL_TEST_ONLY:'isolated-test'};
const script=`printf '{"jobId":"%s","taskId":"%s","executionId":"%s","status":"COMPLETED","output":{"review":"genuinely-authorized"}}' "$RELAY_JOB_ID" "$RELAY_TASK_ID" "$RELAY_EXECUTION_ID" > "$RELAY_RESULT_PATH"`;
function fixture(modelRevision=false){
 const root=mkdtempSync(join(tmpdir(),'relay-rust-authority-'));
 const db=join(root,'relay.sqlite'),manifest=join(root,'manifest.json');
 writeFileSync(join(root,'.relay-rust-authority-isolated-test'),'test-only');
 const agents={alpha:{kind:'script',executable:'/bin/sh',args:['-c',script]}};
 if(modelRevision){
  const modelWorker=join(root,'revision-worker.mjs');
  const promptCli=join(root,'prompt-cli.js');
  writeFileSync(modelWorker,`import {readFileSync,writeFileSync} from 'node:fs';
const request=JSON.parse(readFileSync(process.env.RELAY_TASK_REQUEST_PATH,'utf8'));
writeFileSync(process.env.RELAY_RESULT_PATH,JSON.stringify({type:'task.completed',jobId:request.jobId,
 taskId:request.taskId,executionId:request.executionId,leaseOwner:request.leaseOwner,attempt:request.attempt,
 adapter:request.adapter,routing:request.routing,workerSelection:request.workerSelection,status:'COMPLETED',
 summary:'Model revision submitted without a second human Preview',output:{edited:true}}));`);
  writeFileSync(promptCli,'');writeFileSync(join(root,'model-routing.js'),'');
  agents.alpha={kind:'model',executable:process.execPath,args:[modelWorker],
   routing:{provider:'test-provider',model:'test-model',decidedBy:'test-router',decidedAt:t0},
   workerSelection:{workerId:'test-model-worker',adapter:'codex',selectedBy:'test-router',selectedAt:t0,capabilities:['model']},
   promptCli,promptNode:process.execPath};
 }
 writeFileSync(manifest,JSON.stringify({agents}));
 const args=['--once','--db',db,'--manifest',manifest,'--helper',helper];
 return {root,db,args};
}
async function seed(f){
 const store=new SQLiteRelayStore(f.db);
 const task={jobId:'629',id:'1720',kind:'work',agentName:'alpha',title:'Director',parentTaskId:null,
  dependencies:[],adapter:'script',capabilities:['script'],input:'Review-only test',state:'AWAITING_DECISION',
  attempt:1,maxAttempts:3,leaseOwner:null,leaseExpiresAt:null,executionId:null,threadId:null,
  result:null,error:null,timeoutMs:3000,createdAt:t0,updatedAt:t0,
  interactiveInvocation:{invocationId:'review-1',executionId:'exec-1',revision:'revision-1',status:'awaiting_decision',boundAt:t0}};
 try{await store.saveJob({id:'629',title:'Review native gated test',repository:'vlog',projectRoot:f.root,state:'ACTIVE',reviewEnabled:true,prNumber:0,createdAt:t0,updatedAt:t0,tasks:[task]});}
 finally{store.close();}
}
async function read(f){const store=new SQLiteRelayStore(f.db);try{return await store.loadJob('629');}finally{store.close();}}
function tick(f){const p=spawnSync(binary,f.args,{encoding:'utf8',env,timeout:12000});assert.equal(p.status,0,p.stderr);return JSON.parse(p.stdout.trim()).report;}
test('Native daemon does not treat a plausible approval field as an authenticated Review decision',async()=>{
 const f=fixture();try{
  await seed(f);const store=new SQLiteRelayStore(f.db);
  await store.mutateJob('629',job=>{job.tasks[0].interactiveInvocation.status='approved';return job;});store.close();
  const first=tick(f);assert.equal(first.reviewsResumed,0);assert.equal(first.tasksClaimed,0);
  assert.match(first.blocked.join(' '),/ledger not accepted|not confirmed/i);
  assert.equal((await read(f)).tasks[0].state,'AWAITING_DECISION');
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
test('Durably accepted approval resumes the SAME Task and executes one verified native Worker',async()=>{
 const f=fixture();try{
  await seed(f);
  const d={jobId:'629',taskId:'1720',executionId:'exec-1',invocationId:'review-1',revision:'revision-1',decision:'approved',feedback:'LGTM',comments:null,idempotencyKey:'demo',eventId:'event-1',deliveredAt:'2026-11-13T20:00:01.000Z'};
  const accepted=spawnSync(fixtureTool,['review',f.db,'629',d.deliveredAt,JSON.stringify(d)],{encoding:'utf8',env});
  assert.equal(accepted.status,0,accepted.stderr);assert.equal(JSON.parse(accepted.stdout).outcome,'accepted');
  const resumed=tick(f);assert.equal(resumed.reviewsResumed,1,JSON.stringify(resumed));assert.equal(resumed.tasksSucceeded,1,JSON.stringify(resumed));
  const job=await read(f);assert.equal(job.tasks.length,1);assert.equal(job.tasks[0].state,'SUCCEEDED');
  assert.equal(job.tasks[0].result.data.output.review,'genuinely-authorized');
  assert.equal(tick(f).tasksClaimed,0,'same durable Task must not replay after restart');
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
test('Changes requested binds the same Task to its trusted Model route and rejects completion without a second Preview',async()=>{
 const f=fixture(true);try{
  await seed(f);
  const d={jobId:'629',taskId:'1720',executionId:'exec-1',invocationId:'review-1',revision:'revision-1',decision:'changes_requested',feedback:'Need conflict',comments:null,idempotencyKey:'demo',eventId:'event-2',deliveredAt:'2026-11-13T20:00:01.000Z'};
  const accepted=spawnSync(fixtureTool,['review',f.db,'629',d.deliveredAt,JSON.stringify(d)],{encoding:'utf8',env});
  assert.equal(accepted.status,0,accepted.stderr);
  const ticked=tick(f);assert.equal(ticked.tasksClaimed,1,JSON.stringify(ticked));assert.equal(ticked.reviewsResumed,1);
  assert.equal(ticked.reviewRevisionRoutes,1,JSON.stringify(ticked));
  assert.equal(ticked.tasksSucceeded,0,'a Model receipt cannot approve its own revision');
  assert.equal(ticked.tasksFailed,1,'without a new human Preview the revision must not complete');
  const task=(await read(f)).tasks[0];
  assert.equal(task.id,'1720');assert.equal(task.state,'FAILED');assert.equal(task.adapter,'codex');
  assert.equal(task.routing.model,'test-model');assert.equal(task.workerSelection.workerId,'test-model-worker');
  assert.equal(JSON.parse(task.input).reviewRevision.status,'changes_requested');
  assert.equal(task.interactiveInvocation.status,'changes_requested');
  assert.equal(task.result,null,'Request Changes is not approval or task completion');
  assert.equal(tick(f).tasksClaimed,0,'restart must not replay the same rejected revision receipt');
 }finally{rmSync(f.root,{recursive:true,force:true});}
});

test('Forged approved status on already-queued Task cannot claim or complete work',async()=>{
 const f=fixture();try{
  await seed(f);const store=new SQLiteRelayStore(f.db);
  await store.mutateJob('629',job=>{job.tasks[0].state='QUEUED';job.tasks[0].interactiveInvocation.status='approved';return job;});store.close();
  const observed=tick(f);assert.equal(observed.tasksClaimed,0);assert.equal(observed.tasksSucceeded,0);
  assert.match(observed.blocked.join(' '),/Review approval ledger unavailable|not backed by durable host decision/);
  assert.equal((await read(f)).tasks[0].state,'QUEUED');
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
