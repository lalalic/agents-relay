import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';

const target=process.env.CARGO_TARGET_DIR??resolve(import.meta.dirname,'../target');
const cli=join(target,'debug/relay-native-job');
const daemon=join(target,'debug/relay-native-daemon');
const dashboard=join(target,'debug/relay-native-dashboard');
const helper=join(target,'debug/relay-worker-helper');
function invoke(exe,args,env,expected=0){
 const p=spawnSync(exe,args,{env,encoding:'utf8',timeout:18000});
 assert.equal(p.status,expected,p.stderr||p.stdout);
 return expected===0?JSON.parse(p.stdout.trim()):p.stderr;
}
function fixture(){
 const home=mkdtempSync(join(tmpdir(),'rust-live-home-'));
 const root=join(home,'.local/state/agents-relay/rust-live');
 mkdirSync(root,{recursive:true,mode:0o700});
 writeFileSync(join(root,'.relay-rust-live-namespace-v1'),'rust-relay-owned-standalone-namespace-v1\n',{mode:0o600});
 mkdirSync(join(root,'test'));mkdirSync(join(root,'test/output'));
 const db=join(root,'relay.sqlite'),project=join(root,'test');
 const input=join(project,'input.md'),graph=join(project,'graph.mmd'),
  output=join(project,'output/result.json'),script=join(root,'worker.mjs'),
  manifest=join(root,'manifest.json');
 writeFileSync(input,'Generate actual result');
 writeFileSync(graph,'flowchart TD\nbuilder[agent:builder]\n');
 writeFileSync(script,[
  "import {readFileSync,writeFileSync} from 'node:fs';",
  "const r=JSON.parse(readFileSync(process.env.RELAY_TASK_REQUEST_PATH,'utf8'));",
  "writeFileSync(process.env.RELAY_RESULT_PATH,JSON.stringify({jobId:r.jobId,taskId:r.taskId,executionId:r.executionId,status:'COMPLETED',output:{verified:true}}));",
 ].join('\n'));
 writeFileSync(manifest,JSON.stringify({agents:{builder:{kind:'script',executable:process.execPath,args:[script]}}}));
 return {home,root,project,input,graph,output,manifest,db,
  env:{...process.env,HOME:home,RELAY_RUST_LIVE_MODE:'pilot-live',RELAY_RUST_EXPERIMENTAL_TEST_ONLY:'',RELAY_RUST_REVIEW_HOST_TOKEN:'isolated-test-review-host-token-1'}};
}
test('Live Rust namespace persists own real Jobs, real HTTP Dashboard, rejects production DB paths',async()=>{
 const f=fixture();let child;
 try{
  assert.equal(invoke(cli,['init','--db',f.db],f.env).initialized,true);
  const j=invoke(cli,['create','--db',f.db,'--project-root',f.project,
    '--graph-file',f.graph,'--input-file',f.input,'--output-path',f.output,
    '--title','Rust Dashboard pilot','--repository','rust-live','--request-key','test-key'],f.env);
  assert.equal(j.created,true);
  assert.equal(invoke(cli,['activate','--db',f.db,'--job-id',j.jobId],f.env).state,'ACTIVE');
  const tick=invoke(daemon,['--once','--db',f.db,'--manifest',f.manifest,'--helper',helper],f.env);
  assert.equal(tick.report.jobsCompleted,1);
  assert.equal(invoke(cli,['show','--db',f.db,'--job-id',j.jobId],f.env).job.state,'COMPLETED');
  const socket=createServer();await new Promise(ok=>socket.listen(0,'127.0.0.1',ok));
  const port=socket.address().port;await new Promise(ok=>socket.close(ok));
  child=spawn(dashboard,['--db',f.db,'--port',String(port)],{env:f.env,stdio:['ignore','pipe','pipe']});
  let ready=false;
  for(let i=0;i<50;i++){
    if(child.exitCode!==null)break;
    try{let r=await fetch('http://127.0.0.1:'+port+'/api/health');if(r.ok){ready=true;break;}}
    catch{}
    await new Promise(ok=>setTimeout(ok,50));
  }
  assert.ok(ready,'native HTTP dashboard did not start');
  const base='http://127.0.0.1:'+port;
  const r=await fetch(base+'/api/jobs');
  const content=await r.json();
  assert.equal(content.backend,'rust-native');
  assert.equal(content.jobs.length,1);
  assert.equal(content.jobs[0].state,'COMPLETED');
  const summary=await(await fetch(base+'/api/runtime-summary')).json();
  assert.deepEqual(summary,{
    activeJobs:0,runningTasks:0,workers:{chatgpt:0,codex:0},models:[],running:[]
  });
  const status=invoke(cli,['status','--host','127.0.0.1','--port',String(port)],f.env);
  assert.deepEqual(status,summary,'native CLI status must match Rust HTTP and Node summary schema');
  const statusLocalhost=invoke(cli,['status','--host','localhost','--port',String(port)],f.env);
  assert.deepEqual(statusLocalhost,summary);
  assert.match(invoke(cli,['status','--host','remote-host.example','--port',String(port)],f.env,2),
    /loopback/,'Remote status is not authenticated or implemented, must reject');

  assert.deepEqual({total:content.total,page:content.page,pageSize:content.pageSize,totalPages:content.totalPages},
    {total:1,page:1,pageSize:20,totalPages:1});
  assert.deepEqual(content.repositories,['rust-live']);
  assert.deepEqual(content.jobs[0].tasks.map(t=>t.state),['SUCCEEDED','SUCCEEDED']);
  assert.equal(content.jobs[0].tasks.some(t=>Object.hasOwn(t,'input')),false);
  const filtered=await(await fetch(base+'/api/jobs?q=rust+dashboard&status=completed&repo=rust-live&pageSize=1')).json();
  assert.equal(filtered.total,1);
  assert.equal(filtered.jobs[0].id,j.jobId);
  assert.equal(filtered.pageSize,1);
  const noMatch=await(await fetch(base+'/api/jobs?q=absent-title')).json();
  assert.equal(noMatch.total,0);
  assert.deepEqual(noMatch.jobs,[]);
  const html=await(await fetch(base+'/')).text();
  assert.match(html,/Rust Relay Live/);
  assert.match(html,/fetch\('api\/jobs'/);
  assert.equal((await fetch(base+'/api/jobs',{method:'POST'})).status,405);
  assert.equal((await fetch(base+'/api/jobs?q=%ZZ')).status,400);
  assert.equal((await fetch(base+'/api/jobs/%2e%2e')).status,404);
  assert.equal((await fetch(base+'/api/jobs/does-not-exist')).status,404);
  assert.equal((await fetch(base+'/api/jobs/'+j.jobId)).status,200);
  assert.equal((await fetch(base+'/api/events')).status,400);
  assert.equal((await fetch(base+'/api/events?job=bad%2Fid')).status,400);
  assert.deepEqual(await(await fetch(base+'/api/events?job=999999&task=missing')).json(),[],
    'unknown valid Job IDs follow the Node history API and return no events');
  assert.deepEqual(await(await fetch(base+'/api/events?job='+j.jobId+'&task='+content.jobs[0].tasks[0].id)).json(),[],
    'a known Job/Task with no retained event records returns an empty event array');
  const durableBefore=invoke(cli,['show','--db',f.db,'--job-id',j.jobId],f.env);
  assert.equal(durableBefore.job.state,'COMPLETED');
  const taskListUrl=base+'/api/jobs/'+j.jobId+'/tasks';
  const taskListResponse=await fetch(taskListUrl);
  assert.equal(taskListResponse.status,200);
  const taskList=await taskListResponse.json();
  assert.deepEqual(taskList,durableBefore.job.tasks,'Task list matches the Node Job snapshot Task array');
  const taskId=durableBefore.job.tasks[0].id;
  const taskDetailUrl=taskListUrl+'/'+taskId;
  assert.deepEqual(await(await fetch(taskDetailUrl)).json(),durableBefore.job.tasks[0]);
  assert.equal((await fetch(taskListUrl+'/',{method:'POST'})).status,405);
  assert.equal((await fetch(base+'/api/jobs/not-numeric/tasks')).status,404);
  assert.equal((await fetch(base+'/api/jobs/999999/tasks')).status,404);
  assert.equal((await fetch(taskListUrl+'/999999')).status,404);
  assert.equal((await fetch(taskListUrl+'/not-numeric')).status,404);
  assert.equal((await fetch(taskListUrl+'/')).status,404);
  assert.equal((await fetch(base+'/api/jobs/999999/tasks/1')).status,404);
  assert.equal((await fetch(base+'/api/jobs?status=completed')).status,200);
  const durableAfter=invoke(cli,['show','--db',f.db,'--job-id',j.jobId],f.env);
  assert.deepEqual(durableAfter,durableBefore);
  assert.deepEqual(await(await fetch(taskListUrl)).json(),taskList);
  const replay=invoke(daemon,['--once','--db',f.db,'--manifest',f.manifest,'--helper',helper],f.env);
  assert.equal(replay.report.tasksClaimed,0);
  assert.equal(replay.report.jobsCompleted,0);

  const active=invoke(cli,['create','--db',f.db,'--project-root',f.project,
    '--graph-file',f.graph,'--input-file',f.input,'--output-path',f.output,
    '--title','API read only active','--repository','rust-live','--request-key','active-test-key'],f.env);
  assert.equal(invoke(cli,['activate','--db',f.db,'--job-id',active.jobId],f.env).state,'ACTIVE');
  let activeBefore=invoke(cli,['show','--db',f.db,'--job-id',active.jobId],f.env);
  const activeTaskId=activeBefore.job.tasks[0].id;
  const previewTaskIndex=activeBefore.job.tasks.findIndex(task=>task.state==='QUEUED');
  assert.notEqual(previewTaskIndex,-1,'active fixture has a queued Task for the host Preview binding');
  const previewTaskId=activeBefore.job.tasks[previewTaskIndex].id;
  const previewExecutionId='review-preview-execution-1';
  const sqlLiteral=value=>`'${String(value).replaceAll("'","''")}'`;
  const seedPreviewSql=`UPDATE job_snapshot SET json=json_set(json,'$.tasks[${previewTaskIndex}].state','RUNNING','$.tasks[${previewTaskIndex}].executionId',${sqlLiteral(previewExecutionId)}) WHERE job_id=${sqlLiteral(active.jobId)};`;
  const seededPreview=spawnSync('sqlite3',[f.db,seedPreviewSql],{env:f.env,encoding:'utf8'});
  assert.equal(seededPreview.status,0,seededPreview.stderr||seededPreview.stdout);
  const previewUrl=base+'/api/review/preview/begin';
  const reviewHash='a'.repeat(64);
  const previewRequest={jobId:active.jobId,taskId:previewTaskId,executionId:previewExecutionId,
    revision:reviewHash,contentHash:reviewHash,revisionId:'revision-host-1',requestId:'request-host-1',
    idempotencyKey:'review-idempotency-1',previewId:'preview-host-1'};
  assert.equal((await fetch(previewUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(previewRequest)})).status,401,
    'host Preview binding requires an authenticated caller');
  assert.equal((await fetch(previewUrl,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer isolated-test-review-host-token-1'},body:JSON.stringify({...previewRequest,revision:17})})).status,400,
    'a non-string revision cannot silently fall back to the execution identity');
  assert.equal((await fetch(previewUrl,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer isolated-test-review-host-token-1'},body:JSON.stringify({jobId:active.jobId,taskId:previewTaskId,executionId:previewExecutionId,contentHash:reviewHash})})).status,409,
    'partial revision identity is rejected before binding');
  const previewResponse=await fetch(previewUrl,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer isolated-test-review-host-token-1'},body:JSON.stringify(previewRequest)});
  assert.equal(previewResponse.status,200);
  const previewBinding=await previewResponse.json();
  assert.equal(previewBinding.status,'bound');
  assert.equal(previewBinding.binding.jobId,active.jobId);
  assert.equal(previewBinding.binding.taskId,previewTaskId);
  assert.equal(previewBinding.binding.executionId,previewExecutionId);
  assert.equal(previewBinding.binding.invocation.status,'awaiting_decision');
  assert.equal(previewBinding.binding.invocation.revision,reviewHash);
  const firstPreviewSnapshot=invoke(cli,['show','--db',f.db,'--job-id',active.jobId],f.env);
  const replayedPreview=await(await fetch(previewUrl,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer isolated-test-review-host-token-1'},body:JSON.stringify(previewRequest)})).json();
  assert.equal(replayedPreview.binding.reused,true,'replayed Preview requests reuse the exact durable invocation');
  const replayedSnapshot=invoke(cli,['show','--db',f.db,'--job-id',active.jobId],f.env);
  assert.equal(replayedSnapshot.updatedAt,firstPreviewSnapshot.updatedAt,'an idempotent Preview replay does not write a new Job timestamp');
  assert.equal(replayedSnapshot.job.tasks[previewTaskIndex].state,'RUNNING','Preview binding does not claim a human decision or finish the Task');
  const stalePreview=await fetch(previewUrl,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer isolated-test-review-host-token-1'},body:JSON.stringify({...previewRequest,executionId:'stale-execution'})});
  assert.equal(stalePreview.status,409,'a stale execution cannot create a Preview binding');
  const forgedPreview=await fetch(previewUrl,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer wrong-token'},body:JSON.stringify(previewRequest)});
  assert.equal(forgedPreview.status,401);
  assert.equal((await fetch(previewUrl,{method:'POST',headers:{'content-type':'text/plain',authorization:'Bearer isolated-test-review-host-token-1'},body:JSON.stringify(previewRequest)})).status,415);
  activeBefore=invoke(cli,['show','--db',f.db,'--job-id',active.jobId],f.env);
  const historyEvents=[
    {id:'history-1',at:'2026-01-01T00:00:01.000Z',type:'task.started',message:'started'},
    {id:'history-2',at:'2026-01-01T00:00:02.000Z',type:'task.progress',message:'progress'},
    {id:'history-3',at:'2026-01-01T00:00:03.000Z',type:'task.completed',message:'receipt only'},
  ];
  for(const event of historyEvents){
    const payload=JSON.stringify({event_id:event.id,job_id:active.jobId,task_id:activeTaskId,
      type:event.type,message:event.message,timestamp:event.at});
    const sql=`INSERT INTO workflow_event_outbox(event_key,event_id,payload_json,state,created_at) VALUES (${sqlLiteral(event.id)},${sqlLiteral(event.id)},${sqlLiteral(payload)},'published',${sqlLiteral(event.at)});`;
    const seeded=spawnSync('sqlite3',[f.db,sql],{env:f.env,encoding:'utf8'});
    assert.equal(seeded.status,0,seeded.stderr||seeded.stdout);
  }
  const eventUrl=base+'/api/events?job='+active.jobId+'&task='+activeTaskId;
  const eventsBefore=await(await fetch(eventUrl)).json();
  assert.ok(Array.isArray(eventsBefore),'Task event endpoint returns a JSON event array');
  assert.deepEqual(eventsBefore.map(event=>event.event_id),['history-3','history-2','history-1']);
  assert.deepEqual(await(await fetch(base+'/api/events?job='+active.jobId)).json(),eventsBefore);
  assert.deepEqual(await(await fetch(base+'/api/events?job='+active.jobId+'&task=')).json(),eventsBefore,
    'an empty Task filter behaves like the Node Dashboard and selects all Job events');
  assert.deepEqual(await(await fetch(base+'/api/events?job='+active.jobId+'&task=missing')).json(),[]);
  assert.deepEqual((await(await fetch(eventUrl+'&limit=1')).json()).map(event=>event.event_id),['history-3']);
  assert.deepEqual(await(await fetch(eventUrl+'&order=asc')).json(),eventsBefore,
    'the Dashboard wrapper remains newest-first and ignores order');
  assert.equal((await(await fetch(eventUrl+'&limit=0')).json()).length,1);
  assert.equal((await(await fetch(eventUrl+'&limit=')).json()).length,1);
  assert.equal((await(await fetch(eventUrl+'&limit=invalid')).json()).length,3);
  assert.deepEqual(await(await fetch(eventUrl+'&after=1')).json(),eventsBefore,
    'the Dashboard wrapper ignores after because cursor pagination is not part of this route');
  assert.deepEqual(await(await fetch(eventUrl+'&limit=1.5')).json(),[],
    'fractional limits follow the Node wrapper error fallback');
  assert.equal(Object.hasOwn(eventsBefore[0],'status'),false,
    'a task.completed history receipt does not synthesize Task status');
  assert.deepEqual(invoke(cli,['show','--db',f.db,'--job-id',active.jobId],f.env),activeBefore,
    'history reads do not promote a task.completed receipt into lifecycle state');
  const activeResult=await(await fetch(base+'/api/jobs?q=read+only&status=ACTIVE&repo=rust-live')).json();
  assert.equal(activeResult.total,1);
  assert.equal(activeResult.jobs[0].state,'ACTIVE');
  const activeTasks=await(await fetch(base+'/api/jobs/'+active.jobId+'/tasks')).json();
  assert.deepEqual(activeTasks,activeBefore.job.tasks);
  assert.equal((await fetch(base+'/api/jobs/'+active.jobId+'/tasks/'+activeTasks[0].id)).status,200);
  assert.deepEqual(invoke(cli,['show','--db',f.db,'--job-id',active.jobId],f.env),activeBefore);
  const bothStates=await(await fetch(base+'/api/jobs?status=ACTIVE&status=COMPLETED&pageSize=1')).json();
  assert.equal(bothStates.total,2);
  assert.equal(bothStates.totalPages,2);
  assert.equal(bothStates.jobs[0].state,'ACTIVE');
  const lastPage=await(await fetch(base+'/api/jobs?status=ACTIVE&status=COMPLETED&pageSize=1&page=99')).json();
  assert.equal(lastPage.page,2);
  assert.equal(lastPage.jobs[0].state,'COMPLETED');

  child.kill('SIGTERM');
  await new Promise(ok=>child.once('exit',ok));
  child=spawn(dashboard,['--db',f.db,'--port',String(port)],{env:f.env,stdio:['ignore','pipe','pipe']});
  let restarted=false;
  for(let i=0;i<50;i++){
    if(child.exitCode!==null)break;
    try{const response=await fetch(base+'/api/health');if(response.ok){restarted=true;break;}}
    catch{}
    await new Promise(ok=>setTimeout(ok,50));
  }
  assert.ok(restarted,'native HTTP dashboard did not restart');
  const restartedPreview=await(await fetch(previewUrl,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer isolated-test-review-host-token-1'},body:JSON.stringify(previewRequest)})).json();
  assert.equal(restartedPreview.binding.reused,true,'the authenticated host Preview binding remains durable across dashboard restart');
  assert.deepEqual(await(await fetch(eventUrl)).json(),eventsBefore);
  assert.deepEqual(invoke(cli,['show','--db',f.db,'--job-id',active.jobId],f.env),activeBefore);
  assert.deepEqual(await(await fetch(taskListUrl)).json(),taskList);
  assert.deepEqual(await(await fetch(taskDetailUrl)).json(),durableBefore.job.tasks[0]);
  const restartedJobs=(await(await fetch(base+'/api/jobs')).json()).jobs;
  assert.equal(restartedJobs.find(job=>job.id===j.jobId).state,'COMPLETED');
  assert.equal(restartedJobs.find(job=>job.id===active.jobId).state,'ACTIVE');
  const decisionUrl=base+'/api/review/preview/decision';
  const humanDecision={jobId:active.jobId,taskId:previewTaskId,executionId:previewExecutionId,
    invocationId:previewExecutionId,revision:reviewHash,contentHash:reviewHash,revisionId:'revision-host-1',
    requestId:'request-host-1',idempotencyKey:'review-idempotency-1',previewId:'preview-host-1',
    decision:'approved',feedback:'',comments:[],
    eventId:'human-review-approval-1',deliveredAt:'2026-11-15T14:30:00.000Z'};
  const decisionPost={method:'POST',headers:{'content-type':'application/json',authorization:'Bearer isolated-test-review-host-token-1'},body:JSON.stringify(humanDecision)};
  assert.equal((await fetch(decisionUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(humanDecision)})).status,401,
    'human decisions require an authenticated host');
  const acceptedDecision=await fetch(decisionUrl,decisionPost);
  assert.equal(acceptedDecision.status,200);
  assert.equal((await acceptedDecision.json()).receipt.outcome,'accepted');
  const afterDecision=invoke(cli,['show','--db',f.db,'--job-id',active.jobId],f.env);
  const decidedTask=afterDecision.job.tasks.find(task=>task.id===previewTaskId);
  assert.equal(decidedTask.state,'RUNNING','an approval receipt cannot complete or resume a Task by itself');
  assert.equal(decidedTask.interactiveInvocation.status,'approved');
  assert.notEqual(afterDecision.job.state,'COMPLETED');
  assert.equal((await fetch(decisionUrl,decisionPost).then(response=>response.json())).receipt.outcome,'duplicate');
  const forgedRevision='b'.repeat(64);
  assert.equal((await fetch(decisionUrl,{...decisionPost,body:JSON.stringify({...humanDecision,
    revision:forgedRevision,contentHash:forgedRevision,revisionId:'revision-forged',requestId:'request-forged',
    idempotencyKey:'review-idempotency-forged'})})).status,409,
    'a forged revision cannot decide the current invocation');
  child.kill('SIGTERM');
  await new Promise(ok=>child.once('exit',ok));
  child=spawn(dashboard,['--db',f.db,'--port',String(port)],{env:f.env,stdio:['ignore','pipe','pipe']});
  let decisionRestarted=false;
  for(let i=0;i<50;i++){
    if(child.exitCode!==null)break;
    try{const response=await fetch(base+'/api/health');if(response.ok){decisionRestarted=true;break;}}
    catch{}
    await new Promise(ok=>setTimeout(ok,50));
  }
  assert.ok(decisionRestarted,'native HTTP dashboard did not restart after host decision');
  assert.equal((await fetch(decisionUrl,decisionPost).then(response=>response.json())).receipt.outcome,'duplicate',
    'host decision deduplication survives dashboard restart');
  // Explicit live mode never accepts any other filesystem location.
  const outside=join(f.home,'elsewhere.sqlite');
  assert.match(invoke(cli,['init','--db',outside],f.env,2),/live namespace|path/i);
 }finally{
  if(child?.exitCode===null){child.kill('SIGTERM');await new Promise(ok=>child.once('exit',ok));}
  rmSync(f.home,{recursive:true,force:true});
 }
});
