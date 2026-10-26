import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteRelayStore } from '../dist/relay-store.js';
import { beginProjectionRecovery } from '../dist/projection-recovery.js';

const at = '2026-10-20T12:00:00.000Z';
const job483Fixture = {
  id: 'job-483', title: 'Job 483 projection divergence regression', repository: 'local/regression', prNumber: 483,
  state: 'COMPLETED', continuation: null, createdAt: at, updatedAt: at,
  tasks: [], localMerge: { sourceRef: 'refs/heads/job-483', targetRef: 'refs/heads/main', status: 'succeeded',
    projectionStrategy: 'target_ref_push', sourceSha: '1111111111111111111111111111111111111111',
    mergedCommitSha: '2222222222222222222222222222222222222222' },
};

test('Job 483 divergence creates one normal same-Job task and survives SQLite restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-projection-recovery-'));
  const path = join(directory, 'relay.sqlite');
  const remoteSha = '3333333333333333333333333333333333333333';
  try {
    let store = new SQLiteRelayStore(path, job483Fixture.id);
    await store.saveJob(structuredClone(job483Fixture));
    const concurrent = await Promise.all([
      beginProjectionRecovery(store, job483Fixture.id, remoteSha, 'non-fast-forward: local main diverged from origin/main'),
      beginProjectionRecovery(store, job483Fixture.id, remoteSha, 'non-fast-forward: local main diverged from origin/main'),
    ]);
    assert.equal(concurrent.filter(value => value === 'created').length, 1);
    assert.equal(concurrent.filter(value => value === false).length, 1);
    store.close();

    store = new SQLiteRelayStore(path, job483Fixture.id);
    const recovered = await store.loadJob(job483Fixture.id);
    assert.equal(recovered?.state, 'COMPLETED');
    assert.equal(recovered?.projectionRecovery?.key, `${job483Fixture.id}:${remoteSha}`);
    assert.equal(recovered?.projectionRecovery?.status, 'repairing');
    assert.equal(recovered?.tasks.length, 1);
    assert.equal(recovered?.tasks[0].kind, 'work');
    assert.equal(recovered?.tasks[0].agentName, 'implementation');
    assert.equal(recovered?.tasks[0].adapter, 'codex');
    assert.equal(recovered?.tasks[0].routing, undefined);
    assert.equal(recovered?.tasks[0].storySize, 'M');
    assert.equal(await beginProjectionRecovery(store, job483Fixture.id, remoteSha, 'duplicate wakeup'), false);
    assert.equal((await store.loadJob(job483Fixture.id))?.tasks.length, 1);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('concurrent distinct divergence observations cannot replace an active recovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-projection-race-'));
  const path = join(directory, 'relay.sqlite');
  const firstSha = '3333333333333333333333333333333333333333';
  const secondSha = '4444444444444444444444444444444444444444';
  try {
    const store = new SQLiteRelayStore(path, job483Fixture.id);
    await store.saveJob(structuredClone(job483Fixture));
    const outcomes = await Promise.all([
      beginProjectionRecovery(store, job483Fixture.id, firstSha, 'non-fast-forward: first divergence'),
      beginProjectionRecovery(store, job483Fixture.id, secondSha, 'non-fast-forward: second divergence'),
    ]);
    assert.equal(outcomes.filter(value => value === 'created').length, 1);
    assert.equal(outcomes.filter(value => value === false).length, 1);
    const recovered = await store.loadJob(job483Fixture.id);
    assert.equal(recovered?.projectionRecovery?.status, 'repairing');
    assert.equal(recovered?.tasks.length, 1);
    assert.equal(recovered?.tasks[0].id, `projection-recovery-${recovered.projectionRecovery.remoteSha}`);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('new origin SHA replaces a failed retry record with a fresh normal recovery task', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-projection-new-sha-'));
  const path = join(directory, 'relay.sqlite');
  const oldSha = '3333333333333333333333333333333333333333';
  const newSha = '4444444444444444444444444444444444444444';
  try {
    const store = new SQLiteRelayStore(path, job483Fixture.id);
    await store.saveJob(structuredClone(job483Fixture));
    assert.equal(await beginProjectionRecovery(store, job483Fixture.id, oldSha, 'non-fast-forward: prior tip'), 'created');
    const oldRecovery = await store.loadJob(job483Fixture.id);
    assert.ok(oldRecovery?.projectionRecovery);
    oldRecovery.projectionRecovery.status = 'retry';
    oldRecovery.projectionRecovery.attempts = 1;
    oldRecovery.projectionRecovery.error = 'prior retry failed';
    oldRecovery.tasks[0].state = 'FAILED';
    await store.saveJob(oldRecovery);

    assert.equal(await beginProjectionRecovery(store, job483Fixture.id, newSha, 'non-fast-forward: newer origin tip'), 'created');
    const recovered = await store.loadJob(job483Fixture.id);
    assert.equal(recovered?.projectionRecovery?.key, `${job483Fixture.id}:${newSha}`);
    assert.equal(recovered?.projectionRecovery?.remoteSha, newSha);
    assert.equal(recovered?.projectionRecovery?.status, 'repairing');
    assert.equal(recovered?.tasks.length, 2);
    assert.ok(recovered?.tasks.some(task => task.id === `projection-recovery-${oldSha}`));
    assert.ok(recovered?.tasks.some(task => task.id === `projection-recovery-${newSha}`));
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
