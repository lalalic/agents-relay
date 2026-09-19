import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { marker, JOB_MARKER } from '../dist/markers.js';
import { aggregateManagedGitHubJobs } from '../dist/pool.js';
import { discoverGitRepositories, discoverWorkspaceRepositories, githubRepositoryFromRemote } from '../dist/workspace.js';

const exec = promisify(execFile);
const now = () => new Date().toISOString();
const job = (id, repository, prNumber) => ({ id, title: id, prNumber, repository, state: 'OPEN', continuation: null, createdAt: now(), updatedAt: now(), tasks: undefined });

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

test('workspace repository parsing ignores non-GitHub remotes', () => {
  assert.equal(githubRepositoryFromRemote('git@gitlab.com:someone/project.git'), null);
  assert.equal(githubRepositoryFromRemote('ssh://git@github.com/lalalic/neo.git'), 'lalalic/neo');
});

test('managed job aggregation spans repositories', async () => {
  const jobs = { 'lalalic/neo': job('neo-job', 'lalalic/neo', 20), 'lalalic/agents-relay': job('relay-job', 'lalalic/agents-relay', 28) };
  const client = { request: async path => {
    const repository = Object.keys(jobs).find(value => path.includes(`/repos/${value}/`));
    if (!repository) throw new Error(`unexpected ${path}`);
    if (path.includes('/pulls?')) return [{ number: jobs[repository].prNumber, state: 'open', body: '', head: { ref: 'feature' }, base: { ref: 'main' } }];
    if (path.includes('/issues/')) return [{ user: { login: 'bot' }, body: marker(JOB_MARKER, jobs[repository]) }];
    throw new Error(`unexpected ${path}`);
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
  const client = { request: async path => {
    if (path.includes('/pulls?')) { pullLists += 1; return [{ number: 28, state: 'open', body: '', head: { ref: 'feature' }, base: { ref: 'main' } }]; }
    if (path.includes('/issues/')) return [{ user: { login: 'bot' }, body: marker(JOB_MARKER, rootJob) }];
    throw new Error(`unexpected ${path}`);
  } };
  const result = await aggregateManagedGitHubJobs(client, ['lalalic/agents-relay', 'lalalic/agents-relay'], new Set(['bot']));
  assert.equal(pullLists, 1);
  assert.deepEqual(result.map(item => item.job.id), ['relay-job']);
});
