import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { recordTaskBlocked, requestTaskUnblock } from '../dist/unblock.js';

const job = { id: 'j', title: 'job', repository: 'org/repo', prNumber: 1, executionMode: 'autonomous', state: 'ACTIVE', continuation: null, headSha: 'c7bd3d6', createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z', tasks: [] };
const task = (state = 'BLOCKED') => ({ jobId: 'j', id: 'work', kind: 'work', parentTaskId: null, dependencies: [], capabilities: [], adapter: 'codex', input: 'work', output: { kind: 'task_pr' }, state, attempt: 2, maxAttempts: 3, leaseOwner: null, leaseExpiresAt: null, executionId: null, threadId: null, result: null, error: 'waiting', timeoutMs: 300000, createdAt: job.createdAt, updatedAt: job.updatedAt });

test('unblock records a stable blocked baseline and one change cycle without retrying', () => {
  const work = task();
  recordTaskBlocked(work, job, '2026-09-29T01:00:00.000Z');
  assert.deepEqual(work.blockState?.baseline, { attempt: 2, headSha: 'c7bd3d6' });
  const first = requestTaskUnblock(work, job, 'human', 'fresh media available', '2026-09-29T02:00:00.000Z');
  const second = requestTaskUnblock(work, job, 'human', 'duplicate', '2026-09-29T03:00:00.000Z');
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(work.state, 'BLOCKED');
  assert.equal(work.blockState?.changeFacts.length, 1);
});

test('failed tasks cannot be unblocked', () => assert.throws(() => requestTaskUnblock(task('FAILED'), job, 'human', undefined, '2026-09-29T02:00:00.000Z'), /only BLOCKED/));
