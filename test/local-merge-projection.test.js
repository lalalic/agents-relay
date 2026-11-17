import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, chmodSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deliverLocalMerge } from '../dist/local-git-merge.js';
import { reconcileCompletedLocalDelivery } from '../dist/local-merge-projection.js';
import { SQLiteRelayStore } from '../dist/relay-store.js';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function fixture({ origin = 'seeded' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'relay-local-delivery-'));
  const remote = join(root, 'remote.git'), repo = join(root, 'repo'), db = join(root, 'relay.sqlite');
  execFileSync('git', ['init', '--bare', remote]); execFileSync('git', ['init', repo]);
  git(repo, 'config', 'user.name', 'Relay Tests'); git(repo, 'config', 'user.email', 'relay@example.test');
  git(repo, 'checkout', '-b', 'main'); writeFileSync(join(repo, 'base'), 'base'); git(repo, 'add', 'base'); git(repo, 'commit', '-m', 'base');
  if (origin !== 'missing') {
    git(repo, 'remote', 'add', 'origin', remote);
    if (origin === 'seeded') git(repo, 'push', '-u', 'origin', 'main');
  }
  git(repo, 'checkout', '-b', 'feature'); writeFileSync(join(repo, 'feature'), 'feature'); git(repo, 'add', 'feature'); git(repo, 'commit', '-m', 'feature');
  const sourceSha = git(repo, 'rev-parse', 'HEAD'); git(repo, 'checkout', 'main');
  const merged = deliverLocalMerge(repo, { sourceRef: 'refs/heads/feature', targetRef: 'refs/heads/main', status: 'pending', sourceSha });
  const at = new Date().toISOString();
  const job = { id: '100', title: 'job', repository: 'repo', projectRoot: repo, projectPath: undefined, prNumber: 0, state: 'COMPLETED', continuation: null, createdAt: at, updatedAt: at, tasks: [], localMerge: { sourceRef: 'refs/heads/feature', targetRef: 'refs/heads/main', status: 'succeeded', ...merged }, remoteDelivery: { mergedCommitSha: merged.mergedCommitSha, status: 'pending', attempts: 0, updatedAt: at } };
  let store = new SQLiteRelayStore(db, job.id);
  store.saveJob(job);
  return { root, remote, repo, db, job, get store() { return store; }, reopen() { store.close(); store = new SQLiteRelayStore(db, job.id); }, close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}
const reconcile = async (f, now = Date.now) => reconcileCompletedLocalDelivery(f.store, await f.store.loadJob(f.job.id), f.repo, now);
async function current(f) { return (await f.store.loadJob(f.job.id)); }

test('missing origin is graph-selected skip and leaves completed Job and Tasks unchanged', async () => {
  const f = fixture({ origin: 'missing' });
  try { await reconcile(f); const job = await current(f); assert.equal(job.remoteDelivery.status, 'skipped'); assert.equal(job.state, 'COMPLETED'); assert.deepEqual(job.tasks, []); }
  finally { f.close(); }
});

test('an empty origin is skipped without creating main; a seeded origin receives only fast-forward delivery', async () => {
  for (const [origin, expected] of [['empty', 'skipped'], ['seeded', 'succeeded']]) {
    const f = fixture({ origin });
    try {
      await reconcile(f);
      const job = await current(f);
      assert.equal(job.remoteDelivery.status, expected);
      const remoteMain = git(f.repo, 'ls-remote', 'origin', 'refs/heads/main');
      if (origin === 'empty') assert.equal(remoteMain, '', 'no automatic creation of origin/main');
      else assert.equal(remoteMain.split(/\s+/)[0], job.localMerge.mergedCommitSha);
      assert.equal(job.state, 'COMPLETED');
      assert.deepEqual(job.tasks, []);
    } finally { f.close(); }
  }
});

