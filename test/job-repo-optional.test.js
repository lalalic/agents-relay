import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureManagedGitHubJob } from '../dist/cli-job-create.js';

const execAsync = promisify(execFile);
const root = new URL('../', import.meta.url).pathname;
const cli = join(root, 'dist/cli.js');
const execute = (args, env = {}) => execAsync(process.execPath, [cli, 'job', ...args], {
  cwd: root, timeout: 15_000, env: { ...process.env, ...env },
});

test('existing Job CLI uses --id without --repo, preserves repository validation, and lists across repositories', async () => {
  const job = { id: '1771', title: 'fixture', repository: 'team/relay', state: 'ACTIVE',
    prNumber: 0, priority: 'P2', tasks: [], continuation: null, autoMerge: false,
    reviewEnabled: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const calls = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const providedRepo = url.searchParams.get('repo');
    const send = (status, payload) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
    calls.push({ method: req.method, path: url.pathname, repository: providedRepo });
    if (url.pathname === '/api/jobs') {
      send(200, { jobs: [job, { ...job, id: '1772', repository: 'team/other' }] }); return;
    }
    if (url.pathname === '/api/job' || url.pathname === '/api/job-state') {
      if (url.searchParams.get('id') !== job.id || (providedRepo && providedRepo !== job.repository)) {
        send(404, { error: 'Unknown immutable Job binding' }); return;
      }
      send(200, { ...job, ...(url.pathname === '/api/job-state' ? { state: 'CANCELLED' } : {}) }); return;
    }
    if (url.pathname === '/api/control') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (body.jobId !== job.id || !['job.update','job.unblock'].includes(body.command)) {
        send(409, { error: 'Unsupported operation' }); return;
      }
      calls.at(-1).command = body.command;
      send(200, { ...job, ...(body.patch ?? {}) }); return;
    }
    send(404, { error: 'No route' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = String(server.address().port);
  const flags = ['--port', port];
  try {
    const list = JSON.parse((await execute(['list', ...flags])).stdout);
    assert.deepEqual(list.map(x => x.id), ['1771','1772']);
    const filtered = JSON.parse((await execute(['list', '--repo','team/relay', ...flags])).stdout);
    assert.deepEqual(filtered.map(x => x.id), [job.id]);
    assert.equal(JSON.parse((await execute(['show','--id',job.id,...flags])).stdout).repository, job.repository);
    assert.equal(JSON.parse((await execute(['show','--id',job.id,'--repo',job.repository,...flags])).stdout).id, job.id);
    await assert.rejects(execute(['show','--id',job.id,'--repo','team/other',...flags]), /Unknown immutable Job binding/);
    assert.equal(JSON.parse((await execute(['update','--id',job.id,'--priority','P0',...flags])).stdout).priority, 'P0');
    assert.equal(JSON.parse((await execute(['unblock','--id',job.id,'--reason','resolved',...flags])).stdout).id, job.id);
    await assert.rejects(execute(['merge','--id',job.id,...flags]), /GitHub is audit-only/);
    assert.equal(JSON.parse((await execute(['cancel','--id',job.id,...flags])).stdout).state, 'CANCELLED');
    assert.ok(calls.some(c => c.command === 'job.update'));
    assert.ok(calls.some(c => c.command === 'job.unblock'));
    assert.ok(calls.some(c => c.path === '/api/job-state' && c.repository === null));
    const before = calls.length;
    await assert.rejects(execute(['cancel','--id',job.id,'--repo','team/other',...flags]), /Unknown immutable Job binding/);
    assert.equal(calls.length, before + 1);
    assert.equal(calls.at(-1).path, '/api/job');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('local SQLite Job pause/resume and Coordinator CLI resolve --id without repository or cwd-derived identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-optional-repo-'));
  const stores = join(dir, 'stores');
  await mkdir(stores);
  const env = { AGENTS_RELAY_STORE_DIR: stores, AGENTS_RELAY_NO_GITHUB: '1' };
  const isolatedFlags = ['--store-dir', stores, '--events', 'none'];
  try {
    const { job } = await ensureManagedGitHubJob({}, 'team/relay', new Set(), {
      objective: 'Existing managed job', storeDirectory: stores,
    });
    const id = job.id;
    const paused = JSON.parse((await execute(['pause','--id',id,...isolatedFlags],env)).stdout);
    assert.equal(paused.state, 'DRAFT');
    assert.ok(paused.pause);
    await assert.rejects(execute(['resume','--id',id,'--repo','team/other',...isolatedFlags],env),
      /not found for repository/);
    const resumed = JSON.parse((await execute(['resume','--id',id,...isolatedFlags],env)).stdout);
    assert.equal(resumed.pause, undefined);
    assert.equal(resumed.repository, 'team/relay');

    const { job: shortcut } = await ensureManagedGitHubJob({}, 'team/shortcuts', new Set(), {
      objective: 'External start', storeDirectory: stores,
    });
    const run = ['run','--id',shortcut.id,'--task-id','unknown',...isolatedFlags];
    await assert.rejects(execute(run,env), /Task unknown not found/);
    assert.equal(shortcut.id, (await ensureManagedGitHubJob({},'team/shortcuts',new Set(),{id:shortcut.id,storeDirectory:stores})).job.id);
    assert.equal((await ensureManagedGitHubJob({},'team/shortcuts',new Set(),{id:shortcut.id,storeDirectory:stores})).job.executionMode,undefined);

    await assert.rejects(execute(['run','--id',shortcut.id,
      '--task-id','unknown','--repo','team/other',...isolatedFlags],env), /not found for repository/);
    await assert.rejects(execute(['run','--legacy-shortcut-runtime','--id',shortcut.id,
      '--task-id','unknown',...isolatedFlags],env), /Legacy Shortcut runners and execution modes are removed/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Job creation continues to require repository identification without local-only override', () => {
  const result = spawnSync(process.execPath, [cli, 'job', 'create', '--objective', 'Standalone objective'], {
    cwd: root, encoding: 'utf8', timeout: 5000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--repo is required/);
});
