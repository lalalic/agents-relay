import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertCleanWorktreeAtHead, cleanupCompletedJobWorktree, managedJobWorktreePath, managedLocalJobWorktreePath, prepareLocalJobExecutionWorktree, prepareManagedExecutionWorktree } from '../dist/workspace.js';

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

async function fixture(t) {
  const temp = await mkdtemp(join(tmpdir(), 'relay-job-tree-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, 'workspace');
  const repo = join(root, 'repository');
  const bare = join(temp, 'origin.git');
  await mkdir(repo, {recursive:true});
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Relay Test');
  git(repo, 'config', 'user.email', 'relay-test@example.com');
  await writeFile(join(repo, 'file.txt'), 'first\n');
  git(repo, 'add', 'file.txt');
  git(repo, 'commit', '-m', 'baseline');
  git(temp, 'init', '--bare', bare);
  git(repo, 'remote', 'add', 'origin', 'https://github.com/example/isolated.git');
  git(repo, 'config', `url.file://${bare}.insteadOf`, 'https://github.com/example/isolated.git');
  git(repo, 'push', 'origin', 'HEAD:refs/heads/feature');
  const sha = git(repo, 'rev-parse', 'HEAD');
  const job = { state:'COMPLETED', headSha:sha, repository:'example/isolated', prNumber:456, tasks:[], plans:[] };
  const head = { ref: 'feature', sha };
  return { root, repo, job, head, path:managedJobWorktreePath(job.repository, job.prNumber, root) };
}

test('one stable worktree is reused by every execution ID', async t => {
  const f = await fixture(t);
  const first = await prepareManagedExecutionWorktree(f.repo, f.job.repository, f.job.prNumber, f.head, 'execution-A', f.root);
  const second = await prepareManagedExecutionWorktree(f.repo, f.job.repository, f.job.prNumber, f.head, 'execution-B', f.root);
  assert.equal(first, f.path);
  assert.equal(second, f.path);
  assert.equal(git(f.path,'rev-parse','HEAD'), f.head.sha);
});

test('dirty Job worktree survives retry and blocks cleanup', async t => {
  const f = await fixture(t);
  await prepareManagedExecutionWorktree(f.repo, f.job.repository, f.job.prNumber, f.head, 'first', f.root);
  await writeFile(join(f.path, 'scratch.txt'), 'do not delete');
  assert.equal(await prepareManagedExecutionWorktree(f.repo, f.job.repository, f.job.prNumber, f.head, 'retry', f.root), f.path);
  assert.deepEqual(await cleanupCompletedJobWorktree(f.repo, f.job, f.root), { status:'blocked', reason:'Worktree has uncommitted or untracked changes' });
  await unlink(join(f.path, 'scratch.txt'));
  assert.deepEqual(await cleanupCompletedJobWorktree(f.repo, f.job, f.root), { status:'removed' });
  assert.deepEqual(await cleanupCompletedJobWorktree(f.repo, f.job, f.root), { status:'absent' });
});

test('unique commits and active leases prevent deletion', async t => {
  const f = await fixture(t);
  await prepareManagedExecutionWorktree(f.repo, f.job.repository, f.job.prNumber, f.head, 'first', f.root);
  f.job.tasks = [{ executionId: 'running', leaseOwner:'relay', state:'RUNNING' }];
  assert.equal((await cleanupCompletedJobWorktree(f.repo, f.job, f.root)).status, 'blocked');
  f.job.tasks=[];
  git(f.path, 'config', 'user.name', 'Relay Test');
  git(f.path, 'config', 'user.email', 'relay-test@example.com');
  await writeFile(join(f.path,'file.txt'),'second\n');
  git(f.path,'add','file.txt');
  git(f.path,'commit','-m','unpublished local work');
  assert.equal((await cleanupCompletedJobWorktree(f.repo, f.job, f.root)).reason, 'Worktree contains unique or stale commits');
});

test('stable Worktree advances only through clean fast forward', async t => {
  const f=await fixture(t);
  await prepareManagedExecutionWorktree(f.repo,f.job.repository,f.job.prNumber,f.head,'first',f.root);
  await writeFile(join(f.repo,'file.txt'),'remote update\n');
  git(f.repo,'add','file.txt');
  git(f.repo,'commit','-m','next');
  git(f.repo,'push','origin','HEAD:refs/heads/feature');
  const newer={ref:'feature',sha:git(f.repo,'rev-parse','HEAD')};
  await writeFile(join(f.path,'scratch.txt'),'keep me');
  await assert.rejects(() => prepareManagedExecutionWorktree(f.repo,f.job.repository,f.job.prNumber,newer,'retry',f.root),/changes while PR head advanced/);
  await unlink(join(f.path,'scratch.txt'));
  assert.equal(await prepareManagedExecutionWorktree(f.repo,f.job.repository,f.job.prNumber,newer,'retry',f.root),f.path);
  assert.equal(git(f.path,'rev-parse','HEAD'),newer.sha);
});


test('reviewer refuses dirty or stale Job checkout', async t => {
  const f=await fixture(t);
  await prepareManagedExecutionWorktree(f.repo,f.job.repository,f.job.prNumber,f.head,'review',f.root);
  await assertCleanWorktreeAtHead(f.path, f.head.sha);
  await writeFile(join(f.path,'scratch.txt'),'not committed');
  await assert.rejects(() => assertCleanWorktreeAtHead(f.path,f.head.sha),/uncommitted changes/);
  await unlink(join(f.path,'scratch.txt'));
  await assert.rejects(() => assertCleanWorktreeAtHead(f.path,'0'.repeat(40)),/stale HEAD/);
});

test('a completed Job ignores merged PR observations without GitHub-triggered cleanup', async () => {
  const { decideJobReconcile } = await import('../dist/workflow/job-reconcile-v2.js');
  const result=decideJobReconcile({ id:'example', state:'COMPLETED' },
    { jobActive:false, implementationComplete:true, headAvailable:true, deliveryReady:true });
  assert.equal(result.accepted,false);
  assert.equal(result.target,null);
  assert.deepEqual(result.effects,[]);
});


test('local Job gets one stable source-ref worktree and cleanup removes it', async t => {
  const f = await fixture(t);
  git(f.repo, 'branch', 'local-job-source', f.head.sha);
  const job = {
    id:'local-job-1', state:'ACTIVE', repository:'example/isolated', prNumber:0,
    tasks:[], plans:[], localMerge:{sourceRef:'refs/heads/local-job-source',targetRef:'refs/heads/main',status:'pending'}
  };
  const expected = managedLocalJobWorktreePath(job.repository, job.id, f.root);
  const first = await prepareLocalJobExecutionWorktree(f.repo, job, f.root);
  const second = await prepareLocalJobExecutionWorktree(f.repo, job, f.root);
  assert.equal(first, expected);
  assert.equal(second, expected);
  assert.equal(git(expected,'symbolic-ref','HEAD'),'refs/heads/local-job-source');
  assert.equal(git(expected,'rev-parse','HEAD'),f.head.sha);
  await writeFile(join(expected,'file.txt'),'local job change\n');
  git(expected,'add','file.txt');
  git(expected,'commit','-m','local job result');
  const sourceSha=git(expected,'rev-parse','HEAD');
  job.state='COMPLETED'; job.localMerge={...job.localMerge,status:'succeeded',sourceSha,mergedCommitSha:sourceSha};
  assert.deepEqual(await cleanupCompletedJobWorktree(f.repo,job,f.root),{status:'removed'});
});
