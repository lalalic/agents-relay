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

test('plan apply rejects invalid dependency DAG and unsupported valid materialization without changing durable Plan', () => {
  const f = fixture();
  try {
    seedPlanningRound(f.db, f.created.jobId);
    const apply = (proposal) => { const file=join(f.root,'candidate.json');writeFileSync(file,JSON.stringify(proposal));return call(['plan','apply','--db',f.db,'--id',f.created.jobId,'--plan-id','plan-1','--execution-id','plan-exec-1','--file',file],2); };
    const cycle=apply({objective_status:'in_progress',assessment:'cycle',unblocks:[],next_tasks:[{id:'a',dependencies:['b']},{id:'b',dependencies:['a']}]});
    assert.match(cycle.stderr,/dependency cycle/);
    const state=JSON.parse(call(['plan','context','--db',f.db,'--id',f.created.jobId,'--plan-id','plan-1','--execution-id','plan-exec-1']).stdout);
    assert.equal(state.plan.status,'PLANNING'); assert.equal(state.job.tasks.length,1);
    const validButUnsupported=apply({objective_status:'in_progress',assessment:'work',unblocks:[],next_tasks:[{id:'a',dependencies:[]}]});
    assert.match(validButUnsupported.stderr,/cannot materialize next_tasks/);
    const final=JSON.parse(call(['plan','context','--db',f.db,'--id',f.created.jobId,'--plan-id','plan-1','--execution-id','plan-exec-1']).stdout);
    assert.equal(final.plan.status,'PLANNING');
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
