import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { normalizeDaemonArguments } from '../dist/relayd.js';
import { createService, SERVICE_DEFAULTS } from '../dist/cli.js';

test('daemon arguments require and normalize durable identifiers', () => {
  const argv = ['--repo', 'OWNER/REPO', '--pr', '1', '--id', 'JOB_ID', '--port', '9000'];
  const normalized = normalizeDaemonArguments(argv);
  assert.equal(normalized.repository, 'OWNER/REPO');
  assert.equal(normalized.pullRequest, 1);
  assert.equal(normalized.jobId, 'JOB_ID');
  assert.deepEqual(normalized.serviceArguments, argv);
});

test('daemon argument validation rejects incomplete identifiers', () => {
  assert.throws(() => normalizeDaemonArguments(['--pr', '1', '--id', 'job']), /--repo is required/);
  assert.throws(() => normalizeDaemonArguments(['--repo', 'OWNER/REPO', '--pr', '0', '--id', 'job']), /--pr is required/);
  assert.throws(() => normalizeDaemonArguments(['--repo', 'OWNER/REPO', '--pr', '1']), /--id is required/);
});

test('service defaults and package bins use stable package entrypoints', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(pkg.bin, { 'agents-relay': 'dist/cli.js', 'agents-relayd': 'dist/relayd.js' });
  assert.equal(SERVICE_DEFAULTS.port, 8787);
  assert.equal(SERVICE_DEFAULTS.watchdogMs, 60000);
  assert.equal(SERVICE_DEFAULTS.dashboardRefreshMs, 15000);
});

test('service stop clears watchdog and closes dashboard before resolving', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agents-relay-service-'));
  const file = join(directory, 'job.json');
  await writeFile(file, JSON.stringify({ id: 'cleanup-job', tasks: [] }));
  const service = await createService(['--file', file, '--port', '0', '--interval', '60000', '--refresh-ms', '15000']);
  await service.stop();
  assert.equal(service.dashboardServer.address(), null);
  assert.equal(service.watchdogCleared, true);
  await rm(directory, { recursive: true, force: true });
});
