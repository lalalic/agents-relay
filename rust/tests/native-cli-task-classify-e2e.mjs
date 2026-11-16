import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';

const bin=process.env.CARGO_TARGET_DIR??resolve(import.meta.dirname,'../target');
const cli=join(bin,'debug/relay-native-job');
const daemon=join(bin,'debug/relay-native-daemon');
const helper=join(bin,'debug/relay-worker-helper');
const env={...process.env,RELAY_RUST_EXPERIMENTAL_TEST_ONLY:'isolated-test',RELAY_RUST_LIVE_MODE:''};
function cliCall(e,args,status=0,stdin=''){
 const r=spawnSync(cli,args,{env:e,encoding:'utf8',input:stdin,timeout:12000});
 assert.equal(r.status,status,r.stderr||r.stdout);
 return status===0?JSON.parse(r.stdout):r.stderr;
}
function read(db,id){
 const sql=new DatabaseSync(db);
 try{return JSON.parse(sql.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get(id).json);}
 finally{sql.close();}
}
function save(db,j){
 const sql=new DatabaseSync(db);
 try{sql.prepare('UPDATE job_snapshot SET json=? WHERE job_id=?').run(JSON.stringify(j),j.id);}
 finally{sql.close();}
}
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'relay-rust-authority-classify-'));
 mkdirSync(join(root,'project'));
 writeFileSync(join(root,'.relay-rust-authority-isolated-test'),'isolated-test');
 const db=join(root,'relay.sqlite'),id='75';
 cliCall(env,['init','--db',db]);
 cliCall(env,['job','create','--db',db,'--repo','classify-repo','--id',id,
  '--title','Classify failure','--objective','Record objective evidence',
  '--project-root',join(root,'project'),'--no-review']);
 const create=title=>cliCall(env,['task','create','--db',db,'--repo','classify-repo','--id',id,
  '--title',title,'--input',title,'--output','file','--output-path',join(root,'project',title+'.txt')]).taskId;
 const f={root,db,id,failed:create('failed'),target:create('replacement')};
 const j=read(db,id);
 const failed=j.tasks.find(t=>t.id===f.failed);
 failed.state='FAILED';failed.error='broken';failed.failureReason='provider_failure';
 failed.attempt=3;failed.executionId=null;failed.leaseOwner=null;failed.leaseExpiresAt=null;
 save(db,j);
 return f;
}
const params=(f,extra=[])=>['task','classify','--db',f.db,'--repo','classify-repo',
  '--id',f.id,'--task-id',f.failed,'--target-task-id',f.target,
  '--classification','superseded','--evidence','Source reproduction 2026-11-15',
  '--reason','Replaced by verified work',...extra];
