import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteRelayStore } from '../dist/relay-store.js';
import { createService } from '../dist/cli.js';
import { createServer } from 'node:net';

const run = promisify(execFile);
const git = (path, ...args) => execFileSync('git', ['-C', path, ...args], { encoding: 'utf8' }).trim();
const now = () => new Date().toISOString();

test('authenticated task revise CLI persists idempotent owner findings via real isolated service and Git head', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-targeted-cli-'));
  const home = join(dir, 'home'), workspace = join(home, 'Workspace');
  const repo = join(workspace, 'review-cli'), stores = join(dir, 'stores');
  mkdirSync(repo, { recursive: true }); mkdirSync(stores);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'user.name', 'Isolated Test');
  git(repo, 'commit', '--allow-empty', '-m', 'fixture');
  git(repo, 'remote', 'add', 'origin', 'https://github.com/isolated/review-cli.git');
  const sha = git(repo, 'rev-parse', 'HEAD');
  const jobId = 'targeted-cli-fixture';
  const base = (id, state, name) => ({
    id, jobId, title: id, kind: 'work', agentName: name, adapter: 'codex',
    parentTaskId: null, dependencies: [], capabilities: [], input: 'isolated task',
    output: { kind: 'task_pr' }, state, attempt: 1, maxAttempts: 3,
    leaseOwner: state === 'RUNNING' ? 'isolated-worker' : null,
    leaseExpiresAt: state === 'RUNNING' ? new Date(Date.now() + 3_600_000).toISOString() : null,
    executionId: state === 'RUNNING' ? 'reviewer-execution' : null,
    executionHistory: state === 'RUNNING' ? [{ id: 'reviewer-execution', attempt: 1, startedAt: now() }] : [],
    threadId: null, result: state === 'SUCCEEDED' ? { summary: 'immutable original' } : null,
    error: null, timeoutMs: 3_600_000, createdAt: now(), updatedAt: now(),
  });
  const owner = base('original', 'SUCCEEDED', 'implementation');
  const reviewer = {
    ...base('final-review', 'RUNNING', 'job-acceptance-reviewer'),
    reviewHeadSha: sha, dependencies: ['original'],
  };
  const sqlite = new SQLiteRelayStore(join(dir, 'relay.sqlite'), jobId);
  const job = {
    id: jobId, title: 'Targeted CLI fixture', repository: 'isolated/review-cli',
    prNumber: 0, state: 'ACTIVE', reviewEnabled: true, autoMerge: false,
    headSha: sha, continuation: null, createdAt: now(), updatedAt: now(),
    review: { outcome: 'started', headSha: sha, taskId: 'final-review', evidence: null, updatedAt: now() },
    tasks: [owner, reviewer],
  };
  const previous = Object.fromEntries(['HOME', 'AGENTS_RELAY_STORE_DIR', 'AGENTS_RELAY_NO_GITHUB']
    .map(key => [key, process.env[key]]));
  let service;
  try {
    await sqlite.saveJob(job);
    process.env.HOME = home;
    process.env.AGENTS_RELAY_STORE_DIR = stores;
    process.env.AGENTS_RELAY_NO_GITHUB = '1';
    const probe = createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    service = await createService([
      '--no-github', '--events', 'none', '--repo', job.repository, '--id', jobId,
      '--port', String(port), '--interval', '600000', '--refresh-ms', '600000',
    ]);
    const findings = join(dir, 'findings.json');
    writeFileSync(findings, JSON.stringify([{ id: 'F-1', summary: 'Repair original regression', evidence: 'assertion failed' }]));
    const args = ['task', 'revise', '--repo', job.repository, '--id', jobId,
      '--task-id', owner.id, '--review-task-id', reviewer.id, '--execution-id', reviewer.executionId,
      '--head-sha', sha, '--request-id', 'stable-review-request', '--findings-file', findings,
      '--host', '127.0.0.1', '--port', String(port)];
    const invoke = async values => {
      const result = await run(process.execPath, [join(process.cwd(), 'dist/cli.js'), ...values],
        { cwd: process.cwd(), timeout: 12000, env: { ...process.env } });
      return JSON.parse(result.stdout);
    };
    const accepted = await invoke(args);
    assert.equal(accepted.status, 'durable');
    assert.equal(accepted.created, true);
    assert.equal((await invoke(args)).created, false, 'retry must not duplicate revision work');
    const saved = await sqlite.loadJob(jobId);
    assert.equal(saved.reviewRevisionRequests.length, 1);
    assert.equal(saved.tasks.filter(item => item.revision?.kind === 'targeted').length, 1);
    assert.equal(saved.tasks.find(item => item.id === owner.id).result.summary, 'immutable original');
    assert.equal(saved.tasks.find(item => item.id === owner.id).comments.length, 1);
    await assert.rejects(invoke(args.map((item, index) =>
      args[index - 1] === '--execution-id' ? 'stale-execution' : item)), /rejected|execution/);
    await assert.rejects(invoke(args.map((item, index) =>
      args[index - 1] === '--head-sha' ? '0'.repeat(40) : item)), /head changed|rejected/);
    assert.equal((await sqlite.loadJob(jobId)).reviewRevisionRequests.length, 1);
  } finally {
    await service?.stop();
    sqlite.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
