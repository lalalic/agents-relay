import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, chmodSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {ensureUnifiedJobRegistry} from '../../dist/unified-job-registry.js';

const target=resolve(process.env.CARGO_TARGET_DIR ?? join(import.meta.dirname,'../target'));
const cli=join(target,'debug/relay-native-job');
const helper=join(target,'debug/relay-worker-helper');
const exec=(command,args,env,timeout=30000)=>spawnSync(command,args,{encoding:'utf8',env,timeout,maxBuffer:4*1024*1024});
const sqlLiteral=x=>String(x).replaceAll("'","''");
function makeFixture(){
 const home=realpathSync(mkdtempSync('/tmp/relay-canonical-l3-'));
 const repo=join(home,'Workspace/neo/canonical-compat');
 const runtime=join(home,'.local/state/agents-relay/canonical-rust');
 const store=join(home,'.agents-relay');
 const run=join(repo,'runs/2026-11-16-l3');
 for(const p of [store,runtime,run,join(home,'.config/neo')])mkdirSync(p,{recursive:true});
 chmodSync(runtime,0o700);
 writeFileSync(join(runtime,'.canonical-relay-owner-v1'),'canonical-rust-operator-approved-v1\n');
 writeFileSync(join(home,'.config/neo/workspace.json'),JSON.stringify({schemaVersion:1,neoRoot:join(home,'Workspace/neo')}));
 assert.equal(exec('git',['-C',repo,'init','-q'],process.env).status,0);
 const db=join(store,'relay.sqlite');
 const source=process.env.RELAY_CANONICAL_SOURCE_DB;
 if(source){
  // SQLite online backup is a consistent snapshot. The production DB is NEVER
  // opened for writing, and tests run under an independent HOME and process lock.
  const copied=exec('sqlite3',[source,`.backup '${sqlLiteral(db)}'`],process.env);
  assert.equal(copied.status,0,copied.stderr);
 }else{
  const sqlite=new DatabaseSync(db);
  sqlite.exec(`CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL);
   CREATE TABLE source_registry(job_id TEXT PRIMARY KEY,source_file TEXT NOT NULL UNIQUE,repository TEXT NOT NULL,pr_number INTEGER NOT NULL);
   CREATE TABLE relay_meta(scope_job_id TEXT NOT NULL REFERENCES source_registry(job_id),key TEXT,value TEXT,PRIMARY KEY(scope_job_id,key));
   CREATE TABLE sequences(repository TEXT,kind TEXT,value INTEGER,PRIMARY KEY(repository,kind));
   INSERT INTO sequences VALUES('*','job',95);
   INSERT INTO sequences VALUES('*','task',110);`);
  const legacy={id:'95',repository:'node-legacy',title:'Existing Node Job',state:'ACTIVE',
   projectRoot:'/node/legacy/root',createdAt:'2026-11-15T12:00:00.000Z',updatedAt:'2026-11-15T12:00:00.000Z',
   tasks:[{id:'110',state:'RUNNING',leaseOwner:'node-legacy'}]};
  sqlite.prepare('INSERT INTO job_snapshot VALUES(?,?,?)').run('95',JSON.stringify(legacy),legacy.updatedAt);
  sqlite.prepare('INSERT INTO source_registry VALUES(?,?,?,?)').run('95','unified:95','node-legacy',0);
  sqlite.close();
 }
 chmodSync(db,0o600);
 const graph=join(repo,'graph.mmd'),objective=join(run,'objective.md'),input=join(run,'input.md'),output=join(run,'result.json');
 writeFileSync(graph,'flowchart TD\n  A[agent:source] --> B[agent:designer]\n  B --> C[agent:face]\n  C --> D[agent:motion]\n');
 writeFileSync(objective,'Native Rust L3 Coordinator with original Relay SQLite schema\n');
 writeFileSync(input,'Four real, verified per-Agent Task executions\n');
 const worker=join(repo,'worker.mjs');
 writeFileSync(worker,`import {readFileSync,writeFileSync} from 'node:fs';
const req=JSON.parse(readFileSync(process.env.RELAY_TASK_REQUEST_PATH,'utf8'));
writeFileSync(process.env.RELAY_RESULT_PATH,JSON.stringify({jobId:req.jobId,taskId:req.taskId,
executionId:req.executionId,status:'COMPLETED',output:{verified:true,agent:req.agentName}}));\n`);
 const agents={};
 for(const name of ['source','designer','face','motion'])agents[name]={kind:'script',executable:process.execPath,args:[worker]};
 writeFileSync(join(runtime,'manifest.json'),JSON.stringify({agents}));
 const env={...process.env,HOME:home,RELAY_RUST_LIVE_MODE:'canonical-live',RELAY_RUST_EXPERIMENTAL_TEST_ONLY:''};
 return {home,repo,db,run,graph,objective,input,output,runtime,env};
}

