import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,realpathSync,rmSync,chmodSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

const target=resolve(process.env.CARGO_TARGET_DIR??join(import.meta.dirname,'../target'));
const daemon=join(target,'debug/relay-native-daemon');
const helper=join(target,'debug/relay-worker-helper');
function command(binary,args,env){
 const result=spawnSync(binary,args,{encoding:'utf8',env,timeout:30000,maxBuffer:4*1024*1024});
 assert.equal(result.status,0,result.stderr||result.stdout);
 return result.stdout?.trim();
}
function fixture({worktree=false,conflict=false}={}){
 const home=realpathSync(mkdtempSync('/tmp/rust-native-merge-'));
 const repo=join(home,'Workspace/neo/local-merge');
 const authorityRoot=join(home,'.local/state/agents-relay/canonical-rust');
 const db=join(home,'.agents-relay/relay.sqlite');
 for(const path of [repo,authorityRoot,join(home,'.agents-relay'),join(home,'.config/neo')])mkdirSync(path,{recursive:true});
 chmodSync(authorityRoot,0o700);
 writeFileSync(join(authorityRoot,'.canonical-relay-owner-v1'),'canonical-rust-operator-approved-v1\n');
 writeFileSync(join(authorityRoot,'manifest.json'),JSON.stringify({agents:{}}));
 writeFileSync(join(home,'.config/neo/workspace.json'),JSON.stringify({schemaVersion:1,neoRoot:join(home,'Workspace/neo')}));
 command('git',['-C',repo,'init','-q','-b','main'],process.env);
 command('git',['-C',repo,'config','user.name','Rust Local Merge E2E'],process.env);
 command('git',['-C',repo,'config','user.email','native-merge@localhost'],process.env);
 writeFileSync(join(repo,'model.txt'),'Initial content\n');
 command('git',['-C',repo,'add','model.txt'],process.env);
 command('git',['-C',repo,'commit','-q','-m','Initial main'],process.env);
 const base=command('git',['-C',repo,'rev-parse','HEAD'],process.env);
 command('git',['-C',repo,'checkout','-q','-b','feature'],process.env);
 writeFileSync(join(repo,'feature.txt'),'New tested feature from workers\n');
 if(conflict)writeFileSync(join(repo,'model.txt'),'Source feature changed this exact line\n');
 command('git',['-C',repo,'add','-A'],process.env);
 command('git',['-C',repo,'commit','-q','-m','Source feature passed tests'],process.env);
 const source=command('git',['-C',repo,'rev-parse','HEAD'],process.env);
 if(conflict){
  command('git',['-C',repo,'checkout','-q','main'],process.env);
  writeFileSync(join(repo,'model.txt'),'Main changed the same line differently\n');
  command('git',['-C',repo,'add','model.txt'],process.env);
  command('git',['-C',repo,'commit','-q','-m','Main conflicting change'],process.env);
  command('git',['-C',repo,'checkout','-q','feature'],process.env);
 }
 const priorTarget=command('git',['-C',repo,'rev-parse','refs/heads/main'],process.env);
 if(worktree){
  command('git',['-C',repo,'worktree','add','-q',join(home,'main-worktree'),'main'],process.env);
 }
 const sql=new DatabaseSync(db);
 sql.exec(`CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE TABLE source_registry(job_id TEXT PRIMARY KEY,source_file TEXT NOT NULL UNIQUE,repository TEXT NOT NULL,pr_number INTEGER NOT NULL);
 CREATE TABLE relay_meta(scope_job_id TEXT NOT NULL REFERENCES source_registry(job_id),key TEXT,value TEXT,PRIMARY KEY(scope_job_id,key));
 CREATE TABLE sequences(repository TEXT,kind TEXT,value INTEGER,PRIMARY KEY(repository,kind));
 INSERT INTO sequences VALUES('*','job',632); INSERT INTO sequences VALUES('*','task',1875);`);
 const now='2026-11-16T21:00:00.000Z';
 const j={id:'632',repository:'local-merge',nativeIntakeHash:'rust-native-fixture',projectRoot:repo,
  title:'Rust Local Merge L3',state:'ACTIVE',runtimeStatus:'RUNNING',updatedAt:now,
  headSha:source,reviewEnabled:true,autoMerge:true,prNumber:0,plans:[],pause:null,publication:null,
  localMerge:{sourceRef:'refs/heads/feature',targetRef:'refs/heads/main',sourceSha:source,
   status:'pending',attempts:0},
  review:{outcome:'approved',headSha:source,taskId:'1875',evidence:{data:{verdict:'approved',head_sha:source,findings:[]}}},
  tasks:[{id:'1874',title:'Implement functional change',state:'SUCCEEDED',kind:'work',dependencies:[],agentName:'designer',
    output:{kind:'task_pr'},result:{summary:'Tested physical worker'}} ,
   {id:'1875',title:'Final Review',state:'SUCCEEDED',kind:'work',dependencies:[],agentName:'job-acceptance-reviewer',
    reviewHeadSha:source,output:{kind:'task_pr'},result:{data:{output:{verdict:'approved',head_sha:source,findings:[]}}}}]};
 sql.prepare('INSERT INTO job_snapshot VALUES(?,?,?)').run('632',JSON.stringify(j),now);
 sql.prepare('INSERT INTO source_registry VALUES(?,?,?,?)').run('632','unified:632','local-merge',0);
 sql.close();chmodSync(db,0o600);
 const env={...process.env,HOME:home,RELAY_RUST_LIVE_MODE:'canonical-live'};
 const run=()=>JSON.parse(command(daemon,['--once','--db',db,'--manifest',join(authorityRoot,'manifest.json'),
  '--helper',helper,'--max-tasks','4'],env));
 const snapshot=()=>{const s=new DatabaseSync(db);try{return JSON.parse(s.prepare("SELECT json FROM job_snapshot WHERE job_id='632'").get().json)}finally{s.close()}};
 return {home,repo,db,source,priorTarget,env,run,snapshot,base};
}

