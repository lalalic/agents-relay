import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';

const target=process.env.CARGO_TARGET_DIR??resolve(import.meta.dirname,'../target');
const cli=join(target,'debug/relay-native-job');
const daemon=join(target,'debug/relay-native-daemon');
const helper=join(target,'debug/relay-worker-helper');
const env={...process.env,RELAY_RUST_EXPERIMENTAL_TEST_ONLY:'isolated-test'};
const worker=[
"import {readFileSync,writeFileSync} from 'node:fs';",
"const req=JSON.parse(readFileSync(process.env.RELAY_TASK_REQUEST_PATH,'utf8'));",
"writeFileSync(process.env.RELAY_RESULT_PATH,JSON.stringify({",
"  jobId:req.jobId,taskId:req.taskId,executionId:req.executionId,",
"  status:'COMPLETED',output:{input:JSON.parse(req.input).coordinatorInput,worker:'real os process'}",
"}));"
].join('\n');
function call(bin,args,exit=0){
  const result=spawnSync(bin,args,{env,encoding:'utf8',timeout:16000});
  assert.equal(result.status,exit,result.stderr||result.stdout);
  return exit===0?JSON.parse(result.stdout.trim()):result.stderr;
}
function f(){
 const root=mkdtempSync(join(tmpdir(),'relay-rust-authority-'));
 mkdirSync(join(root,'project'));mkdirSync(join(root,'project/output'));
 const db=join(root,'relay.sqlite'),graph=join(root,'project/graph.mmd'),
 input=join(root,'project/input.md'),output=join(root,'project/output/final.json');
 writeFileSync(join(root,'.relay-rust-authority-isolated-test'),'isolated-test');
 writeFileSync(graph,'flowchart TD\nbuilder[agent:builder]\n');
 writeFileSync(input,'Build a non-synthetic file.');
 const script=join(root,'worker.mjs');
 writeFileSync(script,worker);
 const manifest=join(root,'manifest.json');
 writeFileSync(manifest,JSON.stringify({agents:{builder:{kind:'script',executable:process.execPath,args:[script]}}}));
 // Node-compatible native Coordinator creation makes no-Review/No-Merge an
 // explicit caller choice; legacy creation enables Review+merge by default.
 const create=(extra=[])=>['job','create','--db',db,'--coordinator-project-root',join(root,'project'),
  '--coordinator-workspace-root',join(root,'project'),
  '--coordinator-graph-file',graph,'--coordinator-input-file',input,
  '--coordinator-output-path',output,'--objective','Build a non-synthetic file.',
  '--title','Rust-native real Job','--repo','calc','--idempotency-key','same-req',
  '--no-review',...extra];
 return {root,db,create,manifest,output};
}
function updateJob(db,id,mutate){
 const sql=new DatabaseSync(db);
 try{
  const row=sql.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get(id);
  const job=JSON.parse(row.json);mutate(job);
  sql.prepare('UPDATE job_snapshot SET json=? WHERE job_id=?').run(JSON.stringify(job),id);
 }finally{sql.close();}
}
test('Native Rust alone creates, activates, executes, completes and deduplicates a real DAG',()=>{
 const v=f();try{
  assert.equal(call(cli,['init','--db',v.db]).initialized,true);
  const first=call(cli,v.create());
  assert.equal(first.created,true);
  assert.match(first.jobId,/^[1-9]\d*$/);
  assert.match(first.coordinatorTaskId,/^[1-9]\d*$/);
  assert.equal(call(cli,v.create()).created,false);
  const collision=v.create();collision[collision.indexOf('--title')+1]='different title';
  assert.match(call(cli,collision,2),/collision/);
  const activated=call(cli,['activate','--db',v.db,'--job-id',first.jobId]);
  assert.equal(activated.state,'ACTIVE');
  assert.equal(call(cli,['activate','--db',v.db,'--job-id',first.jobId]).activated,false);
  const args=['--once','--db',v.db,'--manifest',v.manifest,'--helper',helper];
  // Each --once tick advances one durable scheduling wave. The Coordinator's
  // output can enqueue its Graph children, which are claimed on the next tick.
  // Assert bounded convergence of the *real* daemon, not same-tick completion.
  const ticks=[];
  for(let iteration=0;iteration<8;iteration++){
    const tick=call(daemon,args);
    ticks.push(tick);
    if(tick.report.jobsCompleted>0)break;
  }
  assert.equal(ticks.reduce((sum,t)=>sum+t.report.tasksSucceeded,0),1,JSON.stringify(ticks));
  assert.equal(ticks.reduce((sum,t)=>sum+t.report.jobsCompleted,0),1,JSON.stringify(ticks));
  const job=call(cli,['show','--db',v.db,'--job-id',first.jobId]);
  assert.equal(job.job.state,'COMPLETED');
  assert.deepEqual(job.job.tasks.map(t=>t.state),['SUCCEEDED','SUCCEEDED']);
  assert.equal(job.job.tasks[1].result.data.output.worker,'real os process');
  assert.equal(call(cli,v.create()).created,false,'idempotent replay after output exists');
  const replay=call(daemon,args);
  assert.equal(replay.report.tasksClaimed,0);
  assert.equal(replay.report.jobsCompleted,0);
  assert.equal(call(cli,['complete','--db',v.db,'--job-id',first.jobId]).completed,false);
 }finally{rmSync(v.root,{recursive:true,force:true});}
});
test('Graph completion cannot bypass Review/merge, incomplete DAG, or source fencing',()=>{
 const v=f();try{
  call(cli,['init','--db',v.db]);
  const {jobId}=call(cli,v.create());
  call(cli,['activate','--db',v.db,'--job-id',jobId]);
  let done=call(cli,['complete','--db',v.db,'--job-id',jobId]);
  assert.equal(done.completed,false,'unfinished coordinator');
  updateJob(v.db,jobId,j=>{j.reviewEnabled=true;j.tasks[0].state='SUCCEEDED';});
  assert.equal(call(cli,['complete','--db',v.db,'--job-id',jobId]).completed,false);
  updateJob(v.db,jobId,j=>{j.reviewEnabled=false;j.autoMerge=true;j.tasks[0].state='RUNNING';});
  assert.equal(call(cli,['complete','--db',v.db,'--job-id',jobId]).completed,false);
  updateJob(v.db,jobId,j=>{j.autoMerge=false;j.tasks[0].state='AWAITING_DECISION';});
  assert.equal(call(cli,['complete','--db',v.db,'--job-id',jobId]).completed,false);
  assert.match(call(cli,['create','--db',v.db,'--project-root',tmpdir(),
    '--graph-file',join(v.root,'project/graph.mmd'),
    '--input-file',join(v.root,'project/input.md'),'--output-path',v.output,
    '--title','Attack','--repository','calc','--request-key','attack'],2),/outside isolated root/);
 }finally{rmSync(v.root,{recursive:true,force:true});}
});
test('Isolated store marker and env are mandatory; production paths fail closed',()=>{
 const v=f();try{
  const noEnv=spawnSync(cli,['init','--db',v.db],{env:{...env,RELAY_RUST_EXPERIMENTAL_TEST_ONLY:''},encoding:'utf8'});
  assert.equal(noEnv.status,2);
  const outside=join(tmpdir(),'not-an-authorized-relay-db.sqlite');
  assert.match(call(cli,['init','--db',outside],2),/marked isolated temporary store/);
  assert.equal(existsSync(outside),false);
 }finally{rmSync(v.root,{recursive:true,force:true});}
});

