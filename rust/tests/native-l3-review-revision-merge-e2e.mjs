import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,chmodSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

const target=process.env.CARGO_TARGET_DIR??resolve(import.meta.dirname,'../target');
const cli=join(target,'debug/relay-native-job');
const daemon=join(target,'debug/relay-native-daemon');
const helper=join(target,'debug/relay-worker-helper');
const model=join(target,'debug/relay-native-model-worker');
const app=resolve(import.meta.dirname,'../..');
function command(bin,args,env,options={}){
 const p=spawnSync(bin,args,{encoding:'utf8',env,timeout:45000,maxBuffer:8*1024*1024,...options});
 assert.equal(p.status,0,`${args.join(' ')}\n${p.stderr}\n${p.stdout?.slice(-3000)}`);
 return p.stdout.trim()?JSON.parse(p.stdout.trim().split('\n').at(-1)):null;
}

test('canonical Rust L3: changes-required Review -> bound Plan -> physical Git revision -> new SHA -> re-review -> verified local Git merge -> Job COMPLETED',()=>{
 const home=realpathSync(mkdtempSync('/tmp/relay-l3-review-replan-'));
 const project=join(home,'Workspace/neo/real-review-replan');
 const run=join(project,'runs/revision');
 const root=join(home,'.local/state/agents-relay/canonical-rust');
 const db=join(home,'.agents-relay/relay.sqlite');
 try{
  for(const folder of [run,root,join(home,'.agents-relay'),join(home,'.config/neo'),join(project,'agents')])mkdirSync(folder,{recursive:true});
  chmodSync(root,0o700);
  writeFileSync(join(root,'.canonical-relay-owner-v1'),'canonical-rust-operator-approved-v1\n');
  writeFileSync(join(home,'.config/neo/workspace.json'),JSON.stringify({schemaVersion:1,neoRoot:join(home,'Workspace/neo')}));
  command('git',['-C',project,'init','-q','-b','main'],process.env);
  for(const role of ['builder','designer','face','fixer'])writeFileSync(join(project,'agents',role+'.agent.md'),`Agent ${role}: perform exactly your Task and report auditable results.\n`);
  const graph=join(project,'graph.mmd');
  writeFileSync(graph,'flowchart TD\n build[agent:builder] --> design[agent:designer]\n design --> face[agent:face]\n');
  const objective=join(run,'objective.md'),input=join(run,'input.md'),output=join(run,'output.json');
  writeFileSync(objective,'Create an original model and address explicit review findings, then verify committed local HEAD');
  writeFileSync(input,'Three physical stages and a later reviewer-demanded corrective Plan');
  writeFileSync(join(project,'source.txt'),'Initial version; reviewer should request a correction.\n');
  const originalWorker=join(project,'original-worker.mjs');
  writeFileSync(originalWorker,`import {readFileSync,writeFileSync} from 'node:fs';
const r=JSON.parse(readFileSync(process.env.RELAY_TASK_REQUEST_PATH,'utf8'));
writeFileSync(process.env.RELAY_RESULT_PATH,JSON.stringify({type:'task.completed',jobId:r.jobId,
 taskId:r.taskId,executionId:r.executionId,leaseOwner:r.leaseOwner,attempt:r.attempt,
 adapter:r.adapter,status:'COMPLETED',summary:'Original physical worker completed',
 output:{verified:true,stage:r.agentName}}));\n`);
  command('git',['-C',project,'add','-A'],process.env);
  command('git',['-C',project,'-c','user.name=Rust L3','-c','user.email=l3@localhost','commit','-q','-m','Original model evidence'],process.env);
  const originalMain=spawnSync('git',['-C',project,'rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim();
  command('git',['-C',project,'checkout','-q','-b','feature'],process.env);
  const head1=spawnSync('git',['-C',project,'rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim();
  assert.match(head1,/^[0-9a-f]{40}$/);
  writeFileSync(join(root,'first-review'),'first review must request changes');
  const fakeCodex=join(root,'fake-model-provider');
  writeFileSync(fakeCodex,`#!/bin/sh
set -eu
[ "$1" = exec ] || exit 15
shift
summary=''
while [ "$#" -gt 0 ]; do
 if [ "$1" = '--output-last-message' ]; then shift; summary="$1"; fi
 shift
done
prompt=$(cat)
if printf '%s' "$prompt" | grep -q 'Final Review structured output contract'; then
 head=$(git rev-parse HEAD)
 if [ -f '${root}/first-review' ]; then
   rm '${root}/first-review'
   printf '{"verdict":"changes_required","head_sha":"%s","findings":[{"id":"texture-fix","summary":"Correct the source texture with committed evidence"}]}\\n' "$head" > "$summary"
 else
   printf '{"verdict":"approved","head_sha":"%s","findings":[]}\\n' "$head" > "$summary"
 fi
elif printf '%s' "$prompt" | grep -q 'Implement the requested reviewer texture correction'; then
 printf 'Verified correction from genuine external Model Worker.\\n' > '${project}/fix.txt'
 git add fix.txt
 git -c user.name='Rust L3' -c user.email='l3@localhost' commit -q -m 'Apply approved Plan corrective work'
 printf 'Implemented the requested correction and committed Git HEAD.\\n' > "$summary"
else
 printf 'Unexpected Agent role request: denied.\\n' > "$summary"
 exit 21
fi
`);
  chmodSync(fakeCodex,0o700);
  const sql=new DatabaseSync(db);
  sql.exec(`CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL);
   CREATE TABLE source_registry(job_id TEXT PRIMARY KEY,source_file TEXT NOT NULL UNIQUE,repository TEXT NOT NULL,pr_number INTEGER NOT NULL);
   CREATE TABLE relay_meta(scope_job_id TEXT NOT NULL REFERENCES source_registry(job_id),key TEXT,value TEXT,PRIMARY KEY(scope_job_id,key));
   CREATE TABLE sequences(repository TEXT,kind TEXT,value INTEGER,PRIMARY KEY(repository,kind));
   INSERT INTO sequences VALUES('*','job',631); INSERT INTO sequences VALUES('*','task',1873);`);
  sql.close();chmodSync(db,0o600);
  const routing={provider:'openai',model:'gpt-6-luna',decidedBy:'fixture-native-router',decidedAt:'2026-11-16T20:00:00Z'};
  const workerSelection={adapter:'codex',workerId:'fixture-model-cli',selectedBy:'fixture-native-router',selectedAt:'2026-11-16T20:00:00Z'};
  const agents={};
  for(const agent of ['builder','designer','face'])agents[agent]={kind:'script',executable:process.execPath,args:[originalWorker]};
  for(const role of ['job-acceptance-reviewer','fixer'])agents[role]={kind:'model',executable:model,
   args:[],env:{HOME:home,CODEX_EXECUTABLE:fakeCodex},routing,workerSelection,
   promptCli:join(app,'dist/cli.js'),promptNode:process.execPath};
  const manifest=join(root,'manifest.json');writeFileSync(manifest,JSON.stringify({agents}));
  const env={...process.env,HOME:home,RELAY_RUST_LIVE_MODE:'canonical-live'};
  const created=command(cli,['job','create','--db',db,'--repo','real-review-replan','--project-root',project,
   '--objective-file',objective,'--title','Review Revision and Verified Completion L3',
   '--coordinator-graph-file',graph,'--coordinator-input-file',input,
   '--coordinator-output-path',output,'--coordinator-project-root',project,
   '--coordinator-workspace-root',join(home,'Workspace/neo'),'--coordinator-shared-root',join(home,'Workspace/neo'),
   '--no-github'],env);
  assert.equal(created.jobId,'632');
  // Use an explicit local Git merge intent, as in Node's canonical no-GitHub
  // Job configuration. A review-directed new source SHA may be learned later
  // from the verified current Git ref; no stale sourceSha is pre-authorized.
  {
   const dbh=new DatabaseSync(db);
   const row=dbh.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get(created.jobId);
   const j=JSON.parse(row.json);
   j.localMerge={sourceRef:'refs/heads/feature',targetRef:'refs/heads/main',status:'pending',attempts:0};
   dbh.prepare('UPDATE job_snapshot SET json=? WHERE job_id=?').run(JSON.stringify(j),created.jobId);
   dbh.close();
  }
  // Node Job Lifecycle Graph requires explicit DRAFT -> ACTIVE transition;
  // Scheduler must not bypass this gate just because a Task is QUEUED.
  const activated=command(cli,['activate','--db',db,'--job-id',created.jobId],env);
  assert.equal(activated.state,'ACTIVE');
  function snapshot(){const c=new DatabaseSync(db);try{return JSON.parse(c.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get(created.jobId).json);}finally{c.close();}}
  const reports=[];
  function tick(){const out=command(daemon,['--once','--db',db,'--manifest',manifest,'--helper',helper,'--max-tasks','4'],env);reports.push(out);return out;}
  function until(predicate,limit=32){for(let i=0;i<limit;i++){tick();const job=snapshot();if(predicate(job))return job;}const job=snapshot();throw Error('lifecycle not converged '+JSON.stringify({state:job.state,review:job.review,tasks:job.tasks.map(t=>[t.id,t.agentName,t.state,t.error]),last:reports.at(-1)}));}
  const first=until(j=>j.review?.outcome==='changes_required');
  assert.equal(first.state,'ACTIVE','changes_required must not merge or complete Job');
  const oldReviewId=first.review.taskId;
  assert.equal(first.review.headSha,head1);
  assert.equal(first.review.evidence.data.findings[0].id,'texture-fix');
  assert.equal(first.tasks.filter(t=>t.agentName==='job-acceptance-reviewer').length,1);
  // A review-trigger is authorized by durable changes_required and its exact Reviewer Task.
  assert.match(spawnSync(cli,['plan','request','--db',db,'--id',created.jobId,'--repo','real-review-replan',
   '--trigger','invalid'],{env,encoding:'utf8'}).stderr,/--trigger must be manual or review/);
  const planned=command(cli,['plan','request','--db',db,'--id',created.jobId,'--repo','real-review-replan',
   '--trigger','review','--prompt','Correct exactly the actionable current-head reviewer findings'],env);
  assert.equal(planned.planId,'plan-1');
  assert.equal(planned.plan.trigger.source,'review');
  assert.equal(planned.plan.trigger.reviewTaskId,oldReviewId);
  const proposed=join(root,'review-fix-plan.json');
  writeFileSync(proposed,JSON.stringify({objective_status:'in_progress',assessment:'The specific current HEAD has one outstanding finding',unblocks:[],next_tasks:[
    {id:'local-correction',title:'Implement the requested reviewer texture correction',
     input:'Implement the requested reviewer texture correction. Commit a new Git HEAD.',agentName:'fixer',adapter:'codex',
     output:{kind:'file',path:'fix.txt'},dependencies:[],storySize:'S'}
  ]}));
  const applied=command(cli,['plan','apply','--db',db,'--id',created.jobId,'--repo','real-review-replan',
   '--plan-id',planned.planId,'--execution-id',planned.executionId,'--file',proposed],env);
  assert.equal(applied.job.plans[0].status,'SUCCEEDED');
  assert.equal(applied.job.plans[0].generatedTaskIds.length,1);
  const fixed=until(j=>j.tasks.some(t=>t.agentName==='fixer'&&t.state==='SUCCEEDED'));
  const head2=spawnSync('git',['-C',project,'rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim();
  assert.notEqual(head2,head1,'physical corrective Model Worker committed a new Git SHA');
  assert.equal(fixed.plans[0].trigger.reviewTaskId,oldReviewId);
  assert.equal(fixed.tasks.find(t=>t.agentName==='fixer').planningDecisionId,planned.planId);
  const terminal=until(j=>j.state==='COMPLETED',40);
  assert.equal(terminal.review.outcome,'approved');
  assert.equal(terminal.review.headSha,head2);
  assert.notEqual(terminal.review.taskId,oldReviewId);
  const reviewers=terminal.tasks.filter(t=>t.agentName==='job-acceptance-reviewer');
  assert.equal(reviewers.length,2);
  assert.ok(reviewers.every(t=>t.state==='SUCCEEDED'));
  assert.deepEqual(reviewers.map(t=>t.reviewHeadSha),[head1,head2]);
  assert.equal(terminal.plans[0].generatedTaskIds[0],terminal.tasks.find(t=>t.agentName==='fixer').id);
  assert.equal(terminal.runtimeStatus,'COMPLETED');
  assert.equal(terminal.localMerge.status,'succeeded');
  assert.equal(terminal.localMerge.sourceSha,head2);
  assert.equal(terminal.localMerge.previousTargetSha,originalMain);
  const merged=spawnSync('git',['-C',project,'rev-parse','refs/heads/main'],{encoding:'utf8'}).stdout.trim();
  assert.equal(terminal.localMerge.mergedCommitSha,merged);
  assert.deepEqual(spawnSync('git',['-C',project,'rev-list','--parents','-n','1',merged],{encoding:'utf8'}).stdout.trim().split(' '),
   [merged,originalMain,head2]);
  const c=new DatabaseSync(db);
  assert.ok(c.prepare('SELECT payload_json FROM workflow_event_outbox').all()
   .some(row=>JSON.parse(row.payload_json).type==='job.merge.succeeded'));
  assert.equal(c.prepare('PRAGMA quick_check').get().quick_check,'ok');c.close();
 }finally{rmSync(home,{recursive:true,force:true});}
});
