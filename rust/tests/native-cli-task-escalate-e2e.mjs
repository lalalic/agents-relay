import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync,chmodSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
const dir=process.env.CARGO_TARGET_DIR??resolve(import.meta.dirname,'../target');
const cli=join(dir,'debug/relay-native-job');
const daemon=join(dir,'debug/relay-native-daemon');
const helper=join(dir,'debug/relay-worker-helper');
const isolated={...process.env,RELAY_RUST_EXPERIMENTAL_TEST_ONLY:'isolated-test',RELAY_RUST_LIVE_MODE:''};
function run(env,args,status=0){
 const p=spawnSync(cli,args,{env,encoding:'utf8',timeout:12000});
 assert.equal(p.status,status,p.stderr||p.stdout);
 return status===0?JSON.parse(p.stdout):p.stderr;
}
function load(db,id){
 const s=new DatabaseSync(db);
 try{return JSON.parse(s.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get(id).json);}
 finally{s.close();}
}
function save(db,job){
 const s=new DatabaseSync(db);
 try{s.prepare('UPDATE job_snapshot SET json=? WHERE job_id=?').run(JSON.stringify(job),job.id);}
 finally{s.close();}
}
function events(db){
 const s=new DatabaseSync(db);
 try{
  return s.prepare('SELECT event_id,payload_json FROM workflow_event_outbox ORDER BY event_id')
   .all().map(r=>JSON.parse(r.payload_json));
 }finally{s.close();}
}
function seed(job,f){
 job.tasks=[
  {id:f.original,jobId:f.id,title:'original',kind:'work',state:'FAILED',attempt:2,
   maxAttempts:3,dependencies:[],agentName:'implementation',
   executionId:null,leaseOwner:null,leaseExpiresAt:null,
   failureReason:'timeout',error:'worker timed out',resolution:null,
   executionHistory:[{id:'previous-failed-exec',attempt:1}]},
  {id:f.recovery,jobId:f.id,title:'troubleshooter',kind:'work',state:'RUNNING',
   agentName:'troubleshooter',parentTaskId:f.original,attempt:1,maxAttempts:3,
   dependencies:[],executionId:'recovery-exec',leaseOwner:'worker',
   leaseExpiresAt:'2099-01-01T00:00:00.000Z',
   executionHistory:[{id:'recovery-exec',attempt:1}],result:null,error:null,failureReason:null}
 ];
 return job;
}
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'relay-rust-authority-escalate-'));
 mkdirSync(join(root,'project'));
 writeFileSync(join(root,'.relay-rust-authority-isolated-test'),'isolated-test');
 const db=join(root,'relay.sqlite'),id='85',repo='escalate-repo';
 run(isolated,['init','--db',db]);
 run(isolated,['job','create','--db',db,'--id',id,'--repo',repo,
   '--objective','Escalate an actual failing worker to a human',
   '--project-root',join(root,'project'),'--no-review']);
 const f={root,db,id,repo,original:'original',recovery:'troubleshooter'};
 const job=seed(load(db,id),f);job.state='ACTIVE';save(db,job);
 return f;
}
const request=(f,flags=[])=>['task','escalate','--db',f.db,'--id',f.id,'--repo',f.repo,
 '--task-id',f.recovery,'--required-action','Confirm owner decision',
 '--resolution-condition','Owner response recorded',
 '--context','Diagnosed real failed execution',...flags];

