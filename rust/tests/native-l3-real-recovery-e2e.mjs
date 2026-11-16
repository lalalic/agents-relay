import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,realpathSync,rmSync,chmodSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

const target=resolve(process.env.CARGO_TARGET_DIR??join(import.meta.dirname,'../target'));
const cli=join(target,'debug/relay-native-job');
const helper=join(target,'debug/relay-worker-helper');
const app=resolve(import.meta.dirname,'../..');
const call=(bin,args,env,timeout=35000)=>spawnSync(bin,args,{encoding:'utf8',env,timeout,maxBuffer:8*1024*1024});

for(const scenario of [
 {failedAgent:'designer',finalReview:false},
 {failedAgent:'designer',finalReview:true},
 {failedAgent:'job-acceptance-reviewer',finalReview:true},
]) test(`L3 physical ${scenario.failedAgent} failure + exact Troubleshooter recovery, Final Review ${scenario.finalReview}`,()=>{
 const {failedAgent,finalReview}=scenario;
 const home=realpathSync(mkdtempSync('/tmp/relay-l3-native-recovery-'));
 const repo=join(home,'Workspace/neo/l3-failure');
 const run=join(repo,'runs/l3');
 const root=join(home,'.local/state/agents-relay/canonical-rust');
 const db=join(home,'.agents-relay/relay.sqlite');
 try{
  for(const p of [run,root,join(home,'.agents-relay'),join(home,'.config/neo')])mkdirSync(p,{recursive:true});
  chmodSync(root,0o700);
  writeFileSync(join(root,'.canonical-relay-owner-v1'),'canonical-rust-operator-approved-v1\n');
  writeFileSync(join(home,'.config/neo/workspace.json'),JSON.stringify({schemaVersion:1,neoRoot:join(home,'Workspace/neo')}));
  assert.equal(call('git',['-C',repo,'init','-q'],process.env).status,0);
  const sql=new DatabaseSync(db);
  sql.exec(`CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL);
   CREATE TABLE source_registry(job_id TEXT PRIMARY KEY,source_file TEXT NOT NULL UNIQUE,repository TEXT NOT NULL,pr_number INTEGER NOT NULL);
   CREATE TABLE relay_meta(scope_job_id TEXT NOT NULL REFERENCES source_registry(job_id),key TEXT,value TEXT,PRIMARY KEY(scope_job_id,key));
   CREATE TABLE sequences(repository TEXT,kind TEXT,value INTEGER,PRIMARY KEY(repository,kind));
   INSERT INTO sequences VALUES('*','job',631); INSERT INTO sequences VALUES('*','task',1873);`);
  sql.close();chmodSync(db,0o600);
  const graph=join(repo,'graph.mmd'),objective=join(run,'objective.md'),input=join(run,'input.md'),output=join(run,'result.json');
  writeFileSync(graph,'flowchart TD\n A[agent:source] --> B[agent:designer]\n B --> C[agent:face]\n');
  writeFileSync(objective,'Recover failed Designer using trusted Troubleshooter and original Task ID');
  writeFileSync(input,'3-Task DAG requiring physically successful recovery');
  const failMarker=join(root,'l3-fail-once');writeFileSync(failMarker,'fail once');
  const worker=join(repo,'worker.mjs');
  writeFileSync(worker,`import {readFileSync,writeFileSync,existsSync,unlinkSync} from 'node:fs';
const req=JSON.parse(readFileSync(process.env.RELAY_TASK_REQUEST_PATH,'utf8'));
if(req.agentName==='designer' && existsSync(process.env.FAIL_ONCE_MARKER)){
 unlinkSync(process.env.FAIL_ONCE_MARKER);process.exit(17);
}
writeFileSync(process.env.RELAY_RESULT_PATH,JSON.stringify({type:'task.completed',jobId:req.jobId,
 taskId:req.taskId,executionId:req.executionId,leaseOwner:req.leaseOwner,attempt:req.attempt,
 adapter:req.adapter,status:'COMPLETED',summary:'physical Worker verified',output:{verified:true,agent:req.agentName}}));
`);
  const repair=join(repo,'troubleshooter.mjs');
  writeFileSync(repair,`import {readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const req=JSON.parse(readFileSync(process.env.RELAY_TASK_REQUEST_PATH,'utf8'));
const parent=req.input.match(/Original task: (\\d+)/)?.[1];
if(!parent)throw new Error('Troubleshooter input missing original numeric Task identity');
const result=spawnSync(process.env.RUST_CLI,['task','recover',
 '--db',process.env.CANONICAL_DB,'--repo','l3-failure','--id',req.jobId,
 '--task-id',parent,'--recovery-task-id',req.taskId,
 '--failure-kind','task_failure','--reason','A real Designer Worker exited nonzero',
 '--evidence','Designer first execution physical exit code 17'],
 {encoding:'utf8',env:process.env,timeout:15000});
if(result.status!==0)throw new Error('Rust Graph refused recovery: '+result.stderr);
const committed=JSON.parse(result.stdout);
if(committed.id!==parent||committed.state!=='QUEUED')throw new Error('original Task not reopened');
writeFileSync(process.env.RELAY_RESULT_PATH,JSON.stringify({type:'task.completed',
 jobId:req.jobId,taskId:req.taskId,executionId:req.executionId,leaseOwner:req.leaseOwner,
 attempt:req.attempt,adapter:'codex',routing:req.routing,workerSelection:req.workerSelection,
 status:'COMPLETED',summary:'Troubleshooter committed exact Graph recovery',
 output:{recovered:parent,taskId:req.taskId}}));
`);
  const route={provider:'openai',model:'fixture',decidedBy:'native-test',decidedAt:'2026-11-16T20:00:00Z'};
  const selection={adapter:'codex',workerId:'test-worker',selectedBy:'native-test',selectedAt:'2026-11-16T20:00:00Z'};
  const agents={};
  for(const name of ['source','designer','face'])agents[name]={kind:'script',executable:process.execPath,args:[worker],env:{FAIL_ONCE_MARKER:failedAgent===name?failMarker:join(root,'not-a-failing-worker')}};
  agents.troubleshooter={kind:'model',executable:process.execPath,args:[repair],
   env:{HOME:home,RUST_CLI:cli,CANONICAL_DB:db},routing:route,workerSelection:selection,
   promptCli:join(app,'dist/cli.js'),promptNode:process.execPath};
  if(finalReview){
   const reviewer=join(repo,'reviewer.mjs');
   writeFileSync(reviewer,`import {readFileSync,writeFileSync,existsSync,unlinkSync} from 'node:fs';
const req=JSON.parse(readFileSync(process.env.RELAY_TASK_REQUEST_PATH,'utf8'));
if(req.agentName!=='job-acceptance-reviewer')throw new Error('wrong Final Reviewer agent');
if(existsSync(process.env.REVIEW_FAIL_ONCE_MARKER)){
 unlinkSync(process.env.REVIEW_FAIL_ONCE_MARKER); process.exit(17);
}
if(!/^[a-f0-9]{40}$/.test(req.reviewHeadSha))throw new Error('missing immutable HEAD');
writeFileSync(process.env.RELAY_RESULT_PATH,JSON.stringify({type:'task.completed',jobId:req.jobId,
 taskId:req.taskId,executionId:req.executionId,leaseOwner:req.leaseOwner,attempt:req.attempt,
 adapter:req.adapter,routing:req.routing,workerSelection:req.workerSelection,status:'COMPLETED',
 summary:'verified reviewed local recovery',output:{verdict:'approved',
 head_sha:req.reviewHeadSha,findings:[]}}));
`);
   agents['job-acceptance-reviewer']={kind:'model',executable:process.execPath,args:[reviewer],
    env:{REVIEW_FAIL_ONCE_MARKER:failedAgent==='job-acceptance-reviewer'?failMarker:join(root,'not-a-failing-reviewer')},
    routing:route,workerSelection:selection,promptCli:join(app,'dist/cli.js'),promptNode:process.execPath};
   assert.equal(call('git',['-C',repo,'add','-A'],process.env).status,0);
   const commit=call('git',['-c','user.name=Rust L3','-c','user.email=rust@localhost',
    '-C',repo,'commit','-q','-m','l3: repository artifacts prepared'],process.env);
   assert.equal(commit.status,0,commit.stderr);
  }
  writeFileSync(join(root,'manifest.json'),JSON.stringify({agents}));
  const env={...process.env,HOME:home,RELAY_RUST_LIVE_MODE:'canonical-live'};
  const created=call(cli,['job','create','--db',db,'--repo','l3-failure','--project-root',repo,
   '--title','Native L3 Fault Recovery','--objective-file',objective,'--coordinator-graph-file',graph,
   '--coordinator-input-file',input,'--coordinator-output-path',output,'--coordinator-project-root',repo,
   '--coordinator-workspace-root',join(home,'Workspace/neo'),'--coordinator-shared-root',join(home,'Workspace/neo'),
   ...(finalReview?[]:['--no-review']),'--no-github'],env);
  assert.equal(created.status,0,created.stderr);
  const jobId=JSON.parse(created.stdout).jobId;
  const coordinatorTaskId=JSON.parse(created.stdout).taskId;
  const started=call(cli,['job','run','--db',db,'--repo','l3-failure','--id',jobId,
   '--task-id',coordinatorTaskId,'--foreground','--no-github',
   '--manifest',join(root,'manifest.json'),'--helper',helper,'--interval-ms','100',
   '--max-ticks','35','--concurrency','4'],env,30000);
  if(started.status!==0){
   const debug=new DatabaseSync(db);
   const rec=debug.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get(jobId);
   console.error('FAILED_RECOVERY_SNAPSHOT',JSON.stringify(JSON.parse(rec.json).tasks.map(t=>({id:t.id,title:t.title,state:t.state,attempt:t.attempt,error:t.error,resolution:t.resolution,parentTaskId:t.parentTaskId,result:t.result}))).slice(0,8000));
   console.error('FAILED_RECOVERY_TRACE',started.stdout.slice(0,8000));
   debug.close();
  }
  assert.equal(started.status,0,started.stderr+'\n'+started.stdout.slice(-4400));
  const sqlite=new DatabaseSync(db);
  const record=JSON.parse(sqlite.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get(jobId).json);
  const recovered=record.tasks.find(t=>t.agentName===failedAgent);
  const trbl=record.tasks.find(t=>t.agentName==='troubleshooter');
  assert.ok(trbl,JSON.stringify(record.tasks.map(t=>[t.id,t.title,t.state])));
  assert.ok(recovered,'failed original agent must still be present');
  assert.match(trbl.id,/^\d+$/);
  assert.equal(trbl.parentTaskId,recovered.id);
  assert.equal(trbl.state,'SUCCEEDED');
  assert.equal(recovered.state,'SUCCEEDED');
  assert.equal(recovered.resolution.path,'exact_original_retry');
  assert.equal(recovered.resolution.recoveryExecutionId,trbl.executionId);
  assert.equal(recovered.resolution.owner,'troubleshooter');
  assert.equal(recovered.resolution.targetTaskId,recovered.id);
  assert.ok(recovered.attempt>=2,'original Task truly ran a new physical generation');
  assert.equal(record.state,'COMPLETED');
  assert.equal(record.tasks.filter(t=>t.agentName==='troubleshooter').length,1);
  if(finalReview){
   const reviewer=record.tasks.find(t=>t.agentName==='job-acceptance-reviewer');
   assert.equal(reviewer?.state,'SUCCEEDED','repaired work still needs a real Final Review generation');
   assert.equal(record.review?.outcome,'approved');
   assert.equal(record.review?.headSha,reviewer.reviewHeadSha);
   assert.ok(record.review.headSha.length>=40);
  }else{
   assert.equal(record.reviewEnabled,false);
   assert.equal(record.review,undefined);
  }
  assert.ok(!existsSync(failMarker),'first failure was physically triggered');
  assert.equal(sqlite.prepare('PRAGMA quick_check').get().quick_check,'ok');
  sqlite.close();
 } finally {if(process.env.RELAY_KEEP_RECOVERY_TEST_ROOT==='1') console.error('KEPT_RECOVERY_FIXTURE',home); else rmSync(home,{recursive:true,force:true});}
});
