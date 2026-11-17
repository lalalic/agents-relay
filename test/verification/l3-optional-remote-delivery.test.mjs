import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteRelayStore } from '../../dist/relay-store.js';
import { relayUnifiedStorePath } from '../../dist/relay-store-discovery.js';
import { deliverLocalMerge } from '../../dist/local-git-merge.js';

// Unlike mocked projection tests, this runs a production-built daemon and
// ordinary git against independently initialized local and bare repositories.
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const now = () => new Date().toISOString();
function fixture(root, name, mode, id) {
  const repo = join(root, name), remote = join(root, `${name}.git`);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, 'config', 'user.name', 'Isolated Relay');
  git(repo, 'config', 'user.email', 'relay@example.invalid');
  writeFileSync(join(repo, 'baseline.txt'), 'base\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'baseline');
  const base = git(repo, 'rev-parse', 'main');
  if (mode !== 'noorigin') {
    if (mode !== 'offline') {
      execFileSync('git', ['init', '--bare', '-q', remote]);
      git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');
      git(repo, 'remote', 'add', 'origin', remote);
      if (mode !== 'emptyorigin') git(repo, 'push', '-q', 'origin', 'main');
      if (mode === 'pushredirect') {
        const alternate=join(root, name+'-unverified.git');
        execFileSync('git',['init','--bare','-q',alternate]);
        git(repo,'remote','set-url','--push','origin',alternate);
      }
    } else git(repo, 'remote', 'add', 'origin', join(root, 'nonexistent.git'));
  }
  git(repo, 'checkout', '-qb', 'feature');
  writeFileSync(join(repo, 'feature.txt'), `feature ${name}\n`);
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', `feature ${name}`);
  const sourceSha = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', 'main');
  const receipt = deliverLocalMerge(repo, {
    sourceRef: 'refs/heads/feature', targetRef: 'refs/heads/main', sourceSha, status: 'pending',
  });
  const mergedCommitSha = receipt.mergedCommitSha;
  if (mode === 'diverged') {
    const other = join(root, `${name}-other`);
    execFileSync('git', ['clone', '-q', remote, other]);
    git(other, 'config', 'user.name', 'Remote Peer');
    git(other, 'config', 'user.email', 'remote@example.invalid');
    writeFileSync(join(other, 'divergent.txt'), 'remote-only\n');
    git(other, 'add', '.'); git(other, 'commit', '-qm', 'remote-only');
    git(other, 'push', '-q', 'origin', 'main');
  }
  const timestamp = now();
  return {
    id, root: repo, remote, base, mergedCommitSha,
    job: {
      id, repository: name, projectRoot: repo, title: `Delivery ${name}`,
      objective: `Verify ${mode} post-completion publishing`,
      state: 'COMPLETED', prNumber: 0, continuation: null,
      autoMerge: true, reviewEnabled: false, tasks: [], createdAt: timestamp, updatedAt: timestamp,
      localMerge: { ...receipt, sourceSha, status: 'succeeded', targetRef: 'refs/heads/main', sourceRef: 'refs/heads/feature' },
      ...(mode === 'legacy' ? {} : { remoteDelivery: { mergedCommitSha, status: 'pending', attempts: 0, updatedAt: timestamp } }),
    },
  };
}
function storedJob(dbPath, id) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { const row = db.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get(id); return row && JSON.parse(row.json); }
  finally { db.close(); }
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function launch(root, storeDir, port) {
  const env = { ...process.env, AGENTS_RELAY_STORE_DIR: storeDir, AGENTS_RELAY_WORKSPACE_ROOT: root,
    AGENTS_RELAY_NO_GITHUB: '1', GIT_TERMINAL_PROMPT: '0' };
  const child = spawn(process.execPath, [join(packageRoot, 'dist/relayd-main.js'), '--workspace-root', root,
    '--port', String(port), '--interval', '500', '--refresh-ms', '500', '--concurrency', '1'],
    { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', ready = false;
  for (const stream of [child.stdout, child.stderr]) stream.on('data', buf => {
    // The daemon emits verbose Git observability; retain the readiness receipt
    // even after the bounded diagnostic buffer has rotated past the startup line.
    output = (output + buf.toString()).slice(-6000);
    if (output.includes('Dashboard listening')) ready = true;
  });
  return { child, output: () => output, ready: () => ready };
}
async function until(condition, producer, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.fail('Timed out awaiting real daemon remote-delivery state: ' + producer());
}
async function stop(runtime) {
  if (!runtime || runtime.child.exitCode !== null) return;
  runtime.child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => runtime.child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 3000)),
  ]);
  if (runtime.child.exitCode === null) runtime.child.kill('SIGKILL');
}

