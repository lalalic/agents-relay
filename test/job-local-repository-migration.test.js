import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { migrateJobLocalRepositories } from '../dist/job-local-repository-migration.js';

test('versioned local repository migration preserves event history and is idempotent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-local-migration-'));
  const projectRoot = join(root, 'neo', 'vlog');
  const dependentRoot = join(root, 'other-root');
  await mkdir(projectRoot, { recursive: true });
  await mkdir(dependentRoot, { recursive: true });
  execFileSync('git', ['init', '-q', projectRoot]);
  execFileSync('git', ['init', '-q', dependentRoot]);
  execFileSync('git', ['-C', projectRoot, 'config', 'user.email', 'test@example.invalid']);
  execFileSync('git', ['-C', projectRoot, 'config', 'user.name', 'Relay Test']);
  const database = join(root, 'relay.sqlite');
  const mapping = join(root, 'mapping.json');
  const db = new DatabaseSync(database);
  db.exec("CREATE TABLE source_registry(job_id TEXT PRIMARY KEY,source_file TEXT,repository TEXT,pr_number INTEGER); CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT,updated_at TEXT); CREATE TABLE event_receipt(job_id TEXT,event_id TEXT,body TEXT); CREATE TABLE migration_metadata(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE projection_outbox(scope_job_id TEXT,id INTEGER,operation TEXT,payload_json TEXT,conflict_definition_json TEXT,conflict_evidence_json TEXT,conflict_resolution_json TEXT);");
  const job = { id: '91', title: 'historical', repository: 'local/neo-vlog', prNumber: 0, tasks: [{ id: 't1', input: 'preserve' }], unblocks: [{ repository: 'old/dependent', jobId: '92' }] };
  db.prepare('INSERT INTO source_registry VALUES(?,?,?,?)').run('91', 'unified:91', job.repository, 0);
  db.prepare('INSERT INTO job_snapshot VALUES(?,?,?)').run('91', JSON.stringify(job), '2026-01-01');
  db.prepare('INSERT INTO event_receipt VALUES(?,?,?)').run('91', 'evt-1', 'unchanged');
  db.prepare('INSERT INTO projection_outbox VALUES(?,?,?,?,?,?,?)').run('91', 1, 'append_task', JSON.stringify({repository:'local/neo-vlog',state:'pending'}), null, null, null);
  db.prepare('INSERT INTO source_registry VALUES(?,?,?,?)').run('92', 'unified:92', 'old/dependent', 0);
  db.prepare('INSERT INTO job_snapshot VALUES(?,?,?)').run('92', JSON.stringify({ id: '92', title: 'dependent', repository: 'old/dependent', prNumber: 0, tasks: [] }), '2026-01-02');
  db.close();
  await writeFile(mapping, JSON.stringify({ version: 1, jobs: [{ jobId: '91', projectRoot }, { jobId: '92', projectRoot: dependentRoot }] }));
  try {
    const first = await migrateJobLocalRepositories(database, mapping);
    const second = await migrateJobLocalRepositories(database, mapping);
    assert.equal(first.migrated, 2);
    assert.equal(second.migrated, 2);
    const backup = new DatabaseSync(first.backupPath, { readOnly: true });
    try { assert.equal(JSON.parse(backup.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get('91').json).repository, 'local/neo-vlog'); }
    finally { backup.close(); }
    const migrated = new DatabaseSync(database, { readOnly: true });
    try {
      const updated = JSON.parse(migrated.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get('91').json);
      assert.equal(updated.id, '91');
      assert.equal(updated.repository, 'vlog');
      assert.equal(updated.projectRoot, await realpath(projectRoot));
      assert.equal(updated.tasks[0].input, 'preserve');
      assert.equal(updated.unblocks[0].repository, 'other-root');
      assert.equal(migrated.prepare('SELECT body FROM event_receipt WHERE event_id=?').get('evt-1').body, 'unchanged');
      assert.equal(migrated.prepare('SELECT repository FROM source_registry WHERE job_id=?').get('91').repository, 'vlog');
      const pending = JSON.parse(migrated.prepare('SELECT payload_json FROM projection_outbox WHERE scope_job_id=? AND id=1').get('91').payload_json);
      assert.deepEqual(pending, { repository: 'vlog', state: 'pending' });
    } finally { migrated.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('migration rejects absent job mappings before touching SQLite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-local-migration-negative-'));
  const database = join(root, 'relay.sqlite');
  const mapping = join(root, 'mapping.json');
  const db = new DatabaseSync(database);
  db.exec('CREATE TABLE source_registry(job_id TEXT PRIMARY KEY,source_file TEXT,repository TEXT,pr_number INTEGER); CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT,updated_at TEXT); CREATE TABLE migration_metadata(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE projection_outbox(scope_job_id TEXT,id INTEGER,operation TEXT,payload_json TEXT,conflict_definition_json TEXT,conflict_evidence_json TEXT,conflict_resolution_json TEXT);');
  db.prepare('INSERT INTO source_registry VALUES(?,?,?,?)').run('7', 'unified:7', 'owner/repo', 0);
  db.prepare('INSERT INTO job_snapshot VALUES(?,?,?)').run('7', JSON.stringify({ id: '7', repository: 'owner/repo' }), 'stable');
  db.close();
  await writeFile(mapping, JSON.stringify({ version: 1, jobs: [] }));
  try {
    await assert.rejects(migrateJobLocalRepositories(database, mapping), /exactly one entry/);
    const unchanged = new DatabaseSync(database, { readOnly: true });
    try { assert.equal(unchanged.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get('7').json, JSON.stringify({ id: '7', repository: 'owner/repo' })); }
    finally { unchanged.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
