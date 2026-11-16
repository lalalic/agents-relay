import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const bin = join(process.env.CARGO_TARGET_DIR ?? resolve(import.meta.dirname, '../target'), 'debug/relay-native-job');
const env = { ...process.env, RELAY_RUST_EXPERIMENTAL_TEST_ONLY: 'isolated-test' };
function call(args, status = 0) {
  const result = spawnSync(bin, args, { encoding: 'utf8', env, timeout: 25000 });
  assert.equal(result.status, status, result.stderr || result.stdout);
  return result;
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'relay-rust-authority-'));
  mkdirSync(join(root, 'project'));
  writeFileSync(join(root, '.relay-rust-authority-isolated-test'), 'isolated-test');
  writeFileSync(join(root, 'graph.mmd'), 'flowchart TD\na[agent:builder]\n');
  writeFileSync(join(root, 'input.md'), 'planner CLI fixture');
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ agents: { builder: { kind: 'script', executable: process.execPath, args: ['-e', 'process.exit(0)'] } } }));
  const helper = join(bin, '..', 'relay-worker-helper');
  const db = join(root, 'relay.sqlite');
  call(['init', '--db', db]);
  const created = call(['create', '--db', db, '--project-root', join(root, 'project'), '--graph-file', join(root, 'graph.mmd'), '--input-file', join(root, 'input.md'), '--output-path', join(root, 'project/out.json'), '--title', 'CLI reconcile', '--repository', 'fixture', '--request-key', 'cli-reconcile-1']);
  return { root, db, helper, created: JSON.parse(created.stdout) };
}

