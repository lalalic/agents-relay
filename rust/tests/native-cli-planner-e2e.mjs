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

test('Planner commands fail explicitly without native Planner authority; stale identity is never accepted', () => {
  const f = fixture();
  try {
    const stale = call(['plan', 'context', '--db', f.db, '--id', f.created.jobId, '--plan-id', 'plan-1', '--execution-id', 'stale-execution'], 2);
    assert.match(stale.stderr, /not ported.*execution-context/);
    const apply = call(['plan', 'apply', '--db', f.db, '--id', f.created.jobId, '--plan-id', 'plan-1', '--execution-id', 'stale-execution', '--file', '-'], 2);
    assert.match(apply.stderr, /not ported.*lease/);
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
