import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { InMemoryStore } from '../dist/store.js';
import { requestTroubleshooterEscalation, resumeTroubleshooter } from '../dist/task-recovery.js';
import { unblockTask } from '../dist/unblock.js';

function fixture() {
  const now = new Date().toISOString();
  const original = { jobId: 'j', id: 'original', kind: 'work', agentName: 'implementation', state: 'FAILED', attempt: 2, maxAttempts: 3, executionId: 'original-exec', parentTaskId: null, dependencies: [], capabilities: [], adapter: 'codex', input: 'do work', output: { kind: 'task_pr' }, leaseOwner: null, leaseExpiresAt: null, threadId: null, result: null, error: 'needs approval', failureReason: 'semantic_failure', timeoutMs: 100, createdAt: now, updatedAt: now };
  const recovery = { jobId: 'j', id: 'troubleshoot-original', kind: 'work', agentName: 'troubleshooter', state: 'RUNNING', attempt: 1, maxAttempts: 3, executionId: 'recovery-exec', parentTaskId: 'original', dependencies: [], capabilities: ['troubleshoot'], adapter: 'codex', input: 'diagnose', output: { kind: 'task_pr' }, leaseOwner: 'relay', leaseExpiresAt: now, threadId: null, result: null, error: null, timeoutMs: 100, createdAt: now, updatedAt: now };
  return { id: 'j', title: 'recovery', repository: 'x/y', prNumber: 1, state: 'ACTIVE', executionMode: 'fixed', continuation: null, createdAt: now, updatedAt: now, tasks: [original, recovery] };
}

test('human escalation blocks and resumes the Troubleshooter, not the failed original', async () => {
  const store = new InMemoryStore(fixture());
  const blocked = await requestTroubleshooterEscalation(store, 'j', 'troubleshoot-original', {
    requiredAction: 'Approve the identity prompt', resolutionCondition: 'The authenticated session can complete the original review', context: 'The worker reached a real identity prompt after event-history diagnosis',
  }, '2026-10-16T12:00:00.000Z');
  assert.equal(blocked.task.state, 'BLOCKED');
  assert.equal(blocked.task.escalation?.status, 'pending');
  assert.equal(blocked.task.executionId, null);
  const afterBlock = await store.load('j');
  assert.equal(afterBlock.tasks.find(task => task.id === 'original')?.state, 'FAILED');
  assert.equal(afterBlock.tasks.find(task => task.id === 'original')?.executionId, 'original-exec');
  await assert.rejects(() => unblockTask({ store, job: afterBlock, task: afterBlock.tasks[0], trigger: { source: 'cli', reason: 'human said done' } }), /not an effective BLOCKED/);

  await assert.rejects(() => unblockTask({ store, job: afterBlock, task: afterBlock.tasks[1], trigger: { source: 'cli', reason: 'bypass escalation' } }), /requires an authorized human response/);

  const resumed = await resumeTroubleshooter(store, 'j', 'troubleshoot-original', 'Approved the prompt', '2026-10-16T12:05:00.000Z');
  assert.equal(resumed.task.state, 'QUEUED');
  assert.equal(resumed.task.escalation?.status, 'responded');
  assert.match(resumed.task.input, /Approved the prompt/);
  await assert.rejects(() => resumeTroubleshooter(store, 'j', 'troubleshoot-original', 'Duplicate response'), /already has a response/);
});

test('duplicate escalation is idempotent while the same generation waits', async () => {
  const store = new InMemoryStore(fixture());
  const request = { requiredAction: 'Approve', resolutionCondition: 'Approval is observable', context: 'Identity prompt' };
  const first = await requestTroubleshooterEscalation(store, 'j', 'troubleshoot-original', request);
  const second = await requestTroubleshooterEscalation(store, 'j', 'troubleshoot-original', request);
  assert.equal(second.duplicate, true);
  assert.equal(second.escalation.id, first.escalation.id);
});
