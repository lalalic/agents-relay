import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('ordinary job create rejects legacy PR binding flags before contacting Relay', () => {
  for (const flag of ['--pr', '--head', '--base', '--body', '--local-merge-source', '--local-merge-target']) {
    const result = spawnSync(process.execPath, ['dist/cli.js', 'job', 'create', '--repo', 'owner/repo', '--objective', 'standalone', flag, flag === '--pr' ? '4' : 'main'], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, flag);
    assert.match(result.stderr, /job create does not accept /);
  }
});

test('objective creation accepts explicit request identity without conflating equal objectives', async () => {
  const { ensureManagedGitHubJob } = await import('../dist/cli-job-create.js');
  const directory = await mkdtemp(join(process.env.AGENTS_RELAY_STORE_DIR ?? '/tmp', 'job-11-identity-'));
  try {
    const client = { request: async () => { throw new Error('offline'); }, graphql: async () => { throw new Error('offline'); } };
    const first = await ensureManagedGitHubJob(client, 'owner/repo', new Set(), { objective: 'same', idempotencyKey: 'request-1', storeDirectory: directory });
    const retry = await ensureManagedGitHubJob(client, 'owner/repo', new Set(), { objective: 'same', idempotencyKey: 'request-1', storeDirectory: directory });
    const second = await ensureManagedGitHubJob(client, 'owner/repo', new Set(), { objective: 'same', idempotencyKey: 'request-2', storeDirectory: directory });
    assert.equal(retry.job.id, first.job.id);
    assert.notEqual(second.job.id, first.job.id);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('job adopt is the explicit legacy PR binding path and remains offline', async () => {
  const { adoptLegacyJob } = await import('../dist/cli-job-create.js');
  const directory = await mkdtemp(join(process.env.AGENTS_RELAY_STORE_DIR ?? '/tmp', 'job-11-adopt-'));
  try {
    let calls = 0;
    const client = { request: async () => { calls += 1; throw new Error('offline'); }, graphql: async () => { calls += 1; throw new Error('offline'); } };
    const result = await adoptLegacyJob(client, 'owner/repo', new Set(), { id: 'legacy-4', prNumber: 4, objective: 'adopted', storeDirectory: directory });
    assert.equal(result.job.prNumber, 4);
    assert.equal(result.pr.number, 4);
    assert.equal(calls, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('SQLite create-if-absent is atomic and preserves the first complete snapshot', async () => {
  const { SQLiteRelayStore } = await import('../dist/relay-store.js');
  const { createJobEntity } = await import('../dist/workflow/entity-creation.js');
  const { mkdtemp } = await import('node:fs/promises');
  const directory = await mkdtemp(join(process.env.AGENTS_RELAY_STORE_DIR ?? '/tmp', 'job-11-atomic-'));
  const store = new SQLiteRelayStore(join(directory, 'relay.db'));
  try {
    const now = new Date().toISOString();
    const first = createJobEntity({ id: 'same', title: 'first', objective: 'one', priority: 'P2', executionMode: 'fixed', autoMerge: true, reviewEnabled: true, prNumber: 0, repository: 'owner/repo', continuation: null, createdAt: now, updatedAt: now, tasks: [] });
    const second = { ...first, title: 'second', objective: 'two' };
    assert.equal((await store.createJobIfAbsent(first)).title, 'first');
    assert.equal((await store.createJobIfAbsent(second)).title, 'first');
    assert.equal((await store.loadJob('same')).objective, 'one');
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