test('different configured push URL is a bounded independent failure and cannot write unverified main', async () => {
  const f = fixture({origin:'seeded'});
  try {
    const unverified=join(f.root,'unverified.git');
    execFileSync('git',['init','--bare',unverified]);
    git(f.repo,'remote','set-url','--push','origin',unverified);
    await reconcile(f);
    const job=await current(f);
    assert.equal(job.state,'COMPLETED');
    assert.deepEqual(job.tasks,[]);
    assert.equal(job.remoteDelivery.status,'failed');
    assert.match(job.remoteDelivery.error,/push URL differs/);
    assert.equal(git(f.repo,'ls-remote',unverified,'refs/heads/main'),'');
    assert.notEqual(git(f.repo,'ls-remote',f.remote,'refs/heads/main').split(/\s+/)[0], job.localMerge.mergedCommitSha);
  } finally { f.close(); }
});

test('remote ahead containing local main records delivery without a push', async () => {
  const f = fixture();
  try {
    git(f.repo, 'push', 'origin', 'main');
    const ahead = join(f.root, 'ahead'); execFileSync('git', ['clone', f.remote, ahead]);
    git(ahead, 'config', 'user.name', 'Ahead'); git(ahead, 'config', 'user.email', 'ahead@example.test');
    writeFileSync(join(ahead, 'ahead'), 'ahead'); git(ahead, 'add', '.'); git(ahead, 'commit', '-m', 'remote ahead'); git(ahead, 'push', 'origin', 'main');
    const remoteBefore = git(ahead, 'rev-parse', 'HEAD'); await reconcile(f); const job = await current(f);
    assert.equal(job.remoteDelivery.status, 'succeeded'); assert.equal(git(ahead, 'rev-parse', 'main'), remoteBefore); assert.equal(job.state, 'COMPLETED');
  } finally { f.close(); }
});

test('divergence and unavailable configured origin persist a bounded separate retry', async () => {
  const f = fixture();
  try {
    const other = join(f.root, 'other'); execFileSync('git', ['clone', f.remote, other]);
    git(other, 'config', 'user.name', 'Other'); git(other, 'config', 'user.email', 'other@example.test');
    writeFileSync(join(other, 'remote-only'), 'remote'); git(other, 'add', '.'); git(other, 'commit', '-m', 'remote drift'); git(other, 'push', 'origin', 'main');
    await reconcile(f); let job = await current(f);
    assert.equal(job.remoteDelivery.status, 'failed'); assert.equal(job.remoteDelivery.attempts, 1); assert.ok(job.remoteDelivery.nextRetryAt); assert.equal(job.state, 'COMPLETED'); assert.deepEqual(job.tasks, []);
    git(f.repo, 'remote', 'set-url', 'origin', join(f.root, 'missing.git'));
    await reconcile(f, () => Date.now() + 60_000); job = await current(f);
    assert.equal(job.remoteDelivery.status, 'failed'); assert.equal(job.remoteDelivery.attempts, 2); assert.equal(job.state, 'COMPLETED');
  } finally { f.close(); }
});

test('expired delivery lease recovers after SQLite restart; concurrent daemons push once', async () => {
  const f = fixture();
  try {
    await f.store.mutateJob(f.job.id, job => ({ ...job, remoteDelivery: { ...job.remoteDelivery, status: 'processing', attempts: 1, leaseToken: 'crashed-owner', leaseUntil: new Date(0).toISOString() } }));
    f.reopen(); const first = f.store, second = new SQLiteRelayStore(f.db, f.job.id);
    await Promise.all([reconcileCompletedLocalDelivery(first, f.job, f.repo), reconcileCompletedLocalDelivery(second, f.job, f.repo)]);
    second.close(); f.reopen(); const job = await current(f);
    assert.equal(job.remoteDelivery.status, 'succeeded'); assert.equal(job.state, 'COMPLETED'); assert.deepEqual(job.tasks, []);
    assert.equal(git(f.repo, 'ls-remote', 'origin', 'refs/heads/main').split(/\s+/)[0], job.localMerge.mergedCommitSha);
  } finally { f.close(); }
});


