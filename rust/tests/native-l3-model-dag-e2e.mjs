import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,realpathSync,rmSync,chmodSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

const target=process.env.CARGO_TARGET_DIR??resolve(import.meta.dirname,'../target');
const cli=join(target,'debug/relay-native-job');
const helper=join(target,'debug/relay-worker-helper');
const nativeModel=join(target,'debug/relay-native-model-worker');
const generator=join(target,'debug/relay-native-agent-manifest');
const app=resolve(import.meta.dirname,'../..');
function call(executable,args,env,timeout=45000){
 const result=spawnSync(executable,args,{encoding:'utf8',env,timeout,maxBuffer:4*1024*1024});
 assert.equal(result.status,0,result.stderr||result.stdout);
 return JSON.parse(result.stdout.trim().split('\n').at(-1));
}
test('L3 Rust canonical Toy DAG: four bound Model Workers plus Final Review approve with original Graph and SQLite',()=>{
 const home=realpathSync(mkdtempSync('/tmp/relay-rust-l3-model-'));
 const project=join(home,'Workspace/neo/toyalive-3d');
 const run=join(project,'runs/2026-11-16-model');
 const root=join(home,'.local/state/agents-relay/canonical-rust');
 const db=join(home,'.agents-relay/relay.sqlite');
 try{
  for(const folder of [run,root,join(home,'.agents-relay'),join(home,'.config/neo'),join(project,'agents')]){
   mkdirSync(folder,{recursive:true});
  }
  chmodSync(root,0o700);
  writeFileSync(join(root,'.canonical-relay-owner-v1'),'canonical-rust-operator-approved-v1\n');
  writeFileSync(join(home,'.config/neo/workspace.json'),JSON.stringify({schemaVersion:1,neoRoot:join(home,'Workspace/neo')}));
  assert.equal(spawnSync('git',['-C',project,'init','-q'],{encoding:'utf8'}).status,0);
  for(const agent of ['builder','coordinate-calibration','designer','face']){
   writeFileSync(join(project,'agents',agent+'.agent.md'),`Agent ${agent}: carry out real authorized Task and report evidence.\n`);
  }
  const graph=join(project,'graph.mmd');
  writeFileSync(graph,'flowchart TD\n build[agent:builder] --> coords[agent:coordinate-calibration]\n coords --> design[agent:designer]\n design --> face[agent:face]\n');
  const input=join(run,'input.md'),objective=join(run,'objective.md'),output=join(run,'output.json');
  writeFileSync(input,'Four physical Model subprocesses, verified terminal receipts');
  writeFileSync(objective,'Exercise real native Model Worker protocol end to end');
  const sql=new DatabaseSync(db);
  sql.exec(`CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL);
   CREATE TABLE source_registry(job_id TEXT PRIMARY KEY,source_file TEXT NOT NULL UNIQUE,repository TEXT NOT NULL,pr_number INTEGER NOT NULL);
   CREATE TABLE relay_meta(scope_job_id TEXT NOT NULL REFERENCES source_registry(job_id),key TEXT,value TEXT,PRIMARY KEY(scope_job_id,key));
   CREATE TABLE sequences(repository TEXT,kind TEXT,value INTEGER,PRIMARY KEY(repository,kind));
   INSERT INTO sequences VALUES('*','job',631); INSERT INTO sequences VALUES('*','task',1873);`);
  sql.close();chmodSync(db,0o600);
  // Final Review must bind an actually committed local Git HEAD.
  assert.equal(spawnSync('git',['-C',project,'add','-A'],{encoding:'utf8'}).status,0);
  const committed=spawnSync('git',['-c','user.name=Rust L3 Fixture','-c','user.email=rust-l3@localhost',
    '-C',project,'commit','-q','-m','l3: reference model artifacts'],{encoding:'utf8'});
  assert.equal(committed.status,0,committed.stderr);
  const head=spawnSync('git',['-C',project,'rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim();
  assert.match(head,/^[0-9a-f]{40}$/);
  const fakeCodex=join(root,'codex-fixture');
  writeFileSync(fakeCodex,`#!/bin/sh
set -eu
[ "$1" = exec ] || exit 17
shift
summary=''
while [ "$#" -gt 0 ]; do
 if [ "$1" = '--output-last-message' ]; then shift; summary="$1"; fi
 shift
done
prompt=$(cat)
if printf '%s' "$prompt" | grep -q 'Final Review structured output contract'; then
  printf '{"verdict":"approved","head_sha":"${head}","findings":[]}\\n' > "$summary"
else
  printf 'Mock external provider processed one specific real Model Worker execution.\\n' > "$summary"
fi
`);
  chmodSync(fakeCodex,0o700);
  const env={...process.env,HOME:home,RELAY_RUST_LIVE_MODE:'canonical-live'};
  const prompt=join(app,'dist/cli.js');
  const manifest=join(root,'manifest.json');
  const generated=call(generator,[
   '--neo-root',join(home,'Workspace/neo'),'--model-worker',nativeModel,
   '--codex',fakeCodex,'--prompt-cli',prompt,'--prompt-node',process.execPath,
   '--model','gpt-6-luna','--route-at','2026-11-16T19:00:00Z','--output',manifest],env);
  assert.equal(generated.agentRoles,7);
  const created=call(cli,['job','create','--db',db,'--repo','toyalive-3d',
   '--project-root',project,'--project-path','.',
   '--title','Canonical ToyAlive Model four-stage L3',
   '--objective-file',objective,'--coordinator-graph-file',graph,'--coordinator-input-file',input,
   '--coordinator-output-path',output,'--coordinator-project-root',project,
   '--coordinator-workspace-root',join(home,'Workspace/neo'),
   '--coordinator-shared-root',join(home,'Workspace/neo'),
   '--no-github'],env);
  const started=spawnSync(cli,['job','run','--db',db,'--repo','toyalive-3d',
   '--id',created.jobId,'--task-id',created.taskId,'--project-path',project,
   '--workspace-root',join(home,'Workspace/neo'),'--shared-root',join(home,'Workspace/neo'),
   '--foreground','--no-github','--helper',helper,'--manifest',manifest,
   '--interval-ms','100','--max-ticks','35','--concurrency','4'],{
    encoding:'utf8',env,timeout:30000,maxBuffer:4*1024*1024});
  assert.equal(started.status,0,started.stderr+'\n'+started.stdout.slice(-2500));
  const lines=started.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(lines.at(-1).state,'COMPLETED');
  const check=new DatabaseSync(db);
  const job=JSON.parse(check.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get(created.jobId).json);
  assert.equal(job.tasks.length,6);
  assert.deepEqual(job.tasks.slice(0,5).map(t=>t.title),['Coordinator','builder','coordinate-calibration','designer','face']);
  assert.equal(job.tasks[5].title,'Final Review');
  assert.equal(job.state,'COMPLETED');
  for(const task of job.tasks.slice(1,5)){
   assert.equal(task.adapter,'codex',JSON.stringify(task));
   assert.equal(task.state,'SUCCEEDED');
   assert.equal(task.routing.provider,'openai');
   assert.equal(task.routing.model,'gpt-6-luna');
   assert.equal(task.workerSelection.adapter,'codex');
   assert.match(JSON.stringify(task.result),/Mock external provider processed/);
  }
  assert.equal(check.prepare('PRAGMA quick_check').get().quick_check,'ok');
  assert.equal(job.review.outcome,'approved');
  assert.equal(job.review.headSha,head);
  assert.equal(job.tasks[5].state,'SUCCEEDED');
  assert.equal(job.tasks[5].reviewHeadSha,head);
  assert.equal(check.prepare("SELECT value FROM sequences WHERE repository='*' AND kind='task'").get().value,1879);
  check.close();
 } finally {rmSync(home,{recursive:true,force:true});}
});
