import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ensureManagedGitHubJob } from '../dist/cli-job-create.js';
import { resolveJobProjectRoot } from '../dist/workspace.js';

test('Job identity is a validated local Git root, with nested projectPath and no implicit GitHub remote', async t => {
  const root = await mkdtemp(join(tmpdir(), 'relay-local-identity-'));
  const projectRoot = join(root, 'neo');
  await mkdir(join(projectRoot, 'vlog'), { recursive: true });
  execFileSync('git', ['init', '-q', projectRoot]);
  t.after(() => rm(root, { recursive: true, force: true }));
  const { job } = await ensureManagedGitHubJob({}, basename(projectRoot), new Set(), {
    projectRoot, projectPath: 'vlog', objective: 'nested project', storeDirectory: join(root, 'stores'), noGitHub: true,
  });
  assert.equal(job.repository, 'neo');
  assert.equal(job.projectRoot, await realpath(projectRoot));
  assert.equal(job.projectPath, 'vlog');
  assert.equal(job.githubRepo, undefined);
  assert.equal(await resolveJobProjectRoot(job), await realpath(projectRoot));
  await assert.rejects(resolveJobProjectRoot({ ...job, repository: 'wrong-root' }), /does not match Git root name/);
  await assert.rejects(ensureManagedGitHubJob({}, 'owner/repo', new Set(), {
    projectRoot, objective: 'invalid remote identity', storeDirectory: join(root, 'stores'), noGitHub: true,
  }), /does not match Git root name/);
});

test('projectRoot remains immutable through durable SQLite Job mutation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'relay-local-immutable-'));
  const projectRoot = join(root, 'repo');
  await mkdir(projectRoot, { recursive: true });
  execFileSync('git', ['init', '-q', projectRoot]);
  t.after(() => rm(root, { recursive: true, force: true }));
  const { job } = await ensureManagedGitHubJob({}, 'repo', new Set(), {
    projectRoot, objective: 'immutable root', storeDirectory: join(root, 'stores'), noGitHub: true,
  });
  const { SQLiteRelayStore } = await import('../dist/relay-store.js');
  const { relayUnifiedStorePath } = await import('../dist/relay-store-discovery.js');
  const store = new SQLiteRelayStore(relayUnifiedStorePath(join(root, 'stores')), job.id);
  t.after(() => store.close());
  await assert.rejects(store.mutateJob(job.id, current => ({ ...current, projectRoot: root })), /projectRoot are immutable/);
  assert.equal((await store.loadJob(job.id)).projectRoot, await realpath(projectRoot));
});

test('linked execution worktree must not become the immutable Job projectRoot', async t => {
  const root = await mkdtemp(join(tmpdir(), 'relay-linked-root-'));
  const primary = join(root, 'repo');
  const linked = join(root, 'worktree');
  await mkdir(primary);
  const git = (...args) => execFileSync('git', ['-C', primary, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  execFileSync('git', ['-C', primary, 'commit', '--allow-empty', '-m', 'init'], { stdio: 'ignore' });
  git('worktree', 'add', '-q', '-b', 'test-checkout', linked);
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await resolveJobProjectRoot({ id: '1', repository: 'repo', projectRoot: primary }), await realpath(primary));
  await assert.rejects(resolveJobProjectRoot({ id: '2', repository: 'worktree', projectRoot: linked }), /primary Git checkout/);
});

test('SQLite rejects two distinct local Git roots with the same repository identity', async t => {
  const root = await mkdtemp(join(tmpdir(), 'relay-repo-collision-'));
  const first = join(root, 'a', 'repo'), second = join(root, 'b', 'repo');
  await mkdir(first, { recursive: true });
  await mkdir(second, { recursive: true });
  for (const path of [first, second]) execFileSync('git', ['init', '-q', path]);
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { objective: 'identity collision check', storeDirectory: join(root, 'stores'), noGitHub: true };
  const result = await ensureManagedGitHubJob({}, 'repo', new Set(), { ...options, projectRoot: first });
  assert.equal(result.job.repository, 'repo');
  await assert.rejects(ensureManagedGitHubJob({}, 'repo', new Set(), { ...options, projectRoot: second }), /Local repository identity collision/);
});