test('real Node-schema SQLite copy: Rust Coordinator four-agent foreground L3, global IDs, legacy protection',()=>{
 const f=makeFixture();
 try{
  const sqlite=new DatabaseSync(f.db);
  const before=sqlite.prepare('SELECT COUNT(*) AS count FROM job_snapshot').get().count;
  const priorJobSeq=sqlite.prepare("SELECT value FROM sequences WHERE repository='*' AND kind='job'").get().value;
  const priorTaskSeq=sqlite.prepare("SELECT value FROM sequences WHERE repository='*' AND kind='task'").get().value;
  const legacy=sqlite.prepare('SELECT job_id,json FROM job_snapshot ORDER BY CAST(job_id AS INT) LIMIT 1').get();
  const args=['job','create','--db',f.db,'--repo','canonical-compat','--project-root',f.repo,'--project-path','.',
   '--title','Canonical Rust Coordinator L3','--objective-file',f.objective,'--coordinator-graph-file',f.graph,
   '--coordinator-input-file',f.input,'--coordinator-output-path',f.output,'--coordinator-project-root',f.repo,
   '--coordinator-workspace-root',join(f.home,'Workspace/neo'),'--coordinator-shared-root',join(f.home,'Workspace/neo'),
   '--idempotency-key','canonical-l3-run','--no-review','--no-github'];
  // A malformed graph outside the trusted project is refused without allocating IDs.
  const outside=join(f.home,'outside.mmd');writeFileSync(outside,'flowchart TD\n A[agent:a]\n');
  const bad=[...args];bad[bad.indexOf('--coordinator-graph-file')+1]=outside;
  assert.notEqual(exec(cli,bad,f.env).status,0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM job_snapshot').get().count,before);
  const first=exec(cli,args,f.env);assert.equal(first.status,0,first.stderr);
  const created=JSON.parse(first.stdout);
  assert.equal(created.created,true);
  assert.ok(Number(created.jobId)>priorJobSeq);
  assert.ok(Number(created.taskId)>priorTaskSeq);
  assert.equal(created.id,created.jobId);
  const replay=exec(cli,args,f.env);assert.equal(replay.status,0,replay.stderr);
  assert.equal(JSON.parse(replay.stdout).created,false);
  assert.equal(JSON.parse(replay.stdout).jobId,created.jobId);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM job_snapshot').get().count,before+1);
  const newJob=JSON.parse(sqlite.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get(created.jobId).json);
  ensureUnifiedJobRegistry(sqlite,newJob,created.jobId);
  const registry=sqlite.prepare('SELECT repository,source_file FROM source_registry WHERE job_id=?').get(created.jobId);
  assert.equal(registry.repository,'canonical-compat');
  assert.equal(registry.source_file,'unified:'+created.jobId);
  const returned=exec(cli,['job','show','--db',f.db,'--repo','canonical-compat','--id',created.jobId],f.env);
  assert.equal(returned.status,0,returned.stderr);
  assert.equal(JSON.parse(returned.stdout).id,created.jobId);
  const run=exec(cli,['job','run','--db',f.db,'--repo','canonical-compat','--id',created.jobId,
   '--task-id',created.taskId,'--project-path',f.repo,'--workspace-root',join(f.home,'Workspace/neo'),
   '--shared-root',join(f.home,'Workspace/neo'),'--foreground','--no-github',
   '--helper',helper,'--interval-ms','100','--max-ticks','45','--concurrency','4'],f.env,45000);
  assert.equal(run.status,0,run.stderr+'\n'+run.stdout.slice(-2500));
  const lines=run.stdout.trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(lines.at(-1).event,'job.foreground.terminal');
  assert.equal(lines.at(-1).state,'COMPLETED');
  const final=JSON.parse(sqlite.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get(created.jobId).json);
  assert.equal(final.state,'COMPLETED');
  assert.equal(final.runtimeStatus,'COMPLETED');
  assert.equal(final.tasks.length,5);
  assert.deepEqual(final.tasks.map(task=>task.title),['Coordinator','source','designer','face','motion']);
  assert.ok(final.tasks.every(task=>task.state==='SUCCEEDED'));
  assert.equal(sqlite.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get(legacy.job_id).json,legacy.json,
   'native daemon never modifies preexisting Node Job or its active lease');
  assert.equal(sqlite.prepare('PRAGMA quick_check').get().quick_check,'ok');
  sqlite.close();
 }finally{rmSync(f.home,{recursive:true,force:true})}
});