for(const worktree of [false,true])test(`Rust local merge delivers actually approved feature onto main, ${worktree?'checked-out main worktree':'unoccupied target ref'}, with exact parentage and Graph completion`,()=>{
 const f=fixture({worktree});
 try{
  const first=f.run();
  assert.equal(first.report.localMergesSucceeded,1,JSON.stringify(first));
  assert.equal(first.report.jobsCompleted,1);
  const outbox=new DatabaseSync(f.db);
  assert.deepEqual(outbox.prepare('SELECT payload_json FROM workflow_event_outbox').all()
   .map(row=>JSON.parse(row.payload_json).type),['job.merge.succeeded']);
  outbox.close();
  const job=f.snapshot();
  assert.equal(job.state,'COMPLETED');
  assert.equal(job.localMerge.status,'succeeded');
  assert.equal(job.localMerge.sourceSha,f.source);
  assert.equal(job.localMerge.previousTargetSha,f.priorTarget);
  const merged=command('git',['-C',f.repo,'rev-parse','refs/heads/main'],f.env);
  assert.equal(job.localMerge.mergedCommitSha,merged);
  assert.deepEqual(command('git',['-C',f.repo,'rev-list','--parents','-n','1',merged],f.env).split(' '),[merged,f.priorTarget,f.source]);
  assert.equal(command('git',['-C',f.repo,'show','-s','--format=%B',merged],f.env).includes('Agents-Relay-Job: 632'),true);
  assert.equal(f.run().report.jobsCompleted,0,'replaying completed merge must not write another commit');
  const same=command('git',['-C',f.repo,'rev-parse','refs/heads/main'],f.env);
  assert.equal(same,merged);
  const check=new DatabaseSync(f.db);assert.equal(check.prepare('PRAGMA quick_check').get().quick_check,'ok');check.close();
 }finally{rmSync(f.home,{recursive:true,force:true})}
});

