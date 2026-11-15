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
  env:{...process.env,HOME:home,RELAY_RUST_LIVE_MODE:'pilot-live',RELAY_RUST_EXPERIMENTAL_TEST_ONLY:''}};
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
  assert.equal((await fetch(base+'/api/events?job='+j.jobId)).status,400);
  assert.equal((await fetch(base+'/api/events?job='+j.jobId+'&task=missing')).status,404);
  assert.equal((await fetch(base+'/api/events?job='+j.jobId+'&task='+content.jobs[0].tasks[0].id+'&limit=61')).status,400);
  const eventUrl=base+'/api/events?job='+j.jobId+'&task='+content.jobs[0].tasks[0].id;
  const eventsBefore=await(await fetch(eventUrl)).json();
  assert.ok(Array.isArray(eventsBefore),'Task event endpoint returns a JSON event array');
  const durableBefore=invoke(cli,['show','--db',f.db,'--job-id',j.jobId],f.env);
  assert.equal(durableBefore.job.state,'COMPLETED');
  assert.equal((await fetch(base+'/api/jobs?status=completed')).status,200);
  assert.deepEqual(await(await fetch(eventUrl)).json(),eventsBefore);
  const durableAfter=invoke(cli,['show','--db',f.db,'--job-id',j.jobId],f.env);
  assert.deepEqual(durableAfter,durableBefore);
  const replay=invoke(daemon,['--once','--db',f.db,'--manifest',f.manifest,'--helper',helper],f.env);
  assert.equal(replay.report.tasksClaimed,0);
  assert.equal(replay.report.jobsCompleted,0);

  const active=invoke(cli,['create','--db',f.db,'--project-root',f.project,
    '--graph-file',f.graph,'--input-file',f.input,'--output-path',f.output,
    '--title','API read only active','--repository','rust-live','--request-key','active-test-key'],f.env);
  assert.equal(invoke(cli,['activate','--db',f.db,'--job-id',active.jobId],f.env).state,'ACTIVE');
  const activeBefore=invoke(cli,['show','--db',f.db,'--job-id',active.jobId],f.env);
  const activeResult=await(await fetch(base+'/api/jobs?q=read+only&status=ACTIVE&repo=rust-live')).json();
  assert.equal(activeResult.total,1);
  assert.equal(activeResult.jobs[0].state,'ACTIVE');
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
  assert.deepEqual(await(await fetch(eventUrl)).json(),eventsBefore);
  const restartedJobs=(await(await fetch(base+'/api/jobs')).json()).jobs;
  assert.equal(restartedJobs.find(job=>job.id===j.jobId).state,'COMPLETED');
  assert.equal(restartedJobs.find(job=>job.id===active.jobId).state,'ACTIVE');
  // Explicit live mode never accepts any other filesystem location.
  const outside=join(f.home,'elsewhere.sqlite');
  assert.match(invoke(cli,['init','--db',outside],f.env,2),/live namespace|path/i);
 }finally{
  if(child?.exitCode===null){child.kill('SIGTERM');await new Promise(ok=>child.once('exit',ok));}
  rmSync(f.home,{recursive:true,force:true});
 }
});
