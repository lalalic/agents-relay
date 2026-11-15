import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

const exe = join(process.env.CARGO_TARGET_DIR ?? new URL('../target/', import.meta.url).pathname, 'debug/relay-native-job');
const graph = 'flowchart TD\n  S[agent:source] --> A[agent:left]\n  S --> B[agent:right]\n  A --> J[agent:join]\n  B --> J\n';
const input = '# Coordinator request\n\nPreserve all requirements.';
const env = { ...process.env, RELAY_RUST_EXPERIMENTAL_TEST_ONLY: 'isolated-test' };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'relay-rust-authority-job-create-'));
  writeFileSync(join(root, '.relay-rust-authority-isolated-test'), 'isolated-test');
  mkdirSync(join(root, 'project'));
  writeFileSync(join(root, 'graph.mmd'), graph);
  writeFileSync(join(root, 'input.md'), input);
  return { root, db: join(root, 'relay.sqlite') };
}
function invoke(v, args) {
  const overridden = new Set(args.filter((arg, index) => index > 0 && args[index - 1].startsWith('--')));
  const base = ['--db', v.db, '--repo', 'sample', '--objective', 'intake', '--coordinator-graph-file', join(v.root, 'graph.mmd'), '--coordinator-input-file', join(v.root, 'input.md'), '--coordinator-output-path', join(v.root, 'result.json'), '--coordinator-project-root', join(v.root, 'project'), '--coordinator-workspace-root', join(v.root, 'project'), '--no-github'];
  const filtered = base.filter((arg, index) => !arg.startsWith('--') || !overridden.has(arg));
  return spawnSync(exe, ['job', 'create', ...filtered, ...args], { encoding: 'utf8', env });
}
function init(v) { const r = spawnSync(exe, ['init', '--db', v.db], { encoding: 'utf8', env: { ...env, AGENTS_RELAY_STORE_DIR: v.root } }); assert.equal(r.status, 0, r.stderr); }

test('Rust Coordinator job create is atomic, graph-backed, idempotent and isolated', () => {
  const v = fixture();
  try {
    init(v);
    const invalid = invoke(v, ['--priority', 'P9']);
    assert.equal(invalid.status, 2, invalid.stderr);
    let sql = new DatabaseSync(v.db);
    try { assert.equal(sql.prepare('SELECT count(*) AS n FROM job_snapshot').get().n, 0); } finally { sql.close(); }
    const created = invoke(v, ['--idempotency-key', 'coord-e2e-1', '--tag', '{"kind":"test"}', '--no-review']);
    assert.equal(created.status, 0, created.stderr);
    const value = JSON.parse(created.stdout);
    assert.equal(value.created, true);
    const repeated = invoke(v, ['--idempotency-key', 'coord-e2e-1', '--tag', '{"kind":"test"}', '--no-review']);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.equal(JSON.parse(repeated.stdout).created, false);
    sql = new DatabaseSync(v.db);
    try {
      const job = JSON.parse(sql.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get(value.jobId).json);
      assert.equal(job.state, 'DRAFT');
      assert.equal(job.objective, input);
      assert.equal(job.reviewEnabled, false);
      assert.equal(job.autoMerge, true);
      assert.equal(job.graphStartContext.projectPath, realpathSync(join(v.root, 'project')));
      assert.equal(job.tasks.length, 1);
      assert.equal(job.tasks[0].state, 'QUEUED');
      assert.equal(job.tasks[0].input, input);
      assert.equal(job.tasks[0].agentGraph, graph);
    } finally { sql.close(); }
  } finally { rmSync(v.root, { recursive: true, force: true }); }
});

test('invalid Coordinator roots and Planner combination fail without mutation', () => {
  const v = fixture();
  try {
    init(v);
    for (const args of [
      ['--coordinator-workspace-root', join(v.root, 'missing')],
      ['--initial-plan'],
    ]) {
      const result = invoke(v, args);
      assert.equal(result.status, 2, result.stderr);
      const sql = new DatabaseSync(v.db);
      try { assert.equal(sql.prepare('SELECT count(*) AS n FROM job_snapshot').get().n, 0); } finally { sql.close(); }
    }
    const before = readFileSync(join(v.root, 'relay.sqlite'));
    const outside = spawnSync(exe, ['job', 'create', '--db', v.db, '--repo', 'sample', '--objective', 'x', '--project-root', tmpdir()], { encoding: 'utf8', env });
    assert.equal(outside.status, 2);
    assert.deepEqual(readFileSync(join(v.root, 'relay.sqlite')), before);
  } finally { rmSync(v.root, { recursive: true, force: true }); }
});