function seedPlanningRound(db, jobId, executionId = 'plan-exec-1') {
  const script = `import json,sqlite3,sys\nc=sqlite3.connect(sys.argv[1]); r=c.execute('select json from job_snapshot where job_id=?',(sys.argv[2],)).fetchone(); j=json.loads(r[0]); j['tasks'][0]['state']='SUCCEEDED'; j['tasks'][0]['agentName']='builder'; j['plans']=[{'jobId':sys.argv[2],'id':'plan-1','round':1,'source':'model-planner','previousPlanId':None,'trigger':{'source':'initial'},'status':'PLANNING','assessment':'','generatedTaskIds':[],'attempt':1,'leaseOwner':'planner-test','leaseExpiresAt':'2026-11-15T23:59:59.000Z','executionId':sys.argv[3],'createdAt':'2026-11-15T12:00:00.000Z','updatedAt':'2026-11-15T12:00:00.000Z'}]; c.execute('update job_snapshot set json=? where job_id=?',(json.dumps(j),sys.argv[2])); c.commit()`;
  const result = spawnSync('python3', ['-c', script, db, jobId, executionId], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

test('Planner context binds exact durable Plan execution; satisfied apply is atomic, idempotent, restart-readable, and fenced', () => {
  const f = fixture();
  try {
    seedPlanningRound(f.db, f.created.jobId);
    const ctxArgs = ['plan', 'context', '--db', f.db, '--id', f.created.jobId, '--repo', 'fixture', '--plan-id', 'plan-1', '--execution-id', 'plan-exec-1'];
    const context = JSON.parse(call(ctxArgs).stdout);
    assert.equal(context.jobId, f.created.jobId); assert.equal(context.executionId, 'plan-exec-1');
    assert.equal(context.plan.status, 'PLANNING'); assert.equal(context.plan.executionId, context.executionId);
    assert.deepEqual(JSON.parse(call(ctxArgs).stdout), context); // a fresh process re-reads the same durable round
    const stale = call([...ctxArgs.slice(0, -1), 'stale-execution'], 2);
    assert.match(stale.stderr, /stale Plan execution/);
    const proposal = join(f.root, 'satisfied.json');
    writeFileSync(proposal, JSON.stringify({ objective_status: 'satisfied', assessment: 'The durable objective is complete.', next_tasks: [], unblocks: [] }));
    const applyArgs = ['plan','apply','--db',f.db,'--id',f.created.jobId,'--repo','fixture','--plan-id','plan-1','--execution-id','plan-exec-1','--file',proposal];
    const applied = JSON.parse(call(applyArgs).stdout); assert.equal(applied.idempotent, false);
    const replay = JSON.parse(call(applyArgs).stdout); assert.equal(replay.idempotent, true);
    assert.equal(replay.job.plans[0].status, 'SUCCEEDED');
    assert.equal(replay.job.plans[0].appliedExecutionId,'plan-exec-1');
    assert.match(call(ctxArgs,2).stderr,/stale Plan execution/); // fresh CLI process sees the committed status
    const mismatchedArgs = [...applyArgs]; mismatchedArgs[mismatchedArgs.indexOf('plan-exec-1')] = 'other-execution';
    const mismatched = call(mismatchedArgs,2);
    assert.match(mismatched.stderr,/stale Plan execution/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('plan apply rejects invalid dependency DAG, atomically assigns global IDs and materializes executable children', () => {
  const f = fixture();
  try {
    seedPlanningRound(f.db, f.created.jobId);
    const apply = (proposal) => { const file=join(f.root,'candidate.json');writeFileSync(file,JSON.stringify(proposal));return call(['plan','apply','--db',f.db,'--id',f.created.jobId,'--plan-id','plan-1','--execution-id','plan-exec-1','--file',file],2); };
    const cycle=apply({objective_status:'in_progress',assessment:'cycle',unblocks:[],next_tasks:[
      {id:'a',title:'Validate the source assets for review',input:'Validate',agentName:'source',output:{kind:'task_pr'},dependencies:['b']},
      {id:'b',title:'Design and check detailed texture mapping',input:'Design',agentName:'designer',output:{kind:'task_pr'},dependencies:['a']}
    ]});
    assert.match(cycle.stderr,/dependency cycle/);
    const state=JSON.parse(call(['plan','context','--db',f.db,'--id',f.created.jobId,'--plan-id','plan-1','--execution-id','plan-exec-1']).stdout);
    assert.equal(state.plan.status,'PLANNING'); assert.equal(state.job.tasks.length,1);
    const input={objective_status:'in_progress',assessment:'Validated two-role DAG',unblocks:[],next_tasks:[
      {id:'local-source',title:'Prepare original source data for model',input:'Prepare source data',agentName:'source',adapter:'codex',output:{kind:'task_pr'},dependencies:[]},
      {id:'local-designer',title:'Apply a calibrated texture onto geometry',input:'Apply texture to source',agentName:'designer',adapter:'codex',output:{kind:'task_pr'},dependencies:['local-source']}
    ]};
    const proposal=join(f.root,'candidate.json');writeFileSync(proposal,JSON.stringify(input));
    const applyArgs=['plan','apply','--db',f.db,'--id',f.created.jobId,'--plan-id','plan-1','--execution-id','plan-exec-1','--file',proposal];
    const applied=JSON.parse(call(applyArgs).stdout);
    assert.equal(applied.idempotent,false);
    assert.equal(applied.job.plans[0].status,'SUCCEEDED');
    assert.equal(applied.job.plans[0].objectiveStatus,'in_progress');
    const children=applied.job.tasks.slice(1);
    assert.equal(children.length,2);
    assert.ok(children.every(t=>/^\d+$/.test(t.id)));
    assert.equal(children[0].planningDecisionId,'plan-1');
    assert.equal(children[0].planningRound,1);
    assert.deepEqual(children[1].dependencies,[children[0].id]);
    assert.deepEqual(applied.job.plans[0].generatedTaskIds,children.map(t=>t.id));
    const replay=JSON.parse(call(applyArgs).stdout);
    assert.equal(replay.idempotent,true);
    assert.deepEqual(replay.job.tasks.map(t=>t.id),applied.job.tasks.map(t=>t.id));
    assert.match(call([...applyArgs.slice(0,applyArgs.indexOf('--execution-id')+1),'stale-execution',...applyArgs.slice(applyArgs.indexOf('--execution-id')+2)],2).stderr,/stale or unauthorized Planner generation/);

  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('native reconcile replay is Graph/SQLite driven and rejects duplicate options', () => {
  const f = fixture();
  try {
    const args = ['reconcile', '--db', f.db, '--manifest', join(f.root, 'manifest.json'), '--helper', f.helper];
    const first = JSON.parse(call(args).stdout);
    const second = JSON.parse(call(args).stdout);
    assert.equal(first.jobsSeen, 1);
    assert.equal(second.jobsSeen, 1);
    assert.match(call([...args, '--db', f.db], 2).stderr, /duplicate option --db/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('Planner manually allocates plan-1 then plan-2 with durable execution fencing and globally numbered children',()=>{
 const f=fixture();
 try{
  const common=['--db',f.db,'--id',f.created.jobId,'--repo','fixture'];
  const first=JSON.parse(call(['plan','request',...common,'--prompt','Plan source and design responsibilities']).stdout);
  assert.equal(first.planId,'plan-1');
  assert.equal(first.plan.trigger.source,'manual');
  assert.equal(first.plan.attempt,1);
  assert.equal(first.idempotent,false);
  const replay=JSON.parse(call(['plan','request',...common,'--prompt','Plan source and design responsibilities']).stdout);
  assert.equal(replay.planId,first.planId);
  assert.equal(replay.executionId,first.executionId);
  assert.equal(replay.idempotent,true);
  assert.match(call(['plan','request',...common,'--prompt','Different instructions'],2).stderr,/different Planner generation/);
  const firstContext=JSON.parse(call(['plan','context',...common,'--plan-id',first.planId,'--execution-id',first.executionId]).stdout);
  assert.equal(firstContext.plan.status,'PLANNING');
  const firstCandidate=join(f.root,'round-1.json');
  writeFileSync(firstCandidate,JSON.stringify({objective_status:'in_progress',assessment:'Source and design still needed',unblocks:[],next_tasks:[
    {id:'source-alias',title:'Prepare normalized photographs for model input',input:'Read all photographs',agentName:'source',output:{kind:'task_pr'},dependencies:[]},
    {id:'design-alias',title:'Apply original texture on calibrated geometry',input:'Material and texture work',agentName:'designer',output:{kind:'task_pr'},dependencies:['source-alias']}
  ]}));
  const applyFirst=['plan','apply',...common,'--plan-id',first.planId,'--execution-id',first.executionId,'--file',firstCandidate];
  const committed=JSON.parse(call(applyFirst).stdout);
  assert.equal(committed.job.plans[0].objectiveStatus,'in_progress');
  assert.equal(committed.job.plans[0].generatedTaskIds.length,2);
  assert.equal(committed.job.plans[0].generatedTaskIds[0],committed.job.tasks[1].id);
  assert.equal(committed.job.plans[0].generatedTaskIds[1],committed.job.tasks[2].id);
  assert.equal(committed.job.tasks[1].state,'QUEUED');
  assert.equal(committed.job.tasks[2].state,'DRAFT');
  assert.deepEqual(committed.job.tasks[2].dependencies,[committed.job.tasks[1].id]);
  assert.equal(committed.job.tasks[1].planningRound,1);
  assert.equal(committed.job.state,'ACTIVE');
  assert.match(call(['plan','request',...common,'--prompt','A second round before work finished'],2).stderr,/wait for active implementation Tasks/);
  // Simulate known terminal Task evidence only for this pure Planner scheduling test.
  // Real Worker evidence is covered by native-l3-model-dag-e2e.mjs.
  const patch=`import json,sqlite3,sys\nc=sqlite3.connect(sys.argv[1]); r=c.execute('select json from job_snapshot where job_id=?',(sys.argv[2],)).fetchone();j=json.loads(r[0]);\nfor t in j['tasks']:t['state']='SUCCEEDED'\nc.execute('update job_snapshot set json=? where job_id=?',(json.dumps(j),sys.argv[2]));c.commit()`;
  assert.equal(spawnSync('python3',['-c',patch,f.db,f.created.jobId],{encoding:'utf8'}).status,0);
  const second=JSON.parse(call(['plan','request',...common,'--prompt','Check completion against durable evidence']).stdout);
  assert.equal(second.planId,'plan-2');
  assert.equal(second.plan.previousPlanId,'plan-1');
  assert.equal(second.plan.round,2);
  assert.notEqual(second.executionId,first.executionId);
  assert.equal(second.plan.status,'PLANNING');
  const satisfied=join(f.root,'round-2.json');
  writeFileSync(satisfied,JSON.stringify({objective_status:'satisfied',assessment:'All persisted implementation Tasks succeeded',next_tasks:[],unblocks:[]}));
  const finished=JSON.parse(call(['plan','apply',...common,'--plan-id',second.planId,'--execution-id',second.executionId,'--file',satisfied]).stdout);
  assert.equal(finished.job.plans.length,2);
  assert.equal(finished.job.plans[1].status,'SUCCEEDED');
  assert.equal(finished.job.plans[1].objectiveStatus,'satisfied');
  assert.equal(finished.job.tasks.length,3);
  assert.equal(finished.job.tasks[1].planningDecisionId,'plan-1');
  assert.match(call(['plan','apply',...common,'--plan-id',second.planId,'--execution-id',first.executionId,'--file',satisfied],2).stderr,/stale Plan execution/);
 }finally{rmSync(f.root,{recursive:true,force:true})}
});
