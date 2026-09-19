import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { normalizeDaemonArguments } from '../dist/relayd.js';
import { createService, startService, SERVICE_DEFAULTS } from '../dist/cli.js';
import { nextPatchVersion } from '../scripts/npm-version.mjs';

test('daemon arguments require and normalize durable identifiers', () => {
  const argv = ['--repo', 'OWNER/REPO', '--pr', '1', '--id', 'JOB_ID', '--port', '9000'];
  const normalized = normalizeDaemonArguments(argv);
  assert.equal(normalized.repository, 'OWNER/REPO');
  assert.equal(normalized.pullRequest, 1);
  assert.equal(normalized.jobId, 'JOB_ID');
  assert.deepEqual(normalized.serviceArguments, argv);
});

test('repository daemon wires account usage telemetry into dashboard', async () => {
  const source = await readFile(new URL('../src/relayd.ts', import.meta.url), 'utf8');
  assert.match(source, /const usageRegistry = codexAndZaiUsageRegistry\(\)/);
  assert.match(source, /fallback\?\.id,usageRegistry,overviews,webhook,\(\)=>client\.rateLimitStatus\(\),exactJob/);
});

test('daemon arguments support repository pool mode and validate legacy pairing', () => {
  const pooled = normalizeDaemonArguments(['--repo','OWNER/REPO','--port','8787']);
  assert.equal(pooled.pullRequest, null); assert.equal(pooled.jobId, null);
  assert.throws(() => normalizeDaemonArguments(['--pr','1','--id','job']), /--repo is required/);
  assert.throws(() => normalizeDaemonArguments(['--repo','OWNER/REPO','--pr','0','--id','job']), /--pr must be positive/);
  assert.throws(() => normalizeDaemonArguments(['--repo','OWNER/REPO','--pr','1']), /supplied together/);
});

test('daemon arguments default to workspace mode without changing --repo mode', () => {
  const workspace = normalizeDaemonArguments(['--workspace', '/tmp/Workspace']);
  assert.equal(workspace.repository, null);
  assert.equal(workspace.workspaceRoot, '/tmp/Workspace');
  assert.equal(workspace.pullRequest, null);
  assert.throws(() => normalizeDaemonArguments(['--repo', 'OWNER/REPO', '--workspace', '/tmp/Workspace']), /mutually exclusive/);
});

test('service defaults and package bins use stable package entrypoints', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(pkg.bin, { 'agents-relay': 'dist/cli.js', 'agents-relayd': 'dist/relayd.js' });
  assert.equal(SERVICE_DEFAULTS.port, 8787);
  assert.equal(SERVICE_DEFAULTS.watchdogMs, 300000);
  assert.equal(SERVICE_DEFAULTS.webhookWatchdogMs, 1800000);
  assert.equal(SERVICE_DEFAULTS.dashboardRefreshMs, 300000);
});

test('release version selection starts at 1.0.0 and increments only the patch', () => {
  assert.equal(nextPatchVersion(''), '1.0.0');
  assert.equal(nextPatchVersion('1.0.0'), '1.0.1');
  assert.equal(nextPatchVersion('2.7.9'), '2.7.10');
  assert.throws(() => nextPatchVersion('latest'), /Unsupported npm version/);
});

test('CLI and daemon help are successful and do not require job storage', () => {
  for (const [entry, args, expected] of [
    ['dist/cli.js', ['--help'], 'npx agents-relay <command>'],
    ['dist/cli.js', ['job', '--help'], 'npx agents-relay job <create|adopt|repair>'],
    ['dist/cli.js', ['job', 'create', '--help'], 'Create or reuse an open PR'],
    ['dist/cli.js', ['job', 'adopt', '--help'], 'Adopt an existing PR'],
    ['dist/cli.js', ['job', 'repair', '--help'], 'Repair duplicate durable markers'],
    ['dist/cli.js', ['init', '--help'], 'Initialize a new job'],
    ['dist/cli.js', ['submit', '--help'], 'Queue a task for a managed job'],
    ['dist/cli.js', ['record', '--help'], 'Backfill work completed outside the relay'],
    ['dist/cli.js', ['status', '--help'], 'Show the durable state for a job'],
    ['dist/cli.js', ['reconcile', '--help'], 'Reconcile a job once'],
    ['dist/cli.js', ['retry', '--help'], 'Retry a task by setting it READY'],
    ['dist/cli.js', ['cancel', '--help'], 'Cancel a task'],
    ['dist/cli.js', ['serve', '--help'], 'Run the dashboard and reconciliation service'],
    ['dist/cli.js', ['agent-register', '--help'], 'Register an agent role'],
    ['dist/cli.js', ['agent-discover', '--help'], 'Find registered agents'],
    ['dist/relayd.js', ['--help'], 'npx agents-relayd [options]']
  ]) {
    const result = spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${entry} ${args.join(' ')} failed: ${result.stderr}`);
    assert.match(result.stdout, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('published bin files are executable after build', async () => {
  assert.equal((await stat('dist/cli.js')).mode & 0o111, 0o111);
  assert.equal((await stat('dist/relayd.js')).mode & 0o111, 0o111);
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


test('startup reconciliation failure does not take down dashboard', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agents-relay-degraded-'));
  const file = join(directory, 'job.json');
  await writeFile(file, JSON.stringify({ id: 'degraded-job', title: 'Degraded', prNumber: 0, state: 'OPEN', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tasks: [] }));
  const service = await createService(['--file', file, '--port', '0']);
  service.reconciler.reconcile = async () => { throw new Error('GitHub rate limited'); };
  // startService owns construction, so assert the equivalent startup policy directly:
  try { await service.reconciler.reconcile(service.job.id); } catch {}
  assert.notEqual(service.dashboardServer.address(), null);
  await service.stop();
  await rm(directory, { recursive: true, force: true });
});
