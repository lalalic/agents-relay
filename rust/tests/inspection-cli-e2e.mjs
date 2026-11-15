import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import http from 'node:http';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
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
const jobAt = (id, repository, updatedAt) => ({
  ...job(id), repository, updatedAt,
  tasks: job(id).tasks.map(item => ({...item, title: `inspect ${item.id}`})),
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
    .filter(name => name.includes('.sqlite'))
    .sort()
    .map(name => [name, createHash('sha256').update(readFileSync(join(root, name))).digest('hex')]);
}

test('Rust Job listing is repository-filtered, stable, read-only, and isolated', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agents-relay-rust-job-list-'));
  const db = join(root, 'relay.sqlite');
  const previousStoreDir = process.env.AGENTS_RELAY_STORE_DIR;
  process.env.AGENTS_RELAY_STORE_DIR = root;
  let store;
  try {
    const emptyDb = join(root, 'empty.sqlite');
    store = new SQLiteRelayStore(emptyDb);
    store.close();
    store = null;
    const empty = invoke(root, 'job', 'list', '--db', emptyDb);
    assert.equal(empty.status, 0, empty.stderr);
    assert.deepEqual(JSON.parse(empty.stdout), []);

    store = new SQLiteRelayStore(db);
    await store.saveJob(jobAt('100', 'repo-b', '2026-11-13T16:00:02.000Z'));
    await store.saveJob(jobAt('102', 'repo-a', '2026-11-13T11:00:03.000-05:00'));
    await store.saveJob(jobAt('101', 'repo-a', '2026-11-13T16:00:03.000Z'));
    await store.saveJob({...jobAt('103', 'repo-a', '2026-11-13T16:00:01.000Z'), state: 'CANCELLED'});
    store.close();
    store = null;
    const warmup = invoke(root, 'job', 'list', '--db', db);
    assert.equal(warmup.status, 0, warmup.stderr);
    const baseline = snapshotDatabaseFiles(root);

    const listed = invoke(root, 'job', 'list', '--db', db);
    assert.equal(listed.status, 0, listed.stderr);
    const rows = JSON.parse(listed.stdout);
    assert.deepEqual(rows.map(row => row.id), ['101', '102', '100', '103']);
    assert.equal(rows.at(-1).state, 'CANCELLED', 'full inventory includes terminal cancelled Jobs');
    const filtered = invoke(root, 'job', 'list', '--db', db, '--repo', 'repo-a');
    assert.equal(filtered.status, 0, filtered.stderr);
    assert.deepEqual(JSON.parse(filtered.stdout).map(row => row.id), ['101', '102', '103']);

    // A fresh process after closing and reopening the SQLite store returns the same stable inventory.
    store = new SQLiteRelayStore(db);
    store.close();
    store = null;
    const reopened = invoke(root, 'job', 'list', '--db', db);
    assert.equal(reopened.status, 0, reopened.stderr);
    assert.deepEqual(JSON.parse(reopened.stdout), rows);

    for (const [args, pattern] of [
      [['job', 'list'], /missing --db/],
      [['job', 'list', '--db', db, '--repo'], /missing value for --repo/],
      [['job', 'list', '--db', db, '--repo', 'repo-a', '--repo', 'repo-b'], /duplicate argument: --repo/],
      [['job', 'list', '--db', db, '--unknown', 'value'], /unrecognized argument/],
    ]) {
      const rejected = invoke(root, ...args);
      assert.equal(rejected.status, 2);
      assert.match(rejected.stderr, pattern);
    }
    const absent = join(root, 'absent.sqlite');
    const missingDb = invoke(root, 'job', 'list', '--db', absent);
    assert.equal(missingDb.status, 2);
    assert.match(missingDb.stderr, /does not exist/);
    assert.equal(readdirSync(root).includes('absent.sqlite'), false, 'missing database must not be created');
    const unreadableDb = join(root, 'unreadable.sqlite');
    writeFileSync(unreadableDb, 'not sqlite');
    const unreadableBefore = createHash('sha256').update(readFileSync(unreadableDb)).digest('hex');
    const invalidDb = invoke(root, 'job', 'list', '--db', unreadableDb);
    assert.equal(invalidDb.status, 2);
    assert.match(invalidDb.stderr, /SQLite|database/i);
    assert.deepEqual(snapshotDatabaseFiles(root).filter(([name]) => name !== 'unreadable.sqlite'), baseline, 'accepted and rejected reads must not mutate valid database or sidecar files');
    assert.equal(createHash('sha256').update(readFileSync(unreadableDb)).digest('hex'), unreadableBefore, 'rejected malformed database read must preserve its bytes');
  } finally {
    store?.close();
    if (previousStoreDir === undefined) delete process.env.AGENTS_RELAY_STORE_DIR;
    else process.env.AGENTS_RELAY_STORE_DIR = previousStoreDir;
    rmSync(root, {recursive: true, force: true});
  }
});

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