test('Rust Job and Task IDs are global across repositories in the same SQLite store',()=>{
 const v=f();try{
  call(cli,['init','--db',v.db]);
  const a=call(cli,v.create());
  const project=join(v.root,'second');
  mkdirSync(project);mkdirSync(join(project,'output'));
  const graph=join(project,'graph.mmd'),input=join(project,'input.md');
  writeFileSync(graph,'flowchart TD\nbuilder[agent:builder]\n');
  writeFileSync(input,'Independent repository job');
  const b=call(cli,['create','--db',v.db,'--project-root',project,
   '--graph-file',graph,'--input-file',input,'--output-path',join(project,'output/final.json'),
   '--title','Second project','--repository','vlog','--request-key','same-req']);
  assert.equal(Number(b.jobId),Number(a.jobId)+1);
  assert.equal(Number(b.coordinatorTaskId),Number(a.coordinatorTaskId)+1);
  assert.notEqual(a.jobId,b.jobId);
  assert.equal(call(cli,v.create()).jobId,a.jobId);
  assert.equal(call(cli,['create','--db',v.db,'--project-root',project,
   '--graph-file',graph,'--input-file',input,'--output-path',join(project,'output/final.json'),
   '--title','Second project','--repository','vlog','--request-key','same-req']).jobId,b.jobId);
 }finally{rmSync(v.root,{recursive:true,force:true});}
});

test('An executable exiting successfully without a correlated terminal receipt fails the Task and never completes Job',()=>{
 const v=f();try{
  call(cli,['init','--db',v.db]);
  const {jobId}=call(cli,v.create());
  call(cli,['activate','--db',v.db,'--job-id',jobId]);
  const broken=join(v.root,'silent.mjs');
  writeFileSync(broken,'process.exit(0)\n');
  writeFileSync(v.manifest,JSON.stringify({agents:{builder:{kind:'script',executable:process.execPath,args:[broken]}}}));
  const args=['--once','--db',v.db,'--manifest',v.manifest,'--helper',helper];
  const tick=call(daemon,args);
  assert.equal(tick.report.tasksSucceeded,0);
  assert.equal(tick.report.tasksFailed,1);
  assert.equal(tick.report.jobsCompleted,0);
  const job=call(cli,['show','--db',v.db,'--job-id',jobId]).job;
  assert.equal(job.state,'ACTIVE');
  assert.equal(job.tasks[0].state,'RUNNING','Coordinator cannot complete on failed child');
  assert.equal(job.tasks[1].state,'FAILED');
  const replay=call(daemon,args);
  assert.equal(replay.report.tasksSucceeded,0);
  assert.equal(replay.report.jobsCompleted,0);
  assert.equal(call(cli,['complete','--db',v.db,'--job-id',jobId]).completed,false);
 }finally{rmSync(v.root,{recursive:true,force:true});}
});

