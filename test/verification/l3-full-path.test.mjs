import test from 'node:test';
import assert from 'node:assert/strict';
import { runFullPath } from './l3-simulator.mjs';

test('full production path completes through worker, review, scheduler and mocked local merge', async () => {
  const result = await runFullPath({ id: 'full-happy-path', expected: { jobState: 'COMPLETED', mergeStatus: 'succeeded' } });
  assert.equal(result.outcome, 'PASS', JSON.stringify({ errors: result.errors, actual: result.actual }));
  assert.equal(result.actual.jobState, 'COMPLETED');
  assert.equal(result.mergeReceipts.length, 1);
});

test('changes-required creates a real fix/re-review path on a new head', async () => {
  const result = await runFullPath({ id: 'review-revision-rereview', reviewVerdicts: { '*': ['changes-required', 'approved'] }, steps: [{ type: 'advance-head', headSha: 'head-2' }], expected: { jobState: 'COMPLETED', mergeStatus: 'succeeded' } });
  assert.equal(result.outcome, 'PASS', JSON.stringify({ errors: result.errors, actual: result.actual }));
  assert.ok(result.trace.some(step => step.tasks.some(item => item.id.startsWith('review-fix-'))));
  assert.ok(result.trace.some(step => step.headSha === 'head-2'));
});

test('parallel dependency release and restart retain SQLite authority', async () => {
  const result = await runFullPath({ id: 'parallel-restart', reviewEnabled: false, tasks: [{ id: 'a' }, { id: 'b', dependencies: ['a'] }, { id: 'c', dependencies: ['a'] }], steps: [{ type: 'restart' }], expected: { jobState: 'COMPLETED', mergeStatus: 'succeeded' } });
  assert.equal(result.outcome, 'PASS', JSON.stringify({ errors: result.errors, actual: result.actual }));
  const final = result.trace.at(-1);
  assert.equal(final.tasks.find(item => item.id === 'b')?.state, 'SUCCEEDED');
  assert.equal(final.tasks.find(item => item.id === 'c')?.state, 'SUCCEEDED');
});

test('merge failure is durable and includes a reason receipt', async () => {
  const result = await runFullPath({ id: 'merge-failure-reason', mergeOutcomes: ['failed'], persistMergeFailure: true, mergeFailureReason: 'dirty_target_worktree', expected: { jobState: 'ACTIVE', mergeStatus: 'failed' } });
  assert.equal(result.outcome, 'PASS', JSON.stringify({ errors: result.errors, actual: result.actual }));
  assert.match(result.actual.localMerge.error, /dirty_target_worktree/);
});

test('worker fault produces durable FAILED and troubleshooter without releasing dependent task', async () => {
  const result = await runFullPath({ id: 'worker-failure-dispatch', reviewEnabled: false, workerOutcomes: { a: ['failed'] }, expected: { jobState: 'ACTIVE', tasks: { a: 'FAILED', b: 'DRAFT', 'troubleshoot-a': 'SUCCEEDED' } } });
  assert.equal(result.outcome, 'PASS', JSON.stringify({ errors: result.errors, actual: result.actual }));
  assert.ok(result.events.some(event => event.type === 'troubleshooter.created' && event.taskId === 'troubleshoot-a'));
});

test('reviewer fault remains failure despite troubleshooter execution completion', async () => {
  const result = await runFullPath({ id: 'reviewer-failure-dispatch', reviewVerdicts: { '*': ['failed'] }, expected: { jobState: 'ACTIVE', tasks: { 'final-review-head-1': 'FAILED', 'troubleshoot-final-review-head-1': 'SUCCEEDED' } } });
  assert.equal(result.outcome, 'PASS', JSON.stringify({ errors: result.errors, actual: result.actual }));
  assert.equal(result.actual.localMerge.status, 'pending');
});

test('deliberately false SQLite terminal claim must fail', async () => {
  const result = await runFullPath({ id: 'broken-expected-active', reviewEnabled: false, expected: { jobState: 'ACTIVE' } });
  assert.equal(result.outcome, 'FAIL');
  assert.equal(result.actual.jobState, 'COMPLETED');
  assert.match(result.errors.join('; '), /job expected ACTIVE/);
});
