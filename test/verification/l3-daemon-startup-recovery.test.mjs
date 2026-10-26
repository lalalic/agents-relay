import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { SQLiteRelayStore, relayUnifiedStorePath } from '../../dist/relay-store.js';
import { createIsolatedEnvironment } from './harness.mjs';

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function natsMatches(pattern, subject) {
  const expected = pattern.split('.');
  const actual = subject.split('.');
  for (let index = 0; index < expected.length; index += 1) {
    if (expected[index] === '>') return index < actual.length;
    if (index >= actual.length || (expected[index] !== '*' && expected[index] !== actual[index])) return false;
  }
  return expected.length === actual.length;
}

async function startTestNatsServer() {
  const subscriptions = new Map();
  const server = createServer(socket => {
    let buffer = Buffer.alloc(0);
    let pendingPublish;
    const clientSubscriptions = new Set();
    socket.write('INFO {"server_id":"L3TEST","version":"2.10.0","proto":1,"host":"127.0.0.1","port":4222,"max_payload":1048576,"auth_required":false,"tls_required":false,"headers":true}\r\n');
    socket.on('close', () => { for (const sid of clientSubscriptions) subscriptions.delete(sid); });
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        if (pendingPublish) {
          if (buffer.length < pendingPublish.size + 2) return;
          const payload = buffer.subarray(0, pendingPublish.size);
          buffer = buffer.subarray(pendingPublish.size + 2);
          for (const [sid, target] of subscriptions) {
            if (!natsMatches(target.pattern, pendingPublish.subject)) continue;
            target.socket.write(`MSG ${pendingPublish.subject} ${sid} ${payload.length}\r\n`);
            target.socket.write(payload);
            target.socket.write('\r\n');
          }
          pendingPublish = undefined;
          continue;
        }
        const newline = buffer.indexOf('\r\n');
        if (newline < 0) return;
        const line = buffer.subarray(0, newline).toString();
        buffer = buffer.subarray(newline + 2);
        if (line === 'PING') socket.write('PONG\r\n');
        else if (line.startsWith('SUB ')) {
          const [, pattern, sid] = line.split(' ');
          subscriptions.set(sid, { pattern, socket });
          clientSubscriptions.add(sid);
        } else if (line.startsWith('UNSUB ')) {
          const sid = line.split(' ')[1];
          subscriptions.delete(sid);
          clientSubscriptions.delete(sid);
        } else if (line.startsWith('PUB ')) {
          const fields = line.split(' ');
          pendingPublish = { subject: fields[1], size: Number(fields.at(-1)) };
        }
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { port: server.address().port, close: () => new Promise(resolve => server.close(resolve)) };
}

async function waitFor(check, description, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

test('real daemon restart fences parent-shutdown and claims the same Troubleshooter before original work', async () => {
  const env = createIsolatedEnvironment('relay-l3-daemon-recovery-');
  const jobId = 'job473-startup-recovery';
  const now = new Date().toISOString();
  const sqlite = new SQLiteRelayStore(relayUnifiedStorePath(env.storeDir), jobId);
  const workerRoot = join(env.root, 'worker');
  mkdirSync(workerRoot);
  execFileSync('git', ['init', '-b', 'main', env.root], { stdio: 'ignore' });
  execFileSync('git', ['-C', env.root, 'config', 'user.name', 'L3 Test'], { stdio: 'ignore' });
  execFileSync('git', ['-C', env.root, 'config', 'user.email', 'l3@example.invalid'], { stdio: 'ignore' });
  writeFileSync(join(env.root, 'base.txt'), 'base\n');
  execFileSync('git', ['-C', env.root, 'add', 'base.txt'], { stdio: 'ignore' });
  execFileSync('git', ['-C', env.root, 'commit', '-m', 'base'], { stdio: 'ignore' });
  const launchLog = join(env.root, 'worker-launches.log');
  const fakeCodex = join(workerRoot, 'codex');
  writeFileSync(fakeCodex, '#!/bin/sh\nprintf "%s\\n" "$PPID" >> "$RELAY_TEST_LAUNCH_LOG"\ntrap \'exit 0\' TERM INT\nwhile :; do sleep 1 & wait $!; done\n');
  chmodSync(fakeCodex, 0o755);
  const task = (id, state, extra = {}) => ({ jobId, id, kind: 'work', agentName: 'implementation', adapter: 'codex',
    input: id, output: { kind: 'file', path: 'result.txt' }, parentTaskId: null, dependencies: [], capabilities: ['model'],
    workerRequirements: { runtime: 'codex', capabilities: ['model'] }, state, attempt: 1, maxAttempts: 3, leaseOwner: null,
    leaseExpiresAt: null, executionId: null, executionHistory: [], threadId: null, result: null, plannerResult: null,
    error: null, timeoutMs: 900000, createdAt: now, updatedAt: now, continuation: null,
    continuationDeliveredAt: null, ...extra });
  const original = task('implementation-134', 'FAILED', { error: 'implementation failed before diagnosis' });
  const recovery = task('troubleshoot-134', 'QUEUED', { agentName: 'troubleshooter', parentTaskId: original.id });
  const job = { id: jobId, title: 'Job 473', objective: 'Diagnose failed implementation', repository: 'local/isolated',
    prNumber: 0, state: 'ACTIVE', autoMerge: false, reviewEnabled: false,
    createdAt: now, updatedAt: now, tasks: [original, recovery] };
  let daemon;
  let daemonPid;
  let nats;
  let daemonLog = '';
  const stopDaemon = async processHandle => {
    if (!processHandle || processHandle.exitCode !== null || processHandle.signalCode !== null) return;
    processHandle.kill('SIGTERM');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Daemon did not stop')), 12000);
      processHandle.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  };
  try {
    await sqlite.saveJob(job);
    const port = await freePort();
    nats = await startTestNatsServer();
    const daemonPath = join(process.cwd(), 'dist', 'relayd-main.js');
    const startDaemon = async () => {
      daemonLog = '';
      const processHandle = spawn(process.execPath, [daemonPath, '--no-github', '--events', 'nats', '--nats-url', `nats://127.0.0.1:${nats.port}`, '--project-path', env.root,
        '--port', String(port), '--concurrency', '1', '--interval', '600000', '--codex', fakeCodex], {
        cwd: env.root, env: { ...env.env, RELAY_TEST_LAUNCH_LOG: launchLog }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      processHandle.stdout.on('data', chunk => { daemonLog += chunk.toString(); });
      processHandle.stderr.on('data', chunk => { daemonLog += chunk.toString(); });
      await waitFor(() => daemonLog.includes('Dashboard listening'), 'daemon listening', 20000).catch(error => {
        throw new Error(`${error.message}; daemon output: ${daemonLog}`);
      });
      return processHandle;
    };
    daemon = await startDaemon();
    const first = await waitFor(async () => {
      if (!existsSync(launchLog)) return null;
      const lines = readFileSync(launchLog, 'utf8').trim().split(/\r?\n/).filter(Boolean);
      const current = await sqlite.loadJob(jobId);
      const currentRecovery = current.tasks.find(item => item.id === recovery.id);
      return lines.length === 1 && currentRecovery.executionId ? { lines, currentRecovery } : null;
    }, `initial daemon claim of ${recovery.id}`);
    const firstExecutionId = first.currentRecovery.executionId;
    const firstDaemonPid = daemon.pid;
    await stopDaemon(daemon);
    daemon = undefined;
    daemonPid = firstDaemonPid;
    const parentShutdownTask = (await sqlite.loadJob(jobId)).tasks.find(item => item.id === recovery.id);
    assert.equal(parentShutdownTask.id, recovery.id);
    assert.equal(parentShutdownTask.executionId, firstExecutionId);

    daemon = await startDaemon();
    const restarted = await waitFor(async () => {
      const lines = readFileSync(launchLog, 'utf8').trim().split(/\r?\n/).filter(Boolean);
      const current = await sqlite.loadJob(jobId);
      const currentRecovery = current.tasks.find(item => item.id === recovery.id);
      return lines.includes(String(daemon.pid)) && currentRecovery.executionId && currentRecovery.executionId !== firstExecutionId
        ? { lines, current }
        : null;
    }, `restarted daemon to claim ${recovery.id}`, 20000).catch(error => {
      throw new Error(`${error.message}; daemon output: ${daemonLog}`);
    });
    const current = await sqlite.loadJob(jobId);
    const currentRecovery = current.tasks.find(item => item.id === recovery.id);
    assert.equal(currentRecovery.id, recovery.id);
    assert.notEqual(currentRecovery.executionId, firstExecutionId);
    assert.ok(currentRecovery.attempt <= currentRecovery.maxAttempts);
    assert.equal(currentRecovery.leaseOwner, `relayd-${daemon.pid}`);
    assert.notEqual(currentRecovery.leaseOwner, `relayd-${daemonPid}`);
    assert.equal(current.tasks.find(item => item.id === original.id).state, 'FAILED');
    assert.equal(current.tasks.find(item => item.id === original.id).attempt, 1);
    assert.ok(restarted.lines.includes(String(daemon.pid)));
  } finally {
    await stopDaemon(daemon).catch(() => {});
    await nats?.close();
    sqlite.close();
    env.cleanup();
  }
});
