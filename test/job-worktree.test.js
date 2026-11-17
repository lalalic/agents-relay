import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertCleanWorktreeAtHead, cleanupCompletedJobWorktree, ensureLocalJobSourceBranch, jobRequiresManagedWorktree, taskRequiresManagedWorktree, managedJobWorktreePath, managedLocalJobWorktreePath, prepareLocalJobExecutionWorktree, prepareManagedExecutionWorktree } from '../dist/workspace.js';

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

test('only code Tasks request managed Git worktrees', () => {
  const base = { id: 'job', tasks: [], schedule: undefined };
  assert.equal(jobRequiresManagedWorktree(base), false);
  assert.equal(jobRequiresManagedWorktree({ ...base, tasks: [{ output: { kind: 'file', path: 'runs/result.md' } }] }), false);
  assert.equal(jobRequiresManagedWorktree({ ...base, tasks: [{ output: { kind: 'task_pr' } }] }), true);
  assert.equal(jobRequiresManagedWorktree({ ...base, prNumber: 7, tasks: [{ output: { kind: 'task_pr' } }] }), true);
  assert.equal(jobRequiresManagedWorktree({ ...base, localMerge: { sourceRef: 'refs/heads/legacy', targetRef: 'refs/heads/main', status: 'pending' } }), true);
  assert.equal(jobRequiresManagedWorktree({ ...base, schedule: { cron: '* * * * *' } }), false);
});

test('a task_pr Troubleshooter below a canonical runs owner keeps the canonical project path', () => {
  const owner = { id: 'run-owner', output: { kind: 'file', path: 'runs/episode/result.md' } };
  const troubleshooting = { id: 'recovery', parentTaskId: owner.id, output: { kind: 'task_pr' } };
  const job = { id: 'job', prNumber: 0, tasks: [owner, troubleshooting] };
  assert.equal(jobRequiresManagedWorktree(job), true);
  assert.equal(taskRequiresManagedWorktree(job, troubleshooting), false);
  assert.equal(taskRequiresManagedWorktree(job, { id: 'code', output: { kind: 'task_pr' } }), true);
});

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
    id:'281', projectRoot:await realpath(f.repo), state:'ACTIVE', repository:'repository', prNumber:0,
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

test('local Job reuses canonical checkout when it already owns the source branch', async t => {
  const f = await fixture(t);
  git(f.repo,'checkout','-b','repair-in-place');
  await writeFile(join(f.repo,'scratch.txt'),'preserve me\n');
  const job={
    id:'282',projectRoot:await realpath(f.repo),state:'ACTIVE',repository:'repository',prNumber:0,
    tasks:[],plans:[],localMerge:{sourceRef:'refs/heads/repair-in-place',targetRef:'refs/heads/main',status:'pending'}
  };
  const checkout=await prepareLocalJobExecutionWorktree(f.repo,job,f.root);
  assert.equal(await realpath(checkout),await realpath(f.repo));
  assert.equal(git(checkout,'symbolic-ref','HEAD'),'refs/heads/repair-in-place');
  assert.match(git(checkout,'status','--porcelain'),/scratch\.txt/);
  const managed=managedLocalJobWorktreePath(job.repository,job.id,f.root);
  await assert.rejects(()=>import('node:fs/promises').then(({stat})=>stat(managed)),/ENOENT/);
});


test('ordinary SQLite Job creates and reuses isolated source branch without touching main', async t => {
  const f=await fixture(t);
  const job={id:'283',projectRoot:await realpath(f.repo),repository:'repository',prNumber:0,state:'ACTIVE',tasks:[],plans:[]};
  const main=git(f.repo,'rev-parse','main');
  const sourceRef=await ensureLocalJobSourceBranch(f.repo,job);
  assert.match(sourceRef,/^refs\/heads\/relay\/job-/);
  assert.equal(await ensureLocalJobSourceBranch(f.repo,job),sourceRef);
  assert.equal(git(f.repo,'rev-parse',sourceRef),main);
  const bound={...job,localMerge:{sourceRef,targetRef:'refs/heads/main',status:'pending'}};
  const checkout=await prepareLocalJobExecutionWorktree(f.repo,bound,f.root);
  assert.equal(git(checkout,'symbolic-ref','HEAD'),sourceRef);
  assert.equal(git(f.repo,'symbolic-ref','HEAD'),'refs/heads/main');
  assert.equal(git(f.repo,'rev-parse','main'),main);
});


test('independent-repository Job worktree resolves to its canonical Git root only', async t => {
  const f = await fixture(t);
  git(f.repo,'branch','episode-proj-branch');
  const job={id:'vlog-episode',projectRoot:f.repo,state:'ACTIVE',repository:'repository',prNumber:0,
    tasks:[],plans:[],localMerge:{sourceRef:'refs/heads/episode-proj-branch',targetRef:'refs/heads/main',status:'pending'}};
  const checkout=await prepareLocalJobExecutionWorktree(f.repo,job,f.root);
  assert.equal(await realpath(checkout),await realpath(managedLocalJobWorktreePath(job.repository,job.id,f.root)));
  assert.equal(await realpath(git(checkout,'rev-parse','--show-toplevel')),await realpath(checkout));
});

// The same negative cleanup properties on the current independent local Git Job model.
test('dirty local Job checkout and active Task lease block completed cleanup',async t=>{
 const f=await fixture(t);git(f.repo,'branch','local-safe-cleanup');
 const job={id:'291',projectRoot:await realpath(f.repo),repository:'repository',prNumber:0,state:'ACTIVE',tasks:[],plans:[],
  localMerge:{sourceRef:'refs/heads/local-safe-cleanup',targetRef:'refs/heads/main',status:'pending'}};
 const checkout=await prepareLocalJobExecutionWorktree(f.repo,job,f.root);
 job.state='COMPLETED';job.localMerge={...job.localMerge,sourceSha:f.head.sha,status:'succeeded'};
 await writeFile(join(checkout,'scratch.txt'),'do not delete');
 assert.deepEqual(await cleanupCompletedJobWorktree(f.repo,job,f.root),{status:'blocked',reason:'Worktree has uncommitted or untracked changes'});
 await unlink(join(checkout,'scratch.txt'));
 job.tasks=[{executionId:'active',leaseOwner:'relay',state:'RUNNING'}];
 assert.equal((await cleanupCompletedJobWorktree(f.repo,job,f.root)).reason,'Task still owns an execution or lease');
 job.tasks=[];
 assert.deepEqual(await cleanupCompletedJobWorktree(f.repo,job,f.root),{status:'removed'});
 assert.deepEqual(await cleanupCompletedJobWorktree(f.repo,job,f.root),{status:'absent'});
});
test('unique unmerged commit prevents local Job worktree cleanup',async t=>{
 const f=await fixture(t);git(f.repo,'branch','local-unique-cleanup');
 const job={id:'292',projectRoot:await realpath(f.repo),repository:'repository',prNumber:0,state:'COMPLETED',tasks:[],plans:[],
  localMerge:{sourceRef:'refs/heads/local-unique-cleanup',targetRef:'refs/heads/main',sourceSha:f.head.sha,status:'succeeded'}};
 const checkout=await prepareLocalJobExecutionWorktree(f.repo,job,f.root);
 git(checkout,'config','user.name','Relay Test');git(checkout,'config','user.email','relay-test@example.com');
 await writeFile(join(checkout,'file.txt'),'unique commit\n');git(checkout,'add','file.txt');git(checkout,'commit','-m','unmerged work');
 assert.equal((await cleanupCompletedJobWorktree(f.repo,job,f.root)).reason,'Worktree contains unique or stale commits');
});
