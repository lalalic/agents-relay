import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync,realpathSync,mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,chmodSync,copyFileSync,symlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';

const neoModule=process.env.NEO_PROJECT_RUN_MODULE ?? join(homedir(),'Workspace/neo/.bin/neo-project-run.mjs');
const target=resolve(process.env.CARGO_TARGET_DIR??join(import.meta.dirname,'../target'));
const relayCli=join(target,'debug/relay-native-job');
const workerHelper=join(target,'debug/relay-worker-helper');

// This is the real (unmocked) Neo Project command implementation, executing
// Rust CLI + physical Worker Helper against a disposable canonical SQLite file.
// The production Neo root and canonical database are never mutated.
test('Neo project run --foreground invokes real Rust Coordinator and completes four native Tasks',
 {skip:!existsSync(neoModule)}, async()=>{
 const home=realpathSync(mkdtempSync('/tmp/relay-neo-foreground-'));
 const neo=join(home,'Workspace/neo');
 const project=join(neo,'vlog');
 const run=join(project,'runs','2026-11-16-neo-canonical-l3');
 const runtime=join(home,'.local/state/agents-relay/canonical-rust');
 const db=join(home,'.agents-relay/relay.sqlite');
 try{
  for(const path of [run,runtime,join(home,'.agents-relay')])mkdirSync(path,{recursive:true});
  chmodSync(runtime,0o700);
  writeFileSync(join(runtime,'.canonical-relay-owner-v1'),'canonical-rust-operator-approved-v1\n');
  writeFileSync(join(project,'AGENTS.md'),'Test project contract only\n');
  writeFileSync(join(project,'README.md'),'Synthetic no-review native Coordinator\n');
  writeFileSync(join(project,'graph.mmd'),'flowchart TD\n A[agent:source] --> B[agent:designer]\n B --> C[agent:face]\n C --> D[agent:motion]\n');
  writeFileSync(join(project,'project.run.json'),JSON.stringify({schemaVersion:1,input:{type:'path',path:{base:'runs',datedRunDirectory:true}}}));
  writeFileSync(join(run,'source-manifest.json'),JSON.stringify({source_use:{approved:true,scope:'private synthetic test only'}}));
  assert.equal(spawnSync('git',['init','-q',project],{encoding:'utf8'}).status,0);
  const d=new DatabaseSync(db);
  d.exec(`CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE source_registry(job_id TEXT PRIMARY KEY,source_file TEXT NOT NULL UNIQUE,repository TEXT NOT NULL,pr_number INTEGER NOT NULL);
    CREATE TABLE relay_meta(scope_job_id TEXT NOT NULL REFERENCES source_registry(job_id),key TEXT,value TEXT,PRIMARY KEY(scope_job_id,key));
    CREATE TABLE sequences(repository TEXT,kind TEXT,value INTEGER,PRIMARY KEY(repository,kind));
    INSERT INTO sequences VALUES('*','job',631); INSERT INTO sequences VALUES('*','task',1873);`);
  d.close();chmodSync(db,0o600);
  const worker=join(project,'worker.mjs');
  writeFileSync(worker,`import {readFileSync,writeFileSync} from 'node:fs';
const req=JSON.parse(readFileSync(process.env.RELAY_TASK_REQUEST_PATH,'utf8'));
writeFileSync(process.env.RELAY_RESULT_PATH,JSON.stringify({jobId:req.jobId,
 taskId:req.taskId,executionId:req.executionId,status:'COMPLETED',output:{verified:true,agent:req.agentName}}));\n`);
  const agents={};
  for(const name of ['source','designer','face','motion'])agents[name]={kind:'script',executable:process.execPath,args:[worker]};
  writeFileSync(join(runtime,'manifest.json'),JSON.stringify({agents}));
  // Exercise the EXACT Rust production CLI shell wrapper, not a simplified
  // hand-written test shim. Isolate HOME through Neo's test spawn port so the
  // wrapper resolves the disposable SQLite and durable manifest.
  const wrapper=join(runtime,'relay-entry');
  copyFileSync(resolve(import.meta.dirname,'../scripts/agents-relay-native-cli.sh'),wrapper);
  symlinkSync(relayCli,join(runtime,'relay-native-job'));
  symlinkSync(workerHelper,join(runtime,'relay-worker-helper'));
  chmodSync(wrapper,0o700);
  const spawnTest=(cmd,args,options)=>spawnSync(cmd,args,{
   ...options,env:{...process.env,...options?.env,HOME:home},
  });
  const {runProject}=await import(pathToFileURL(neoModule).href);
  const messages=[];
  const workspace={neoRoot:neo,harnessRoot:neo};
  await runProject(['--path',run,'--project','vlog','--foreground','--no-review'],{
   workspace,relayExecutable:wrapper,spawnSyncImpl:spawnTest,emit:message=>messages.push(message)});
  assert.equal(messages.length,1);
  const reported=JSON.parse(messages[0]);
  assert.equal(reported.project,'vlog');
  assert.equal(reported.foreground,true);
  const record=JSON.parse(readFileSync(join(run,'.neo-project-run.json'),'utf8'));
  assert.equal(record.jobId,reported.jobId);
  assert.equal(record.taskId,reported.taskId);
  const c=new DatabaseSync(db);
  const job=JSON.parse(c.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get(record.jobId).json);
  assert.equal(job.state,'COMPLETED');
  assert.deepEqual(job.tasks.map(t=>t.title),['Coordinator','source','designer','face','motion']);
  assert.ok(job.tasks.every(t=>t.state==='SUCCEEDED'));
  assert.equal(c.prepare('SELECT repository FROM source_registry WHERE job_id=?').get(record.jobId).repository,'vlog');
  assert.equal(c.prepare("SELECT value FROM sequences WHERE kind='job' AND repository='*'").get().value,632);
  assert.equal(c.prepare("SELECT value FROM sequences WHERE kind='task' AND repository='*'").get().value,1878);
  c.close();
  // The second run is bound to its original Job; it may not allocate a new one.
  const resumed=[];
  await runProject(['--path',run,'--project','vlog','--foreground','--no-review'],{
   workspace,relayExecutable:wrapper,spawnSyncImpl:spawnTest,emit:message=>resumed.push(message)});
  const resume=JSON.parse(resumed[0]);
  assert.equal(resume.jobId,record.jobId);
  assert.equal(resume.reused,true);
 }finally{rmSync(home,{recursive:true,force:true})}
});
