import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, readdirSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {SQLiteRelayStore} from '../../dist/relay-store.js';

const exe = resolve(import.meta.dirname, '../target/debug/agents-relay-rust');
const timestamp = '2026-11-13T16:00:00.000Z';
const task = (jobId, id) => ({
  jobId, id, parentTaskId: null, dependencies: [], capabilities: [], adapter: 'orchestrator',
  input: `inspect ${id}`, state: 'QUEUED', attempt: 0, maxAttempts: 2, leaseOwner: null,
  leaseExpiresAt: null, executionId: null, threadId: null, result: null, error: null,
  timeoutMs: 1000, createdAt: timestamp, updatedAt: timestamp, continuation: null,
  continuationDeliveredAt: null,
});
const job = id => ({
  id, title: `Inspection ${id}`, repository: 'local-repo', projectRoot: process.cwd(),
  prNumber: 0, state: 'ACTIVE', reviewEnabled: false, continuation: null,
  createdAt: timestamp, updatedAt: timestamp, tasks: [task(id, '41'), task(id, '42')],
});

function invoke(storeDir, ...args) {
  return spawnSync(exe, args, {
    encoding: 'utf8',
    env: {...process.env, AGENTS_RELAY_STORE_DIR: storeDir},
    maxBuffer: 4 * 1024 * 1024,
  });
}

function snapshotDatabaseFiles(root) {
  return readdirSync(root)
    .filter(name => name.startsWith('relay.sqlite'))
    .sort()
    .map(name => [name, createHash('sha256').update(readFileSync(join(root, name))).digest('hex')]);
}

test('Rust Job and Task inspection matches Relay records, rejects errors, and never changes the isolated DB', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agents-relay-rust-inspection-'));
  const db = join(root, 'relay.sqlite');
  const previousStoreDir = process.env.AGENTS_RELAY_STORE_DIR;
  process.env.AGENTS_RELAY_STORE_DIR = root;
  let store;
  try {
    store = new SQLiteRelayStore(db);
    await store.saveJob(job('100'));
    store.close();
    store = null;

    // SQLite may create read-only WAL sidecars on first open. Establish those
    // transient files before measuring whether subsequent inspection mutates them.
    const warmup = invoke(root, 'job', 'show', '--db', db, '--job-id', '100');
    assert.equal(warmup.status, 0, warmup.stderr);
    const baseline = snapshotDatabaseFiles(root);
    const showJob = invoke(root, 'job', 'show', '--db', db, '--job-id', '100');
    assert.equal(showJob.status, 0, showJob.stderr);
    const shown = JSON.parse(showJob.stdout);
    assert.equal(shown.id, '100');
    assert.equal(shown.title, 'Inspection 100');

    const listTasks = invoke(root, 'task', 'list', '--db', db, '--job-id', '100');
    assert.equal(listTasks.status, 0, listTasks.stderr);
    assert.deepEqual(JSON.parse(listTasks.stdout), shown.tasks);

    const showTask = invoke(root, 'task', 'show', '--db', db, '--job-id', '100', '--task-id', '42');
    assert.equal(showTask.status, 0, showTask.stderr);
    assert.deepEqual(JSON.parse(showTask.stdout), shown.tasks[1]);

    const missingJob = invoke(root, 'job', 'show', '--db', db, '--job-id', 'missing');
    assert.equal(missingJob.status, 2);
    assert.match(missingJob.stderr, /Job missing not found/);
    const missingTask = invoke(root, 'task', 'show', '--db', db, '--job-id', '100', '--task-id', 'missing');
    assert.equal(missingTask.status, 2);
    assert.match(missingTask.stderr, /Task missing not found in Job 100/);
    const taskListMissingJob = invoke(root, 'task', 'list', '--db', db, '--job-id', 'missing');
    assert.equal(taskListMissingJob.status, 2);
    assert.match(taskListMissingJob.stderr, /Job missing not found/);

    const missingArgument = invoke(root, 'job', 'show', '--db', db);
    assert.equal(missingArgument.status, 2);
    assert.match(missingArgument.stderr, /missing --job-id/);
    const unknownArgument = invoke(root, 'task', 'list', '--db', db, '--job-id', '100', '--limit', '2');
    assert.equal(unknownArgument.status, 2);
    assert.match(unknownArgument.stderr, /unrecognized argument.*--limit/);
    const missingValue = invoke(root, 'task', 'show', '--db', db, '--job-id', '100', '--task-id');
    assert.equal(missingValue.status, 2);
    assert.match(missingValue.stderr, /missing value for --task-id/);
    const duplicateArgument = invoke(root, 'job', 'show', '--db', db, '--db', db, '--job-id', '100');
    assert.equal(duplicateArgument.status, 2);
    assert.match(duplicateArgument.stderr, /duplicate argument: --db/);

    assert.deepEqual(snapshotDatabaseFiles(root), baseline, 'inspection commands must not mutate SQLite or sidecar files');
  } finally {
    store?.close();
    if (previousStoreDir === undefined) delete process.env.AGENTS_RELAY_STORE_DIR;
    else process.env.AGENTS_RELAY_STORE_DIR = previousStoreDir;
    rmSync(root, {recursive: true, force: true});
  }
});