test('retry deadline prevents all Git inspection and keeps SQLite attempts unchanged', async () => {
  const f = fixture();
  try {
    const deadline = Date.now() + 60_000;
    await f.store.mutateJob(f.job.id, job => ({ ...job, remoteDelivery: {
      ...job.remoteDelivery, status: 'failed', attempts: 2, error: 'previous network failure', nextRetryAt: new Date(deadline).toISOString(),
    } }));
    // A missing working directory would make *any* premature git invocation fail.
    const inaccessible = f.repo + '-temporarily-unavailable';
    const { renameSync } = await import('node:fs');
    renameSync(f.repo, inaccessible);
    try {
      await reconcile(f, () => deadline - 1000);
      const job = await current(f);
      assert.equal(job.remoteDelivery.status, 'failed');
      assert.equal(job.remoteDelivery.attempts, 2);
      assert.equal(job.remoteDelivery.error, 'previous network failure');
      assert.equal(job.state, 'COMPLETED');
    } finally { renameSync(inaccessible, f.repo); }
    await reconcile(f, () => deadline + 1000);
    assert.equal((await current(f)).remoteDelivery.status, 'succeeded');
  } finally { f.close(); }
});

test('a moved local main must not publish an old merged SHA', async () => {
  const f = fixture();
  try {
    git(f.repo, 'reset', '--hard', git(f.repo, 'rev-list', '--max-parents=0', 'main'));
    await reconcile(f);
    const job = await current(f);
    assert.equal(job.remoteDelivery.status, 'failed');
    assert.match(job.remoteDelivery.error, /no longer contains completed Job merged commit/);
    assert.equal(job.state, 'COMPLETED');
    assert.notEqual(git(f.repo, 'ls-remote', 'origin', 'refs/heads/main').split(/\s+/)[0], job.localMerge.mergedCommitSha);
  } finally { f.close(); }
});


test('remote push pins the previously verified main commit despite a concurrent local branch move', async () => {
  const f = fixture();
  try {
    const previous = git(f.repo, 'rev-list', '--max-parents=0', 'main');
    const hook = join(f.repo, '.git', 'hooks', 'pre-push');
    writeFileSync(hook, `#!/bin/sh\ngit update-ref refs/heads/main ${previous}\n`);
    chmodSync(hook, 0o755);
    await reconcile(f);
    const job = await current(f);
    assert.equal(job.remoteDelivery.status, 'succeeded');
    assert.equal(git(f.repo, 'rev-parse', 'main'), previous, 'simulated concurrent actor moved local main');
    assert.equal(git(f.repo, 'ls-remote', 'origin', 'refs/heads/main').split(/\s+/)[0], job.localMerge.mergedCommitSha,
      'only the pre-inspected main SHA, including completed Job commit, may be pushed');
    assert.equal(job.state, 'COMPLETED');
  } finally { f.close(); }
});

test('inaccessible immutable projectRoot is a durable retry, not an uncaught daemon scan error', async () => {
  const f = fixture();
  try {
    const moved = f.repo + '-moved';
    renameSync(f.repo, moved);
    try {
      await reconcile(f);
      const job = await current(f);
      assert.equal(job.remoteDelivery.status, 'failed');
      assert.equal(job.remoteDelivery.attempts, 1);
      assert.ok(job.remoteDelivery.nextRetryAt);
      assert.equal(job.state, 'COMPLETED');
    } finally { renameSync(moved, f.repo); }
  } finally { f.close(); }
});

test('offline origin exhausts retry budget after fifth claim, without a sixth attempt or Job mutation', async () => {
  const f = fixture();
  try {
    git(f.repo, 'remote', 'set-url', 'origin', join(f.root, 'nonexistent.git'));
    await f.store.mutateJob(f.job.id, job => ({ ...job, remoteDelivery: { ...job.remoteDelivery,
      status: 'failed', attempts: 4, nextRetryAt: new Date(0).toISOString(), error: 'prior offline retries',
    } }));
    await reconcile(f);
    let job = await current(f);
    assert.equal(job.remoteDelivery.status, 'exhausted');
    assert.equal(job.remoteDelivery.attempts, 5);
    assert.equal(job.remoteDelivery.nextRetryAt, undefined);
    assert.equal(job.state, 'COMPLETED');
    await reconcile(f, () => Date.now() + 300000);
    job = await current(f);
    assert.equal(job.remoteDelivery.status, 'exhausted');
    assert.equal(job.remoteDelivery.attempts, 5);
    assert.deepEqual(job.tasks, []);
  } finally { f.close(); }
});