for(const checkedOut of [false,true])test(`Rust conflict on ${checkedOut?'checked-out':'unoccupied'} main fails closed, records retry, then merges after verified correction`,()=>{
 const f=fixture({conflict:true,worktree:checkedOut});
 try{
  const first=f.run();
  assert.equal(first.report.localMergesSucceeded,0);
  assert.equal(first.report.localMergesFailed,1,JSON.stringify(first));
  let job=f.snapshot();
  assert.equal(job.state,'ACTIVE');
  assert.equal(job.localMerge.status,'failed');
  assert.equal(job.localMerge.attempts,1);
  assert.ok(job.localMerge.nextAttemptAt);
  assert.equal(command('git',['-C',f.repo,'rev-parse','refs/heads/main'],f.env),f.priorTarget);
  assert.equal(f.run().report.localMergesFailed,0,'backoff prevents busy repeated conflicts');
  job=f.snapshot();assert.equal(job.localMerge.attempts,1);
  if(checkedOut){
   assert.equal(command('git',['-C',join(f.home,'main-worktree'),'status','--porcelain','--untracked-files=no'],f.env),'',
    'a failed Relay merge must restore its own clean main index/worktree');
   assert.notEqual(spawnSync('git',['-C',join(f.home,'main-worktree'),'rev-parse','-q','--verify','MERGE_HEAD'],{encoding:'utf8'}).status,0,
    'a failed Relay merge must not leave its own MERGE_HEAD');
  }
  // The human/Agent correction is a new commit on main that makes the exact
  // source file nonconflicting. Retry still uses the original reviewed source
  // Git SHA, but must observe main's actual, updated CAS ref.
  const target=checkedOut?join(f.home,'main-worktree'):f.repo;
  if(!checkedOut)command('git',['-C',f.repo,'checkout','-q','main'],f.env);
  writeFileSync(join(target,'model.txt'),'Source feature changed this exact line\n');
  command('git',['-C',target,'add','model.txt'],f.env);
  command('git',['-C',target,'commit','-q','-m','Resolve branch conflict with audited content'],f.env);
  const newMain=command('git',['-C',target,'rev-parse','refs/heads/main'],f.env);
  if(!checkedOut)command('git',['-C',f.repo,'checkout','-q','feature'],f.env);
  // Move only this fixture's retry clock to the past; the production daemon
  // always honors persistent exponential backoff.
  const db=new DatabaseSync(f.db);
  const latest=db.prepare("SELECT json FROM job_snapshot WHERE job_id='632'").get();
  const rewritten=JSON.parse(latest.json);
  rewritten.localMerge.nextAttemptAt='2026-11-15T00:00:00.000Z';
  db.prepare("UPDATE job_snapshot SET json=? WHERE job_id='632'").run(JSON.stringify(rewritten));
  const retry=f.run();
  assert.equal(retry.report.localMergesSucceeded,1,JSON.stringify(retry));
  assert.equal(retry.report.jobsCompleted,1);
  job=f.snapshot();
  assert.equal(job.state,'COMPLETED');
  assert.equal(job.localMerge.previousTargetSha,newMain);
  assert.deepEqual(command('git',['-C',f.repo,'rev-list','--parents','-n','1',job.localMerge.mergedCommitSha],f.env).split(' '),
    [job.localMerge.mergedCommitSha,newMain,f.source]);
  const all=db.prepare('SELECT payload_json FROM workflow_event_outbox ORDER BY created_at,event_key').all()
    .map(row=>JSON.parse(row.payload_json));
  assert.deepEqual(all.map(event=>event.type).sort(),['job.merge.failed','job.merge.succeeded']);
  assert.ok(all.every(event=>event.job_id==='632'));
  assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');db.close();
 }finally{rmSync(f.home,{recursive:true,force:true})}
});

test('forged interactive approved flag without a bound host-decision ledger cannot authorize Git merge',()=>{
 const f=fixture();
 try{
  const db=new DatabaseSync(f.db);
  db.exec(`CREATE TABLE host_invocation_decision (
    job_id TEXT NOT NULL,task_id TEXT NOT NULL,invocation_id TEXT NOT NULL,
    execution_id TEXT NOT NULL,revision TEXT NOT NULL,decision TEXT NOT NULL,
    PRIMARY KEY(job_id,task_id,invocation_id));`);
  const j=JSON.parse(db.prepare("SELECT json FROM job_snapshot WHERE job_id='632'").get().json);
  j.tasks[0].interactiveInvocation={status:'approved',invocationId:'forged-human-approval',
    executionId:'forged-exec',revision:'f'.repeat(64)};
  db.prepare("UPDATE job_snapshot SET json=? WHERE job_id='632'").run(JSON.stringify(j));
  const report=f.run();
  assert.equal(report.report.localMergesSucceeded,0);
  assert.equal(report.report.jobsCompleted,0);
  const next=f.snapshot();
  assert.equal(next.state,'ACTIVE');
  assert.equal(next.localMerge.status,'pending');
  assert.equal(command('git',['-C',f.repo,'rev-parse','refs/heads/main'],f.env),f.priorTarget);
  assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');
  db.close();
 }finally{rmSync(f.home,{recursive:true,force:true})}
});