test('Native Rust durable outbox publishes an execution-bound NATS envelope and persists ACK; restart does not replay',async()=>{
 const net=await import('node:net');
 const {spawn}=await import('node:child_process');
 const v=f();let server;
 try{
  call(cli,['init','--db',v.db]);
  const {jobId}=call(cli,v.create());
  call(cli,['activate','--db',v.db,'--job-id',jobId]);
  const base=['--once','--db',v.db,'--manifest',v.manifest,'--helper',helper];
  call(daemon,base);
  const sql=new DatabaseSync(v.db);
  try{
    assert.equal(sql.prepare("SELECT count(*) AS n FROM workflow_event_outbox WHERE state='pending'").get().n,1);
  }finally{sql.close();}
  let received;
  server=net.createServer(socket=>{
    socket.write('INFO {"auth_required":false,"tls_required":false}\r\n');
    let buffer=Buffer.alloc(0);
    socket.on('data',bytes=>{
      buffer=Buffer.concat([buffer,bytes]);
      if (!buffer.includes(Buffer.from('\r\nPING\r\n'))) return;
      const str=buffer.toString('utf8');
      const match=str.match(/PUB (relay\.events\.job\.\d+\.task\.completed) (\d+)\r\n/);
      assert.ok(match,str);
      const body=str.slice(str.indexOf(match[0])+match[0].length);
      received={subject:match[1],envelope:JSON.parse(body.slice(0,Number(match[2])))};
      socket.write('PONG\r\n');
      socket.end();
    });
  });
  await new Promise((ok,err)=>server.listen(0,'127.0.0.1',error=>error?err(error):ok()));
  const withPort=[...base,'--nats-port',String(server.address().port)];
  const execute=()=>new Promise((resolve,reject)=>{
    const child=spawn(daemon,withPort,{env,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';
    child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
    child.on('close',code=>code===0?resolve(JSON.parse(stdout.trim())):reject(new Error(stderr)));
  });
  assert.equal((await execute()).eventsPublished,1);
  assert.equal(received.subject,'relay.events.job.1.task.completed');
  assert.equal(received.envelope.type,'task.completed');
  assert.equal(received.envelope.job_id,'1');
  assert.equal(received.envelope.task_id,'2');
  assert.match(received.envelope.event_id,/^[a-f0-9]{64}$/);
  assert.match(received.envelope.source.id,/^job\/1\/task\/2\/execution\//);
  assert.equal((await execute()).eventsPublished,0);
  const verify=new DatabaseSync(v.db);
  try{assert.equal(verify.prepare("SELECT count(*) AS n FROM workflow_event_outbox WHERE state='published'").get().n,1);}
  finally{verify.close();}
 }finally{
  if(server)await new Promise(ok=>server.close(ok));
  rmSync(v.root,{recursive:true,force:true});
 }
});
test('NATS missing ACK keeps native outbox pending and fails closed',async()=>{
 const net=await import('node:net');
 const {spawn}=await import('node:child_process');
 const v=f();let server;
 try {
  call(cli,['init','--db',v.db]);
  const {jobId}=call(cli,v.create());
  call(cli,['activate','--db',v.db,'--job-id',jobId]);
  const base=['--once','--db',v.db,'--manifest',v.manifest,'--helper',helper];
  call(daemon,base);
  server=net.createServer(socket=>{
    socket.write('INFO {"auth_required":false,"tls_required":false}\r\n');
    socket.on('data',buffer=>{if(buffer.includes(Buffer.from('PING\r\n')))socket.end();});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const response=await new Promise((resolve,reject)=>{
   const proc=spawn(daemon,[...base,'--nats-port',String(server.address().port)],{env});
   let err='';proc.stderr.on('data',b=>err+=b);
   proc.on('close',status=>resolve({status,err}));proc.on('error',reject);
  });
  assert.equal(response.status,2);
  assert.match(response.err,/NATS/);
  const sql=new DatabaseSync(v.db);
  try{
    assert.equal(sql.prepare("SELECT count(*) AS n FROM workflow_event_outbox WHERE state='pending'").get().n,1);
    assert.equal(sql.prepare("SELECT count(*) AS n FROM workflow_event_outbox WHERE state='published'").get().n,0);
  }finally{sql.close();}
 }finally{
   if(server)await new Promise(resolve=>server.close(resolve));
   rmSync(v.root,{recursive:true,force:true});
 }
});