test('Rust Task event history pages native SQLite inbox/outbox read-only across restarts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agents-relay-rust-task-events-'));
  const db = join(root, 'relay.sqlite');
  const previousStoreDir = process.env.AGENTS_RELAY_STORE_DIR;
  process.env.AGENTS_RELAY_STORE_DIR = root;
  let store;
  try {
    store = new SQLiteRelayStore(db);
    await store.saveJob(job('200'));
    store.close();
    store = null;
    const writer = new DatabaseSync(db);
    writer.exec(`CREATE TABLE workflow_event_inbox (
      consumer_id TEXT NOT NULL,event_key TEXT NOT NULL,event_id TEXT NOT NULL,payload_json TEXT NOT NULL,consumed_at TEXT NOT NULL,
      PRIMARY KEY(consumer_id,event_key));
      CREATE TABLE workflow_event_outbox (
      event_key TEXT PRIMARY KEY,event_id TEXT NOT NULL,payload_json TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',created_at TEXT NOT NULL,published_at TEXT);`);
    const event = (id, taskId, at, type = 'task.started', status = 'running') => JSON.stringify({
      version: 1, event_id: id, jobId: '200', taskId, type,
      status, timestamp: at, visibility: 'orchestrator', level: 'info', message: id,
    });
    writer.prepare('INSERT INTO workflow_event_inbox VALUES(?,?,?,?,?)').run('worker', 'k1', 'task.started', event('event-1', '41', '2026-11-13T16:00:01.000Z'), '2026-11-13T16:00:01.000Z');
    writer.prepare('INSERT INTO workflow_event_inbox VALUES(?,?,?,?,?)').run('worker', 'k2', 'task.started', event('event-2', '41', '2026-11-13T16:00:02.000Z'), '2026-11-13T16:00:02.000Z');
    writer.prepare('INSERT INTO workflow_event_outbox VALUES(?,?,?,?,?,?)').run('k3', 'task.completed', event('event-3', '41', '2026-11-13T16:00:03.000Z', 'task.completed', 'succeeded'), 'published', '2026-11-13T16:00:03.000Z', '2026-11-13T16:00:04.000Z');
    writer.prepare('INSERT INTO workflow_event_inbox VALUES(?,?,?,?,?)').run('worker', 'k4', 'event-other-task', event('event-other-task', '42', '2026-11-13T16:00:04.000Z'), '2026-11-13T16:00:04.000Z');
    writer.close();
    store = new SQLiteRelayStore(db);
    await store.saveJob(job('201'));
    store.close();
    store = null;

    const run = (...args) => invoke(root, 'task', 'events', '--db', db, '--job-id', '200', '--task-id', '41', ...args);
    const warmup = run('--limit', '2', '--order', 'asc', '--after', '0');
    assert.equal(warmup.status, 0, warmup.stderr);
    const baseline = snapshotDatabaseFiles(root);
    const first = run('--limit', '2', '--order', 'asc', '--after', '0');
    assert.equal(first.status, 0, first.stderr);
    const firstPage = JSON.parse(first.stdout);
    assert.deepEqual(firstPage.events.map(row => row.event_id), ['event-1', 'event-2']);
    assert.equal(firstPage.order, 'oldest-first');
    assert.equal(firstPage.nextCursor, 2);
    assert.equal(firstPage.morePossible, true);

    // A new CLI process after reopen continues from the durable event evidence.
    const second = run('--limit', '2', '--order', 'asc', '--after', String(firstPage.nextCursor));
    assert.equal(second.status, 0, second.stderr);
    const secondPage = JSON.parse(second.stdout);
    assert.deepEqual(secondPage.events.map(row => row.event_id), ['event-3']);
    assert.equal(secondPage.morePossible, false);
    const descending = run('--limit', '2', '--order', 'desc');
    assert.equal(descending.status, 0, descending.stderr);
    assert.deepEqual(JSON.parse(descending.stdout).events.map(row => row.event_id), ['event-3', 'event-2']);

    // Compare output and argument handling with the matching Node CLI using a
    // local Job file and a mock Events Bus page, never a Relay HTTP endpoint.
    const localJobPath = join(root, 'job.json');
    writeFileSync(localJobPath, JSON.stringify(job('200')));
    const rows = [
      JSON.parse(event('event-1', '41', '2026-11-13T16:00:01.000Z')),
      JSON.parse(event('event-2', '41', '2026-11-13T16:00:02.000Z')),
      JSON.parse(event('event-3', '41', '2026-11-13T16:00:03.000Z', 'task.completed', 'succeeded')),
    ].map((record, index) => ({cursor: index + 1, event: {...record, job_id: record.jobId, task_id: record.taskId, jobId: undefined, taskId: undefined, parent_task_id: null}}));
    const server = http.createServer((request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      const order = url.searchParams.get('order');
      const after = Number(url.searchParams.get('after') || 0);
      const limit = Number(url.searchParams.get('limit'));
      const all = order === 'asc' ? rows.filter(row => row.cursor > after) : [...rows].reverse();
      const selected = all.slice(0, limit);
      response.writeHead(200, {'content-type': 'application/json'});
      response.end(JSON.stringify({job_id: '200', order, events: selected, next_cursor: selected.length ? (order === 'asc' ? selected.at(-1).cursor : selected[0].cursor) : after}));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    try {
      const nodeRun = (...args) => new Promise((resolveRun, reject) => {
        const child = spawn(process.execPath, [resolve(import.meta.dirname, '../../dist/cli.js'), 'task', 'events', '--file', localJobPath, '--id', '200', '--task-id', '41', ...args], {
          env: {...process.env, EVENTS_BUS_API_URL: `http://127.0.0.1:${address.port}`},
        });
        let stdout = '', stderr = '';
        child.stdout.setEncoding('utf8').on('data', chunk => stdout += chunk);
        child.stderr.setEncoding('utf8').on('data', chunk => stderr += chunk);
        child.once('error', reject);
        child.once('close', (status, signal) => resolveRun({status, signal, stdout, stderr}));
      });
      const nodeFirst = await nodeRun('--limit', '2', '--order', 'asc', '--after', '0');
      assert.equal(nodeFirst.status, 0, nodeFirst.stderr);
      assert.deepEqual(JSON.parse(nodeFirst.stdout), firstPage);
      const nodeBadLimit = await nodeRun('--limit', '0');
      assert.equal(nodeBadLimit.status, 1);
      assert.match(nodeBadLimit.stderr, /limit must be an integer from 1 to 60/);
      const nodeBadCursor = await nodeRun('--after', '1');
      assert.equal(nodeBadCursor.status, 1);
      assert.match(nodeBadCursor.stderr, /requires --order asc/);
    } finally {
      await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    }

    const emptyTask = invoke(root, 'task', 'events', '--db', db, '--job-id', '200', '--task-id', '42', '--order', 'asc', '--after', '0');
    assert.equal(emptyTask.status, 0, emptyTask.stderr);
    assert.deepEqual(JSON.parse(emptyTask.stdout).events.map(row => row.event_id), ['event-other-task']);
    const noEvents = invoke(root, 'task', 'events', '--db', db, '--job-id', '201', '--task-id', '41', '--order', 'asc', '--after', '0');
    assert.equal(noEvents.status, 0, noEvents.stderr);
    assert.deepEqual(JSON.parse(noEvents.stdout).events, []);

    for (const [args, pattern] of [
      [['--limit', '0'], /limit must be an integer from 1 to 60/],
      [['--limit', 'x'], /limit must be an integer from 1 to 60/],
      [['--order', 'sideways'], /order must be asc or desc/],
      [['--order', 'asc', '--after', '-1'], /non-negative integer cursor/],
      [['--order', 'asc', '--after', 'invalid'], /non-negative integer cursor/],
      [['--order', 'asc', '--after', '9007199254740992'], /safe integer cursor/],
      [['--after', '1'], /requires --order asc/],
      [['--limit', '1', '--limit', '2'], /duplicate argument: --limit/],
    ]) {
      const rejected = run(...args);
      assert.equal(rejected.status, 2, rejected.stderr);
      assert.match(rejected.stderr, pattern);
    }
    const missingJob = invoke(root, 'task', 'events', '--db', db, '--job-id', 'missing', '--task-id', '41');
    assert.equal(missingJob.status, 2);
    assert.match(missingJob.stderr, /Job missing not found/);
    const missingTask = invoke(root, 'task', 'events', '--db', db, '--job-id', '200', '--task-id', 'missing');
    assert.equal(missingTask.status, 2);
    assert.match(missingTask.stderr, /Task missing not found in Job 200/);
    assert.deepEqual(snapshotDatabaseFiles(root), baseline, 'successful and rejected reads must preserve SQLite and sidecars byte-for-byte');
  } finally {
    store?.close();
    if (previousStoreDir === undefined) delete process.env.AGENTS_RELAY_STORE_DIR;
    else process.env.AGENTS_RELAY_STORE_DIR = previousStoreDir;
    rmSync(root, {recursive: true, force: true});
  }
});