test('Task classify uses canonical Task Resolution Graph to annotate FAILED original without replacing Task',()=>{
 const f=fixture();
 try{
  const before=read(f.db,f.id),source=before.tasks.find(t=>t.id===f.failed);
  const classified=cliCall(env,params(f));
  assert.equal(classified.id,f.failed);assert.equal(classified.state,'FAILED');
  assert.equal(classified.error,'broken');
  assert.equal(classified.attempt,3);
  assert.equal(classified.resolutionClassification.kind,'superseded');
  assert.equal(classified.resolutionClassification.targetTaskId,f.target);
  assert.equal(classified.resolutionClassification.reason,'Replaced by verified work');
  assert.equal(classified.resolutionClassification.evidence,'Source reproduction 2026-11-15');
  const after=read(f.db,f.id);
  assert.equal(after.tasks.length,before.tasks.length);
  assert.deepEqual(after.tasks.find(t=>t.id===f.target),before.tasks.find(t=>t.id===f.target));
  assert.deepEqual({...classified,updatedAt:undefined,resolutionClassification:undefined},
    {...source,updatedAt:undefined,resolutionClassification:undefined});
  const again=cliCall(env,params(f),2);
  assert.match(again,/requires inactive unclassified FAILED Task/);
  assert.deepEqual(read(f.db,f.id),after,'duplicate classification must not overwrite provenance');
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
test('Task classify invalid variant and evidence/reason-file inputs preserve evidence with no false success',()=>{
 const f=fixture();
 try{
  const evidence=join(f.root,'evidence.txt'),reason=join(f.root,'reason.txt');
  writeFileSync(evidence,'  EVIDENCE: failure reproduction\n 第二行   ');
  writeFileSync(reason,'  Root cause confirmed\n ');
  const a=params(f).filter((x,i,all)=>!['--evidence','--reason'].includes(x)
    &&!['--evidence','--reason'].includes(all[i-1])
    &&!['--classification','superseded'].includes(x));
  const changed=cliCall(env,[...a,'--classification','invalid',
    '--evidence-file',evidence,'--reason-file',reason]);
  assert.equal(changed.resolutionClassification.kind,'invalid');
  assert.equal(changed.resolutionClassification.evidence,'EVIDENCE: failure reproduction\n 第二行');
  assert.equal(changed.resolutionClassification.reason,'Root cause confirmed');
  assert.equal(changed.state,'FAILED');
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
test('Task classify rejects nonfailed/leased/unknown target or invalid evidence atomically',()=>{
 const f=fixture();
 try{
  const invalid=[
   [params(f,['--classification','invalid']),/duplicate option/],
   [params(f,['--evidence-file','-']),/exactly one of --evidence/],
   [params(f).map((x,i,a)=>a[i-1]==='--classification'?'unknown':x),/superseded or invalid/],
   [params(f).map((x,i,a)=>a[i-1]==='--target-task-id'?'missing':x),/different durable Task/],
   [params(f).map((x,i,a)=>a[i-1]==='--target-task-id'?f.failed:x),/must differ/],
   [params(f).map((x,i,a)=>a[i-1]==='--repo'?'spoof':x),/repository identity mismatch/],
   [params(f).map((x,i,a)=>a[i-1]==='--evidence'?'   ':x),/--evidence requires nonempty/],
   [params(f).map((x,i,a)=>a[i-1]==='--reason'?'   ':x),/--reason requires nonempty/],
  ];
  const original=JSON.stringify(read(f.db,f.id));
  for(const [argv,pattern] of invalid){
   assert.match(cliCall(env,argv,2),pattern);
   assert.equal(JSON.stringify(read(f.db,f.id)),original,'invalid classification mutated Job');
  }
  for(const patch of [
   t=>t.state='QUEUED',
   t=>t.kind='planner',
   t=>t.leaseOwner='someone',
   t=>t.failureReason='worker_outcome_unknown',
   t=>t.resolution={state:'active'},
   t=>t.resolutionClassification={kind:'invalid'},
  ]){
   const j=read(f.db,f.id);const t=j.tasks.find(t=>t.id===f.failed);
   patch(t);save(f.db,j);
   const before=JSON.stringify(read(f.db,f.id));
   assert.match(cliCall(env,params(f),2),/requires inactive unclassified FAILED Task/);
   assert.equal(JSON.stringify(read(f.db,f.id)),before);
   save(f.db,JSON.parse(original));
  }
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
test('live Task classify uses daemon-controlled SQLite and survives restart',async()=>{
 const home=mkdtempSync('/tmp/rr-cls-');
 const root=join(home,'.local/state/agents-relay/rust-live');
 mkdirSync(root,{recursive:true,mode:0o700});chmodSync(root,0o700);
 writeFileSync(join(root,'.relay-rust-live-namespace-v1'),'rust-relay-owned-standalone-namespace-v1\n',{mode:0o600});
 writeFileSync(join(root,'manifest.json'),JSON.stringify({agents:{}}));
 const db=join(root,'relay.sqlite');
 const sql=new DatabaseSync(db);
 sql.exec('PRAGMA journal_mode=WAL; CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL); CREATE TABLE relay_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE agent_snapshot(agent_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL);');
 sql.close();chmodSync(db,0o600);
 const live={...process.env,HOME:home,RELAY_RUST_LIVE_MODE:'pilot-live',RELAY_RUST_EXPERIMENTAL_TEST_ONLY:''};
 const f={db,id:'97',failed:'failed',target:'replacement',root,socket:join(root,'.rc.sock')};
 let child;
 function start(){
  const p=spawn(daemon,['--loop','--db',db,'--manifest',join(root,'manifest.json'),
   '--helper',helper,'--interval-ms','100'],{env:live,stdio:['ignore','pipe','pipe']});
  p.stderrText='';p.stderr.on('data',d=>p.stderrText+=d);return p;
 }
 async function ready(){
  for(let i=0;i<100;i++){
   if(existsSync(f.socket))return;
   if(child.exitCode!==null)throw Error('Daemon exited '+child.stderrText);
   await delay(20);
  }
  throw Error('Socket not ready');
 }
 async function stop(){
  if(!child||child.exitCode!==null)return;
  child.kill('SIGTERM');
  await Promise.race([new Promise(ok=>child.once('exit',ok)),delay(3000)]);
  if(child.exitCode===null){child.kill('SIGKILL');await new Promise(ok=>child.once('exit',ok));}
 }
 try{
  const arg=['task','classify','--db',db,'--id',f.id,'--repo','classify-repo',
   '--task-id',f.failed,'--target-task-id',f.target,
   '--classification','invalid','--evidence','Verified failure','--reason','Unusable'];
  assert.match(cliCall(live,arg,2),/control socket unavailable/);
  child=start();await ready();
  assert.equal(cliCall(live,['job','create','--db',db,'--id',f.id,'--repo','classify-repo',
   '--title','Live classification','--objective','Classify worker failure','--project-root',root]).created,true);
  await stop();child=null;
  const j=read(db,f.id);
  j.tasks=[
   {id:f.failed,jobId:f.id,title:'failed',kind:'work',state:'FAILED',
    dependencies:[],error:'failed',failureReason:'task_failure',leaseOwner:null,executionId:null,leaseExpiresAt:null},
   {id:f.target,jobId:f.id,title:'replacement',kind:'work',state:'SUCCEEDED',dependencies:[]}
  ];
  save(db,j);
  child=start();await ready();
  const result=cliCall(live,arg);
  assert.equal(result.resolutionClassification.kind,'invalid');
  assert.equal(result.state,'FAILED');
  await stop();child=null;
  child=start();await ready();
  assert.equal(read(db,f.id).tasks[0].resolutionClassification.evidence,'Verified failure');
 }finally{await stop();rmSync(home,{recursive:true,force:true});}
});