test('L3 real daemon: optional origin push, failure/retry, divergent remote, restart dedupe, historical Job isolation',
  { timeout: 110000 }, async t => {
    const root = mkdtempSync(join(tmpdir(), 'relay-remote-daemon-e2e-'));

    const storeDir = join(root, 'store'); mkdirSync(storeDir);
    const dbPath = relayUnifiedStorePath(storeDir);
    const fixtures = [
      fixture(root, 'success', 'success', '910101'),
      fixture(root, 'offline', 'offline', '910102'),
      fixture(root, 'noorigin', 'noorigin', '910103'),
      fixture(root, 'diverged', 'diverged', '910104'),
      fixture(root, 'legacy', 'legacy', '910105'),
      fixture(root, 'emptyorigin', 'emptyorigin', '910106'),
      fixture(root, 'pushredirect', 'pushredirect', '910107'),
    ];
    for (const f of fixtures) {
      const store = new SQLiteRelayStore(dbPath, f.id);
      await store.saveJob(f.job);
      store.close();
    }
    const port = await freePort();
    let daemon = launch(root, storeDir, port);
    t.after(async () => { await stop(daemon); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
    const view = id => storedJob(dbPath, id);
    await until(() => ['succeeded', 'failed', 'skipped', 'failed', null, 'skipped', 'failed'].every((expected, i) =>
      expected === null ||
      view(fixtures[i].id)?.remoteDelivery?.status === expected),
    () => JSON.stringify(fixtures.map(f => ({ id: f.id, state: view(f.id)?.state,
      status: view(f.id)?.remoteDelivery, daemon: daemon.output() }))), 45000);
    const [success, offline, noorigin, diverged, legacy, emptyorigin, pushredirect] = fixtures;
    assert.equal(git(success.root, 'ls-remote', 'origin', 'refs/heads/main').split(/\s+/)[0], success.mergedCommitSha);
    assert.notEqual(git(diverged.root, 'ls-remote', 'origin', 'refs/heads/main').split(/\s+/)[0], diverged.mergedCommitSha);
    assert.equal(git(emptyorigin.root,'ls-remote','origin','refs/heads/main'),'','empty configured origin cannot acquire a new main ref');
    assert.equal(view(emptyorigin.id).remoteDelivery.status,'skipped');
    assert.equal(git(pushredirect.root,'ls-remote','origin','refs/heads/main').split(/\s+/)[0],pushredirect.base,'verified fetch origin must not be modified');
    assert.equal(git(pushredirect.root,'ls-remote',join(root,'pushredirect-unverified.git'),'refs/heads/main'),'','redirected push origin remains untouched');
    assert.match(view(pushredirect.id).remoteDelivery.error,/push URL differs/);
    assert.equal(git(legacy.root, 'ls-remote', 'origin', 'refs/heads/main').split(/\s+/)[0], legacy.base,
      'pre-upgrade COMPLETED records must not unexpectedly push on daemon launch');
    for (const f of fixtures) {
      assert.equal(view(f.id).state, 'COMPLETED', `${f.id} must remain COMPLETED`);
      assert.equal(view(f.id).tasks.length, 0, `${f.id} must not create recovery Tasks`);
      assert.equal(view(f.id).prNumber, 0, `${f.id} must not create remote PRs`);
    }
    assert.equal(view(offline.id).remoteDelivery.attempts >= 1, true);
    assert.ok(view(offline.id).remoteDelivery.nextRetryAt);
    assert.match(view(diverged.id).remoteDelivery.error, /diverged/);
    assert.equal(view(legacy.id).remoteDelivery, undefined);
    const attempts = view(success.id).remoteDelivery.attempts;
    await stop(daemon);
    daemon = launch(root, storeDir, port);
    await until(() => daemon.ready(), daemon.output, 25000);
    await new Promise(resolve => setTimeout(resolve, 1400));
    assert.equal(view(success.id).remoteDelivery.attempts, attempts, 'restart cannot duplicate successful push');
    assert.equal(view(legacy.id).remoteDelivery, undefined, 'restart cannot backfill historical Jobs');
    assert.equal(view(noorigin.id).remoteDelivery.status, 'skipped');
    assert.equal(view(offline.id).state, 'COMPLETED');
    assert.equal(view(diverged.id).state, 'COMPLETED');
    const store = new SQLiteRelayStore(dbPath, success.id);
    try { assert.equal(await store.pendingProjectionCount(), 0, 'no remote PR outbox should be generated'); }
    finally { store.close(); }
  });
