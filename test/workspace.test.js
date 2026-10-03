import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from './test-runtime.js';
import { marker, JOB_MARKER } from '../dist/markers.js';
import { aggregateManagedGitHubJobs } from '../dist/pool.js';
import { discoverGitRepositories, discoverWorkspaceRepositories, githubRepositoryFromRemote, isProjectRunPath, prepareManagedExecutionWorktree, resolveManagedProjectPath, resolveRepositoryProjectPath, resolveWorkspaceRepositoryPath, taskUsesCanonicalProjectRun } from '../dist/workspace.js';

const exec = promisify(execFile);
const now = () => new Date().toISOString();
const job = (id, repository, prNumber) => ({ id, title: id, prNumber, repository, state: 'ACTIVE', continuation: null, createdAt: now(), updatedAt: now(), tasks: undefined });

test('workspace discovery finds nested git checkouts and GitHub origins', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-relay-workspace-'));
  try {
    const repo = join(root, 'neo');
    const nested = join(root, 'group', 'agents-relay');
    await mkdir(nested, { recursive: true });
    for (const [path, remote] of [[repo, 'git@github.com:lalalic/neo.git'], [nested, 'https://github.com/lalalic/agents-relay.git']]) {
      await exec('git', ['init', '-q', path]);
      await exec('git', ['-C', path, 'remote', 'add', 'origin', remote]);
    }
    assert.deepEqual(await discoverGitRepositories(root), [nested, repo]);
    assert.deepEqual(await discoverWorkspaceRepositories(root), [{ path: nested, repository: 'lalalic/agents-relay' }, { path: repo, repository: 'lalalic/neo' }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('repository path resolution uses managed repository identity instead of launcher cwd', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-relay-repository-path-'));
  try {
    const repo = join(root, 'agents-relay');
    await mkdir(repo, { recursive: true });
    await exec('git', ['init', '-q', repo]);
    await exec('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:lalalic/agents-relay.git']);
    assert.equal(await resolveWorkspaceRepositoryPath('lalalic/agents-relay', root), repo);
    assert.equal(await resolveManagedProjectPath('lalalic/agents-relay', '', root, join(root, 'launcher')), repo);
    assert.notEqual(await resolveManagedProjectPath('lalalic/agents-relay', '', root, join(root, 'launcher')), join(root, 'launcher'));
    await assert.rejects(resolveWorkspaceRepositoryPath('lalalic/missing', root), /pass --project-path explicitly/);
  } finally { await rm(root, { recursive: true, force: true }); }
});



test('job project paths are repository-relative and cannot escape the repository', () => {
  assert.equal(resolveRepositoryProjectPath('/tmp/repo', undefined), '/tmp/repo');
  assert.equal(resolveRepositoryProjectPath('/tmp/repo', 'repo'), '/tmp/repo');
  assert.equal(resolveRepositoryProjectPath('/tmp/repo', 'neo-build-log'), '/tmp/repo/neo-build-log');
  assert.throws(() => resolveRepositoryProjectPath('/tmp/repo', '/etc'), /repository-relative/);
  assert.throws(() => resolveRepositoryProjectPath('/tmp/repo', '../outside'), /escapes repository root/);
});

test('runs artifacts use the canonical project runtime across nested Tasks', () => {
  const base = {
    jobId: 'job', kind: 'work', priority: 'P1', storySize: 'S', dependencies: [], capabilities: [],
    adapter: 'codex', continuation: null, continuationDeliveredAt: null, state: 'QUEUED', attempt: 0,
    maxAttempts: 3, leaseOwner: null, leaseExpiresAt: null, executionId: null, threadId: null,
    result: null, error: null, timeoutMs: 1000, createdAt: now(), updatedAt: now(), input: 'work',
  };
  const episode = { ...base, id: 'episode', parentTaskId: null, output: { kind: 'file', path: 'runs/2026-10-02/package.md' } };
  const review = { ...base, id: 'review', parentTaskId: 'episode', output: { kind: 'task_pr' } };
  const unrelated = { ...base, id: 'code', parentTaskId: null, output: { kind: 'task_pr' } };
  assert.equal(isProjectRunPath('runs/2026-10-02/qa.md'), true);
  assert.equal(isProjectRunPath('./runs/2026-10-02/qa.md'), true);
  assert.equal(isProjectRunPath('src/runs.ts'), false);
  assert.equal(taskUsesCanonicalProjectRun(episode, [episode, review, unrelated]), true);
  assert.equal(taskUsesCanonicalProjectRun(review, [episode, review, unrelated]), true);
  assert.equal(taskUsesCanonicalProjectRun(unrelated, [episode, review, unrelated]), false);
});

test('workspace repository parsing ignores non-GitHub remotes', () => {
  assert.equal(githubRepositoryFromRemote('git@gitlab.com:someone/project.git'), null);
  assert.equal(githubRepositoryFromRemote('ssh://git@github.com/lalalic/neo.git'), 'lalalic/neo');
});

test('managed job aggregation spans repositories', async () => {
  const jobs = { 'lalalic/neo': job('neo-job', 'lalalic/neo', 20), 'lalalic/agents-relay': job('relay-job', 'lalalic/agents-relay', 28) };
  const client = { request: async path => { throw new Error(`unexpected REST ${path}`); }, graphql: async (_query, variables={}) => {
    const repository = `${variables.owner}/${variables.name}`;
    const root = jobs[repository];
    if (!root) throw new Error(`unexpected ${repository}`);
    return {repository:{open:{nodes:[{number:root.prNumber,body:'',state:'OPEN',isDraft:false,merged:false,mergedAt:null,closedAt:null,comments:{nodes:[{author:{login:'bot'},body:marker(JOB_MARKER,root)}]}}],pageInfo:{hasNextPage:false,endCursor:null}},recentClosed:{nodes:[]}}};
  } };
  const result = await aggregateManagedGitHubJobs(client, ['lalalic/neo', 'lalalic/agents-relay'], new Set(['bot']));
  assert.deepEqual(result.map(item => item.job.id).sort(), ['neo-job', 'relay-job']);
});


test('workspace discovery deduplicates multiple checkouts of the same GitHub repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-relay-workspace-dedupe-'));
  try {
    const primary = join(root, 'neo');
    const worktree = join(root, '.worktrees', 'neo-feature');
    const backup = join(root, '.backup', 'neo-old');
    for (const path of [primary, worktree, backup]) {
      await mkdir(path, { recursive: true });
      await exec('git', ['init', '-q', path]);
      await exec('git', ['-C', path, 'remote', 'add', 'origin', 'git@github.com:lalalic/neo.git']);
    }
    assert.deepEqual(await discoverWorkspaceRepositories(root), [{ path: primary, repository: 'lalalic/neo' }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('managed job aggregation deduplicates duplicate repository inputs', async () => {
  let pullLists = 0;
  const rootJob = job('relay-job', 'lalalic/agents-relay', 28);
  const client = { request: async path => { throw new Error(`unexpected REST ${path}`); }, graphql: async () => {
    pullLists += 1;
    return {repository:{open:{nodes:[{number:28,body:'',state:'OPEN',isDraft:false,merged:false,mergedAt:null,closedAt:null,comments:{nodes:[{author:{login:'bot'},body:marker(JOB_MARKER,rootJob)}]}}],pageInfo:{hasNextPage:false,endCursor:null}},recentClosed:{nodes:[]}}};
  } };
  const result = await aggregateManagedGitHubJobs(client, ['lalalic/agents-relay', 'lalalic/agents-relay'], new Set(['bot']));
  assert.equal(pullLists, 1);
  assert.deepEqual(result.map(item => item.job.id), ['relay-job']);
});


test('managed job discovery paginates all open PRs but bounds closed history', async () => {
  const openA = job('open-a', 'lalalic/agents-relay', 30);
  const openB = job('open-b', 'lalalic/agents-relay', 29);
  const closed = { ...job('closed', 'lalalic/agents-relay', 28), state: 'COMPLETED' };
  let calls = 0;
  const node = (root, state='OPEN') => ({number:root.prNumber,body:'',state,isDraft:false,merged:state==='CLOSED',mergedAt:state==='CLOSED'?now():null,closedAt:state==='CLOSED'?now():null,comments:{nodes:[{author:{login:'bot'},body:marker(JOB_MARKER,root)}]}});
  const client = { request: async path => { throw new Error(`unexpected REST ${path}`); }, graphql: async (query, variables={}) => {
    calls += 1;
    if (!variables.cursor) {
      assert.match(query, /recentClosed:pullRequests\(first:20,states:CLOSED/);
      assert.match(query, /recentMerged:pullRequests\(first:20,states:MERGED/);
      return {repository:{open:{nodes:[node(openA)],pageInfo:{hasNextPage:true,endCursor:'next'}},recentClosed:{nodes:[node(closed,'CLOSED')]}}};
    }
    assert.doesNotMatch(query, /recentClosed:/);
    return {repository:{open:{nodes:[node(openB)],pageInfo:{hasNextPage:false,endCursor:null}}}};
  } };
  const result = await aggregateManagedGitHubJobs(client, ['lalalic/agents-relay'], new Set(['bot']));
  assert.equal(calls, 2);
  assert.deepEqual(result.map(item => item.job.id).sort(), ['closed', 'open-a', 'open-b']);
});

test('managed job discovery retains recent merged PRs when closed history is crowded', async () => {
  const merged = { ...job('merged-44', 'lalalic/agents-relay', 44), state: 'COMPLETED' };
  const node = (root, state) => ({ number: root.prNumber, body: '', state, isDraft: false, merged: state === 'MERGED', mergedAt: state === 'MERGED' ? now() : null, closedAt: state === 'CLOSED' ? now() : null, comments: { nodes: [{ author: { login: 'bot' }, body: marker(JOB_MARKER, root) }] } });
  const cancelled = Array.from({ length: 20 }, (_, index) => node({ ...job(`cancelled-${index}`, 'lalalic/agents-relay', index + 1), state: 'CANCELLED' }, 'CLOSED'));
  const client = { request: async path => { throw new Error(`unexpected REST ${path}`); }, graphql: async query => {
    assert.match(query, /recentMerged:pullRequests\(first:20,states:MERGED/);
    return { repository: { open: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }, recentMerged: { nodes: [node(merged, 'MERGED')] }, recentClosed: { nodes: cancelled } } };
  } };
  const result = await aggregateManagedGitHubJobs(client, ['lalalic/agents-relay'], new Set(['bot']));
  assert.equal(result.some(item => item.job.id === 'merged-44'), true);
});

test('managed PR execution worktrees isolate concurrent jobs from the primary checkout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-relay-pr-worktrees-'));
  try {
    const bare = join(root, 'remote.git');
    const primary = join(root, 'neo');
    await exec('git', ['init', '--bare', '-q', bare]);
    await exec('git', ['init', '-q', primary]);
    await exec('git', ['-C', primary, 'config', 'user.email', 'test@example.com']);
    await exec('git', ['-C', primary, 'config', 'user.name', 'Test']);
    await exec('git', ['-C', primary, 'checkout', '-q', '-b', 'main']);
    await writeFile(join(primary, 'base.txt'), 'base\n');
    await mkdir(join(primary, 'neo-build-log'), { recursive: true });
    await writeFile(join(primary, 'neo-build-log', 'README.md'), 'content project\n');
    await exec('git', ['-C', primary, 'add', 'base.txt', 'neo-build-log/README.md']);
    await exec('git', ['-C', primary, 'commit', '-qm', 'base']);
    await exec('git', ['-C', primary, 'remote', 'add', 'origin', bare]);
    await exec('git', ['-C', primary, 'push', '-q', '-u', 'origin', 'main']);

    const heads = {};
    for (const branch of ['feature-a', 'feature-b']) {
      await exec('git', ['-C', primary, 'checkout', '-q', '-b', branch, 'main']);
      await writeFile(join(primary, branch + '.txt'), branch + '\n');
      await exec('git', ['-C', primary, 'add', branch + '.txt']);
      await exec('git', ['-C', primary, 'commit', '-qm', branch]);
      heads[branch] = (await exec('git', ['-C', primary, 'rev-parse', 'HEAD'])).stdout.trim();
      await exec('git', ['-C', primary, 'push', '-q', 'origin', branch]);
    }
    await exec('git', ['-C', primary, 'checkout', '-q', 'main']);
    const primaryHeadBefore = (await exec('git', ['-C', primary, 'rev-parse', 'HEAD'])).stdout.trim();
    const primaryBranchBefore = (await exec('git', ['-C', primary, 'branch', '--show-current'])).stdout.trim();

    const githubRemote = 'git@github.com:owner/repo.git';
    await exec('git', ['-C', primary, 'remote', 'set-url', 'origin', githubRemote]);
    await exec('git', ['-C', primary, 'config', 'url.file://' + bare + '/.insteadOf', githubRemote]);

    const first = await prepareManagedExecutionWorktree(primary, 'owner/repo', 7, { ref: 'feature-a', sha: heads['feature-a'] }, 'exec-a');
    const second = await prepareManagedExecutionWorktree(primary, 'owner/repo', 8, { ref: 'feature-b', sha: heads['feature-b'] }, 'exec-b');
    const nested = await prepareManagedExecutionWorktree(join(primary, 'neo-build-log'), 'owner/repo', 7, { ref: 'feature-a', sha: heads['feature-a'] }, 'exec-nested');

    assert.notEqual(first, second);
    assert.equal(nested.endsWith('/neo-build-log'), true);
    assert.equal((await exec('git', ['-C', nested, 'rev-parse', 'HEAD'])).stdout.trim(), heads['feature-a']);
    assert.equal((await exec('git', ['-C', first, 'rev-parse', 'HEAD'])).stdout.trim(), heads['feature-a']);
    assert.equal((await exec('git', ['-C', second, 'rev-parse', 'HEAD'])).stdout.trim(), heads['feature-b']);
    assert.equal((await exec('git', ['-C', first, 'branch', '--show-current'])).stdout.trim(), '');
    assert.equal((await exec('git', ['-C', second, 'branch', '--show-current'])).stdout.trim(), '');
    assert.equal((await exec('git', ['-C', primary, 'rev-parse', 'HEAD'])).stdout.trim(), primaryHeadBefore);
    assert.equal((await exec('git', ['-C', primary, 'branch', '--show-current'])).stdout.trim(), primaryBranchBefore);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('managed PR execution worktree fails closed when expected head is stale', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-relay-pr-stale-head-'));
  try {
    const bare = join(root, 'remote.git');
    const primary = join(root, 'repo');
    await exec('git', ['init', '--bare', '-q', bare]);
    await exec('git', ['init', '-q', primary]);
    await exec('git', ['-C', primary, 'config', 'user.email', 'test@example.com']);
    await exec('git', ['-C', primary, 'config', 'user.name', 'Test']);
    await exec('git', ['-C', primary, 'checkout', '-q', '-b', 'main']);
    await writeFile(join(primary, 'a.txt'), 'a\n');
    await exec('git', ['-C', primary, 'add', 'a.txt']);
    await exec('git', ['-C', primary, 'commit', '-qm', 'base']);
    await exec('git', ['-C', primary, 'remote', 'add', 'origin', bare]);
    await exec('git', ['-C', primary, 'push', '-q', '-u', 'origin', 'main']);
    const actual = (await exec('git', ['-C', primary, 'rev-parse', 'HEAD'])).stdout.trim();
    const githubRemote = 'git@github.com:owner/repo.git';
    await exec('git', ['-C', primary, 'remote', 'set-url', 'origin', githubRemote]);
    await exec('git', ['-C', primary, 'config', 'url.file://' + bare + '/.insteadOf', githubRemote]);
    await assert.rejects(
      prepareManagedExecutionWorktree(primary, 'owner/repo', 9, { ref: 'main', sha: '0'.repeat(40) }, 'stale'),
      new RegExp('head changed.*' + actual),
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('workspace discovery ignores every hidden directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-hidden-scan-'));
  const visible = join(root, 'visible-repo');
  const hidden = join(root, '.hidden', 'nested-repo');
  await mkdir(join(visible, '.git'), { recursive: true });
  await mkdir(join(hidden, '.git'), { recursive: true });
  assert.deepEqual(await discoverGitRepositories(root), [visible]);
});


test('workspace discovery skips every dot-prefixed directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-relay-workspace-dotdirs-'));
  try {
    const visible = join(root, 'group', 'visible-repo');
    const hiddenRepos = [
      join(root, '.worktrees', 'hidden-a'),
      join(root, '.xchat-worktrees', 'hidden-b'),
      join(root, '.cache', 'hidden-c'),
      join(root, 'group', '.nested-hidden', 'hidden-d'),
    ];
    await mkdir(visible, { recursive: true });
    await exec('git', ['init', '-q', visible]);
    await exec('git', ['-C', visible, 'remote', 'add', 'origin', 'git@github.com:lalalic/visible.git']);
    for (const repo of hiddenRepos) {
      await mkdir(repo, { recursive: true });
      await exec('git', ['init', '-q', repo]);
      await exec('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:lalalic/hidden.git']);
    }
    assert.deepEqual(await discoverGitRepositories(root), [visible]);
    assert.deepEqual(await discoverWorkspaceRepositories(root), [{ path: visible, repository: 'lalalic/visible' }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