test('Graph-authorized Task escalate persists pending human gate and exactly two durable Outbox events',()=>{
 const f=fixture();
 try{
  const before=load(f.db,f.id);
  const escalated=run(isolated,request(f));
  assert.equal(escalated.id,f.recovery);
  assert.equal(escalated.state,'BLOCKED');
  assert.equal(escalated.escalation.status,'pending');
  assert.equal(escalated.escalation.requiredAction,'Confirm owner decision');
  assert.equal(escalated.escalation.resolutionCondition,'Owner response recorded');
  assert.equal(escalated.escalation.context,'Diagnosed real failed execution');
  assert.equal(escalated.escalation.response,undefined,'no human approval is fabricated');
  assert.equal(escalated.leaseOwner,null);
  assert.equal(escalated.executionId,null);
  const after=load(f.db,f.id);
  assert.equal(after.tasks.length,before.tasks.length);
  assert.equal(after.tasks[0].state,'FAILED','original semantic Task remains failed');
  assert.equal(after.tasks[0].resolution.path,'escalation_gate');
  assert.equal(after.tasks[0].resolution.owner,'troubleshooter');
  assert.deepEqual(after.tasks[1],escalated);
  assert.deepEqual(events(f.db).map(e=>e.type).sort(),['escalation.requested','task.blocked']);
  assert.deepEqual(run(isolated,request(f)),escalated,'same request is deduplicated');
  assert.deepEqual(load(f.db,f.id),after);
  assert.equal(events(f.db).length,2,'replayed escalation publishes no duplicate event');
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
test('Task escalate rejects forged repo, unknown lineage, unsupported fields and blank request without changing Job',()=>{
 const f=fixture();
 try{
  const original=JSON.stringify(load(f.db,f.id));
  const invalid=[
   [request(f,['--unsupported','yes']),/unrecognized task/],
   [request(f,['--required-action','double']),/duplicate option/],
   [request(f).map((s,i,a)=>a[i-1]==='--repo'?'forged':s),/repository identity mismatch/],
   [request(f).map((s,i,a)=>a[i-1]==='--task-id'?'unknown':s),/recovery Task missing/],
   [request(f).map((s,i,a)=>a[i-1]==='--required-action'?' ':s),/nonempty/],
   [request(f).map((s,i,a)=>a[i-1]==='--context'?' ':s),/nonempty/],
   [request(f).map((s,i,a)=>a[i-1]==='--resolution-condition'?' ':s),/nonempty/],
  ];
  for(const [argv,expect] of invalid){
   assert.match(run(isolated,argv,2),expect);
   assert.equal(JSON.stringify(load(f.db,f.id)),original,'invalid escalation mutated Job');
  }
  const bad=[
   j=>j.tasks[0].state='QUEUED',
   j=>j.tasks[1].agentName='worker',
   j=>j.tasks[1].parentTaskId='other',
   j=>j.tasks[1].state='SUCCEEDED',
  ];
  for(const mutate of bad){
   const j=JSON.parse(original);mutate(j);save(f.db,j);
   const previous=JSON.stringify(load(f.db,f.id));
   assert.match(run(isolated,request(f),2),/Troubleshooter|original Task|cannot escalate/);
   assert.equal(JSON.stringify(load(f.db,f.id)),previous);
   save(f.db,JSON.parse(original));
  }
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
test('workflow action task.escalate delegates to same Graph/Outbox authority without duplicate escalation',()=>{
 const f=fixture();
 try{
  const cmd=['workflow','action','--db',f.db,'--id',f.id,'--repo',f.repo,
   '--task-id',f.recovery,'--action','task.escalate',
   '--required-action','Confirm owner decision',
   '--resolution-condition','Owner response recorded',
   '--context','Diagnosed real failed execution'];
  const result=run(isolated,cmd);
  assert.equal(result.state,'BLOCKED');
  assert.equal(result.escalation.status,'pending');
  assert.equal(events(f.db).length,2);
  assert.deepEqual(run(isolated,cmd),result);
  assert.equal(events(f.db).length,2);
 }finally{rmSync(f.root,{recursive:true,force:true});}
});

test('Explicit Troubleshooter response resumes pending Graph state once, preserves FAILED original and Outbox receipts',()=>{
 const f=fixture();
 try{
  const initial=run(isolated,request(f));
  assert.equal(initial.escalation.status,'pending');
  assert.equal(initial.escalation.response,undefined);
  assert.equal(events(f.db).length,2);
  const respond=['task','resume-troubleshooter','--db',f.db,'--id',f.id,'--repo',f.repo,
    '--task-id',f.recovery,'--response','Operator confirmed exact corrective action'];
  const updated=run(isolated,respond);
  assert.equal(updated.state,'QUEUED');
  assert.equal(updated.escalation.status,'responded');
  assert.equal(updated.escalation.response,'Operator confirmed exact corrective action');
  assert.equal(updated.leaseOwner,null);
  assert.equal(updated.executionId,null);
  assert.equal(load(f.db,f.id).tasks[0].state,'FAILED');
  assert.deepEqual(events(f.db).map(e=>e.type).sort(),
    ['escalation.requested','task.blocked','task.unblocked']);
  const persisted=load(f.db,f.id);
  assert.match(run(isolated,respond,2),/not a blocked pending Troubleshooter/);
  assert.deepEqual(load(f.db,f.id),persisted);
  assert.equal(events(f.db).length,3,'duplicate human response must not produce another event');
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
test('Troubleshooter response requires explicit text, exact pending lineage, and does not rewrite Job on errors',()=>{
 const f=fixture();
 try{
  const params=['task','resume-troubleshooter','--db',f.db,'--id',f.id,'--repo',f.repo,
   '--task-id',f.recovery,'--response','Operator verified'];
  let before=JSON.stringify(load(f.db,f.id));
  assert.match(run(isolated,params,2),/Escalation ID missing|not a blocked pending/);
  assert.equal(JSON.stringify(load(f.db,f.id)),before);
  run(isolated,request(f));
  const invalid=[
   [params.filter((x,i,a)=>x!=='--response'&&a[i-1]!=='--response'),/requires explicit nonempty --response/],
   [params.map((x,i,a)=>a[i-1]==='--response'?'   ':x),/requires explicit nonempty --response/],
   [[...params,'--response','duplicate'],/duplicate option/],
   [[...params,'--unexpected','ignored'],/unrecognized task/],
   [params.map((x,i,a)=>a[i-1]==='--repo'?'wrong':x),/repository identity mismatch/],
   [params.map((x,i,a)=>a[i-1]==='--task-id'?'original':x),/not a blocked pending/],
  ];
  before=JSON.stringify(load(f.db,f.id));
  for(const [params,regex] of invalid){
   assert.match(run(isolated,params,2),regex);
   assert.equal(JSON.stringify(load(f.db,f.id)),before);
  }
  const j=load(f.db,f.id);
  j.tasks[0].state='SUCCEEDED';save(f.db,j);
  before=JSON.stringify(load(f.db,f.id));
  assert.match(run(isolated,params,2),/original Task binding changed/);
  assert.equal(JSON.stringify(load(f.db,f.id)),before);
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
test('workflow action task.resume-troubleshooter requires explicit bound human reply and uses same Graph',()=>{
 const f=fixture();
 try{
  run(isolated,request(f));
  const action=['workflow','action','--db',f.db,'--id',f.id,'--repo',f.repo,
   '--task-id',f.recovery,'--action','task.resume-troubleshooter',
   '--response','Operator recorded evidence'];
  const restored=run(isolated,action);
  assert.equal(restored.state,'QUEUED');
  assert.equal(restored.escalation.response,'Operator recorded evidence');
  assert.equal(events(f.db).length,3);
 }finally{rmSync(f.root,{recursive:true,force:true});}
});

test('Live task escalate uses daemon-owned socket and keeps pending human gate after restart',async()=>{
 const home=mkdtempSync('/tmp/rr-esc-');
 const root=join(home,'.local/state/agents-relay/rust-live');
 mkdirSync(root,{recursive:true,mode:0o700});chmodSync(root,0o700);
 writeFileSync(join(root,'.relay-rust-live-namespace-v1'),'rust-relay-owned-standalone-namespace-v1\n',{mode:0o600});
 writeFileSync(join(root,'manifest.json'),JSON.stringify({agents:{}}));
 const db=join(root,'relay.sqlite');
 const sql=new DatabaseSync(db);
 sql.exec('PRAGMA journal_mode=WAL; CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL); CREATE TABLE relay_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE agent_snapshot(agent_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL);');
 sql.close();chmodSync(db,0o600);
 const env={...process.env,HOME:home,RELAY_RUST_LIVE_MODE:'pilot-live',RELAY_RUST_EXPERIMENTAL_TEST_ONLY:''};
 const f={db,id:'86',repo:'escalate-repo',original:'original',recovery:'troubleshooter',
  socket:join(root,'.rc.sock')};
 let child;
 function start(){
  const p=spawn(daemon,['--loop','--db',db,'--manifest',join(root,'manifest.json'),
   '--helper',helper,'--interval-ms','100'],{env,stdio:['ignore','pipe','pipe']});
  p.err='';p.stderr.on('data',c=>p.err+=c);return p;
 }
 async function ready(){
  for(let i=0;i<100;i++){
   if(existsSync(f.socket))return;
   if(child.exitCode!==null)throw Error('daemon failed: '+child.err);
   await delay(20);
  }
  throw Error('daemon socket unavailable');
 }
 async function stop(){
  if(!child||child.exitCode!==null)return;
  child.kill('SIGTERM');
  await Promise.race([new Promise(ok=>child.once('exit',ok)),delay(3000)]);
  if(child.exitCode===null){child.kill('SIGKILL');await new Promise(ok=>child.once('exit',ok));}
 }
 try{
  assert.match(run(env,request(f),2),/control socket unavailable/);
  child=start();await ready();
  assert.equal(run(env,['job','create','--db',db,'--id',f.id,'--repo',f.repo,
   '--objective','Human escalation E2E','--project-root',root]).created,true);
  await stop();child=null;
  // Keep disposable Job DRAFT to prevent scheduler running test-only Tasks.
  save(db,seed(load(db,f.id),f));
  child=start();await ready();
  const result=run(env,request(f));
  assert.equal(result.state,'BLOCKED');
  assert.equal(result.escalation.status,'pending');
  assert.equal(events(db).length,2);
  await stop();child=null;
  child=start();await ready();
  assert.equal(load(db,f.id).tasks[1].escalation.status,'pending');
  assert.equal(events(db).length,2);
  const response=['task','resume-troubleshooter','--db',db,'--id',f.id,'--repo',f.repo,
   '--task-id',f.recovery,'--response','Operator response through private Rust socket'];
  const restored=run(env,response);
  assert.equal(restored.state,'QUEUED');
  assert.equal(restored.escalation.status,'responded');
  assert.equal(restored.escalation.response,'Operator response through private Rust socket');
  assert.equal(events(db).length,3);
 }finally{await stop();rmSync(home,{recursive:true,force:true});}
});


test('canonical SQLite human escalation: durable pending gate, daemon restart, exact explicit response over Rust-only Unix socket',async()=>{
 const home=realpathSync(mkdtempSync('/tmp/rr-esc-canonical-'));
 const root=join(home,'.local/state/agents-relay/canonical-rust');
 const store=join(home,'.agents-relay');
 const project=join(home,'Workspace/neo/escalation-project');
 for(const folder of [root,store,project,join(home,'.config/neo')])mkdirSync(folder,{recursive:true});
 chmodSync(root,0o700);
 writeFileSync(join(root,'.canonical-relay-owner-v1'),'canonical-rust-operator-approved-v1\n');
 writeFileSync(join(home,'.config/neo/workspace.json'),JSON.stringify({schemaVersion:1,neoRoot:join(home,'Workspace/neo')}));
 assert.equal(spawnSync('git',['-C',project,'init','-q'],{encoding:'utf8'}).status,0);
 writeFileSync(join(root,'manifest.json'),JSON.stringify({agents:{}}));
 const db=join(store,'relay.sqlite');
 const sql=new DatabaseSync(db);
 sql.exec(`PRAGMA journal_mode=WAL;
 CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE TABLE source_registry(job_id TEXT PRIMARY KEY,source_file TEXT NOT NULL UNIQUE,repository TEXT NOT NULL,pr_number INTEGER NOT NULL);
 CREATE TABLE relay_meta(scope_job_id TEXT NOT NULL REFERENCES source_registry(job_id),key TEXT,value TEXT,PRIMARY KEY(scope_job_id,key));
 CREATE TABLE sequences(repository TEXT,kind TEXT,value INTEGER,PRIMARY KEY(repository,kind));
 INSERT INTO sequences VALUES('*','job',632);
 INSERT INTO sequences VALUES('*','task',1873);`);
 sql.close();chmodSync(db,0o600);
 const env={...process.env,HOME:home,RELAY_RUST_LIVE_MODE:'canonical-live',RELAY_RUST_EXPERIMENTAL_TEST_ONLY:''};
 const f={db,id:'633',repo:'escalation-project',original:'1874',recovery:'1875',root:home};
 let child;
 const socket=join(root,'.rc.sock');
 function launch(){
  const p=spawn(daemon,['--loop','--db',db,'--manifest',join(root,'manifest.json'),
   '--helper',helper,'--interval-ms','100'],{env,stdio:['ignore','pipe','pipe']});
  p.err='';p.stderr.on('data',data=>p.err+=data);return p;
 }
 async function ready(){
  for(let i=0;i<120;i++){
   if(existsSync(socket))return;
   if(child.exitCode!==null)throw Error('canonical daemon exited: '+child.err);
   await delay(25);
  }
  throw Error('canonical control socket not started');
 }
 async function stop(){
  if(!child||child.exitCode!==null)return;
  child.kill('SIGTERM');
  await Promise.race([new Promise(ok=>child.once('exit',ok)),delay(3000)]);
  if(child.exitCode===null){child.kill('SIGKILL');await new Promise(ok=>child.once('exit',ok));}
 }
 try{
  assert.match(run(env,request(f),2),/control socket unavailable/);
  child=launch();await ready();
  const created=run(env,['job','create','--db',db,'--id',f.id,'--repo',f.repo,
   '--objective','Escalate an actual failed Task and require human evidence',
   '--project-root',project,'--no-review']);
  assert.equal(created.created,true);
  await stop();child=null;
  const job=seed(load(db,f.id),f);job.state='DRAFT';save(db,job);
  child=launch();await ready();
  const requested=run(env,request(f));
  assert.equal(requested.state,'BLOCKED');
  assert.equal(requested.escalation.status,'pending');
  assert.equal(requested.escalation.response,undefined);
  assert.equal(load(db,f.id).tasks[0].state,'FAILED');
  assert.deepEqual(events(db).map(e=>e.type).sort(),['escalation.requested','task.blocked']);
  await stop();child=null;
  child=launch();await ready();
  assert.equal(load(db,f.id).tasks[1].escalation.status,'pending');
  const restored=run(env,['task','resume-troubleshooter','--db',db,'--id',f.id,'--repo',f.repo,
    '--task-id',f.recovery,'--response','Human operator explicitly authorized corrective evidence']);
  assert.equal(restored.state,'QUEUED');
  assert.equal(restored.escalation.status,'responded');
  assert.equal(load(db,f.id).tasks[0].state,'FAILED');
  assert.deepEqual(events(db).map(e=>e.type).sort(),['escalation.requested','task.blocked','task.unblocked']);
  assert.match(run(env,['task','resume-troubleshooter','--db',db,'--id',f.id,'--repo',f.repo,
    '--task-id',f.recovery,'--response','Replay same response'],2),/not a blocked pending/);
  const check=new DatabaseSync(db);
  assert.equal(check.prepare('SELECT repository FROM source_registry WHERE job_id=?').get(f.id).repository,f.repo);
  assert.equal(check.prepare('PRAGMA quick_check').get().quick_check,'ok');
  check.close();
 }finally{await stop();rmSync(home,{recursive:true,force:true});}
});
