import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { runBlockerCommand } from '../dist/cli-blocker.js';

test('blocker ensure CLI passes the dependent Job and bounded request to Relay control', async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  let requestBody;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return { ok: true, json: async () => ({ blockerJobId: '700', planningRecoveryRequired: false }) };
  };
  console.log = () => {};
  try {
    await runBlockerCommand('ensure', [
      '--repo', 'owner/consumer', '--id', '589', '--dependent-task', '877',
      '--target-repo', 'owner/gateway', '--request-id', 'gateway-task-877-repair',
      '--reason', 'The dependent integration is blocked by a missing authorized gateway API.',
      '--title', 'Add the missing gateway API',
      '--objective', 'Implement the authorized gateway API in owner/gateway for dependent Task 877 from owner/consumer. Keep scope to the requested technical prerequisite.',
      '--resolution', 'verified', '--origin', 'troubleshooter', '--authorized',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
  assert.equal(requestBody.command, 'blocker.ensure');
  assert.equal(requestBody.jobId, '589');
  assert.deepEqual(requestBody.request, {
    requestId: 'gateway-task-877-repair', targetRepository: 'owner/gateway',
    dependentRepository: 'owner/consumer', dependentJobId: '589', dependentTaskId: '877',
    reason: 'The dependent integration is blocked by a missing authorized gateway API.',
    title: 'Add the missing gateway API',
    objective: 'Implement the authorized gateway API in owner/gateway for dependent Task 877 from owner/consumer. Keep scope to the requested technical prerequisite.',
    resolutionMode: 'verified', origin: 'troubleshooter', authorized: true,
  });
});

test('blocker ensure CLI rejects missing authorization and unsupported resolution modes', async () => {
  await assert.rejects(runBlockerCommand('ensure', [
    '--repo', 'owner/consumer', '--id', '589', '--dependent-task', '877',
    '--target-repo', 'owner/gateway', '--request-id', 'gateway-task-877-repair',
    '--reason', 'The dependent integration is blocked by a missing authorized gateway API.',
    '--title', 'Add the missing gateway API', '--objective', 'A sufficiently long stand-alone objective.',
  ]), /explicit --authorized/);
  await assert.rejects(runBlockerCommand('ensure', [
    '--repo', 'owner/consumer', '--id', '589', '--dependent-task', '877',
    '--target-repo', 'owner/gateway', '--request-id', 'gateway-task-877-repair',
    '--reason', 'The dependent integration is blocked by a missing authorized gateway API.',
    '--title', 'Add the missing gateway API', '--objective', 'A sufficiently long stand-alone objective.',
    '--authorized', '--resolution', 'anything',
  ]), /--resolution must be merge or verified/);
});
