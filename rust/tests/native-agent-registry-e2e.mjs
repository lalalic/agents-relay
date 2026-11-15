import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const target = process.env.CARGO_TARGET_DIR ?? resolve(import.meta.dirname, '../target');
const cli = join(target, 'debug/relay-native-job');
function fixture(scoped = true) {
  const root = mkdtempSync(join(tmpdir(), 'relay-rust-authority-'));
  writeFileSync(join(root, '.relay-rust-authority-isolated-test'), 'isolated-test');
  const db = join(root, 'relay.sqlite');
  const env = { ...process.env, RELAY_RUST_EXPERIMENTAL_TEST_ONLY: 'isolated-test' };
  const init = spawnSync(cli, ['init', '--db', db], { encoding: 'utf8', env });
  assert.equal(init.status, 0, init.stderr || init.stdout);
  const sql = new DatabaseSync(db);
  if (scoped) sql.exec(`
      DROP TABLE agent_snapshot;
      DROP TABLE relay_meta;
      CREATE TABLE source_registry(job_id TEXT PRIMARY KEY, source_file TEXT NOT NULL UNIQUE, repository TEXT NOT NULL, pr_number INTEGER NOT NULL);
      CREATE TABLE relay_meta(scope_job_id TEXT NOT NULL REFERENCES source_registry(job_id), key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(scope_job_id,key));
      CREATE TABLE agent_snapshot(scope_job_id TEXT NOT NULL REFERENCES source_registry(job_id), agent_id TEXT NOT NULL, json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(scope_job_id,agent_id));
    `);
  for (const [id, repo] of [['job-a', 'calc'], ['job-b', 'other']]) {
    const job = { id, repository: repo, state: 'ACTIVE', tasks: [], updatedAt: '2026-01-01T00:00:00.000Z' };
    sql.prepare('INSERT INTO job_snapshot(job_id,json,updated_at) VALUES(?,?,?)').run(id, JSON.stringify(job), job.updatedAt);
    if (scoped) sql.prepare('INSERT INTO source_registry(job_id,source_file,repository,pr_number) VALUES(?,?,?,0)').run(id, `unified:${id}`, repo);
  }
  sql.close();
  return { root, db, env };
}
function invoke(f, args, expected = 0, env = f.env) {
  const result = spawnSync(cli, args, { encoding: 'utf8', env, timeout: 25000 });
  assert.equal(result.status, expected, result.stderr || result.stdout);
  return expected === 0 ? JSON.parse(result.stdout) : result.stderr;
}
const binding = (db, id = 'job-a', repo = 'calc') => ['--db', db, '--id', id, '--repo', repo];
const registration = (db, extra = []) => ['agent-register', ...binding(db), '--agent-id', 'agent-1', '--name', 'builder', '--responsibility', 'Build code', '--role', 'engineer', '--endpoint', 'shell', '--capabilities', 'shell,code', '--boundaries', 'secrets|production writes', '--trust-domains', 'internal', '--labels', 'team=core', '--regions', 'ca-east', ...extra];

test('native init exposes Node legacy agent_snapshot schema as its single registry', () => {
  const f = fixture(false);
  try {
    invoke(f, registration(f.db));
    assert.equal(invoke(f, ['agent-discover', ...binding(f.db)])[0].agent.id, 'agent-1');
    const sql = new DatabaseSync(f.db);
    assert.equal(sql.prepare('SELECT count(*) AS n FROM agent_snapshot').get().n, 1);
    assert.equal(sql.prepare("SELECT count(*) AS n FROM relay_meta WHERE key='agent_registry_observed_at'").get().n, 1);
    sql.close();
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('native agent registry persists, discovers, scopes, validates and survives process restart', () => {
  const f = fixture();
  try {
    const first = invoke(f, registration(f.db));
    assert.equal(first.id, 'agent-1');
    assert.equal(first.runtime.adapter, 'shell');
    assert.deepEqual(first.boundaries, ['secrets', 'production writes']);
    const second = invoke(f, registration(f.db, ['--adapter', 'ignored', '--runtime', 'shell']));
    assert.equal(second.id, first.id, 'same ID upserts the single canonical row');
    const sql = new DatabaseSync(f.db);
    assert.equal(sql.prepare('SELECT count(*) AS n FROM agent_snapshot WHERE scope_job_id=? AND agent_id=?').get('job-a', 'agent-1').n, 1);
    sql.close();

    const found = invoke(f, ['agent-discover', ...binding(f.db), '--capabilities', 'shell,code', '--runtime', 'shell', '--availability', 'available', '--trust-domain', 'internal', '--task-kind', 'implementation', '--explore']);
    assert.equal(found.length, 1);
    assert.equal(found[0].agent.id, 'agent-1');
    assert.equal(found[0].exploratory, true);
    assert.equal(invoke(f, ['agent-discover', ...binding(f.db, 'job-b', 'other')]).length, 0, 'another Job scope cannot see the registration');

    const mismatch = invoke(f, ['agent-discover', ...binding(f.db, 'job-a', 'wrong-repo')], 2);
    assert.match(mismatch, /trust boundary mismatch/);
    const badAvailability = invoke(f, ['agent-discover', ...binding(f.db), '--availability', 'busy'], 2);
    assert.match(badAvailability, /AgentAvailability has no busy state/);
    const badEndpoint = invoke(f, registration(f.db, ['--endpoint-kind', 'shell']), 2);
    assert.match(badEndpoint, /--endpoint-kind must be/);
    const unsupported = invoke(f, ['agent-register', ...binding(f.db), '--file', 'agents.json'], 2);
    assert.match(unsupported, /--file is unsupported.*not a SQLite authority/);
    const noAuth = invoke(f, ['agent-discover', ...binding(f.db)], 2, { ...f.env, RELAY_RUST_EXPERIMENTAL_TEST_ONLY: '' });
    assert.match(noAuth, /isolated-test required/);
    assert.equal(invoke(f, ['agent-discover', ...binding(f.db)]).length, 1, 'a fresh process reads the persisted registration');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
