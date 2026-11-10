import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { relayControlJob, relayJobList } from '../dist/cli-support.js';
import { listDashboardJobInventory, searchDashboardJobs } from '../dist/dashboard-data.js';

const run = promisify(execFile);
const fixture = {
  id: '589', repository: 'lalalic/neox', prNumber: 0,
  title: 'Neo Mobile Jobs', state: 'ACTIVE',
  createdAt: '2026-11-10T11:52:41.841Z', updatedAt: '2026-11-10T12:13:03.421Z',
  continuation: null, tasks: [],
};

async function withServer(handle, work) {
  const server = createServer(async (request, response) => {
    try { await handle(request, response); }
    catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { return await work(server.address().port); }
  finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

const reply = (res, value) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
};
const cli = async (port, args) => {
  const { stdout } = await run(process.execPath, ['dist/cli.js', ...args, '--port', String(port)], {
    timeout: 15_000, maxBuffer: 2 * 1024 * 1024,
  });
  return JSON.parse(stdout);
};

test('job list consumes /api/jobs dashboard envelope, filters by repository', async () => {
  await withServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    assert.equal(url.pathname, '/api/jobs');
    assert.equal(url.searchParams.get('inventory'), '1');
    assert.equal(url.searchParams.get('repo'), 'lalalic/neox');
    reply(res, { jobs: [fixture, { ...fixture, id: '590', repository: 'other/repo' }], total: 2 });
  }, async port => {
    const jobs = await cli(port, ['job', 'list', '--repo', 'lalalic/neox']);
    assert.deepEqual(jobs.map(job => job.id), ['589']);
  });
});

test('job list rejects malformed dashboard response rather than crashing with filter type error', async () => {
  await withServer((_req, res) => reply(res, { jobs: { id: '589' } }), async port => {
    await assert.rejects(() => relayJobList(['--repo', 'lalalic/neox', '--port', String(port)]),
      /Invalid Relay jobs response/);
  });
});

test('show, update, and cancel address Job by repo + id without PR number', async () => {
  const paths = [];
  await withServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    paths.push({ method: req.method, pathname: url.pathname, query: url.searchParams });
    assert.equal(url.searchParams.has('pr'), false, 'PR number must not be a client API parameter');
    if (req.method === 'GET' && url.pathname === '/api/job') {
      assert.equal(url.searchParams.get('id'), '589');
      assert.equal(url.searchParams.get('repo'), 'lalalic/neox');
      return reply(res, fixture);
    }
    if (req.method === 'POST' && url.pathname === '/api/control') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const payload = JSON.parse(body);
      assert.equal(payload.command, 'job.update');
      assert.equal(payload.jobId, '589');
      assert.equal(payload.patch.objective, 'createdAt is required');
      assert.equal(Object.hasOwn(payload, 'prNumber'), false);
      return reply(res, { ...fixture, objective: payload.patch.objective });
    }
    if (req.method === 'POST' && url.pathname === '/api/job-state') {
      assert.equal(url.searchParams.get('id'), '589');
      assert.equal(url.searchParams.get('repo'), 'lalalic/neox');
      assert.equal(url.searchParams.get('state'), 'CANCELLED');
      return reply(res, { ...fixture, state: 'CANCELLED' });
    }
    throw Error(`Unexpected request ${req.method} ${req.url}`);
  }, async port => {
    const show = await cli(port, ['job', 'show', '--repo', 'lalalic/neox', '--id', '589']);
    assert.equal(show.id, '589');
    const update = await cli(port, ['job', 'update', '--repo', 'lalalic/neox', '--id', '589', '--objective', 'createdAt is required']);
    assert.equal(update.objective, 'createdAt is required');
    const cancel = await cli(port, ['job', 'cancel', '--repo', 'lalalic/neox', '--id', '589']);
    assert.equal(cancel.state, 'CANCELLED');
    assert.deepEqual(paths.map(x => x.pathname), ['/api/job', '/api/job', '/api/control', '/api/job', '/api/job-state']);
  });
});


test('CLI inventory includes more than dashboard 20 and cancelled Jobs', async () => {
  const jobs = Array.from({length: 35}, (_, index) => ({...fixture,
    id: String(600 + index), state: index % 3 === 0 ? 'CANCELLED' : 'ACTIVE',
    updatedAt: new Date(Date.UTC(2026, 10, 10, 12, 0, index)).toISOString(),
  }));
  const normal = searchDashboardJobs(jobs, new URLSearchParams());
  assert.equal(normal.jobs.length, 20);
  const inventory = listDashboardJobInventory(jobs, 'lalalic/neox');
  assert.equal(inventory.total, 35);
  assert.equal(inventory.jobs.length, 35);
  assert.equal(inventory.jobs.filter(x => x.state === 'CANCELLED').length, 12);
});

test('malformed legacy PR fails before any request is sent', async () => {
  for (const value of ['abc', '0', '-1', '1.5']) {
    await assert.rejects(() => relayControlJob(['--repo','lalalic/neox','--pr',value], '589'),
      /--pr must be a positive integer/);
  }
});
