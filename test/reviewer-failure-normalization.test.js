import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { decideReviewLifecycle } from '../dist/workflow/review-v2.js';
import { normalizeReviewerTerminalEvent } from '../dist/review-terminal-normalization.js';

const original = (verdict) => ({
  type: 'task.completed', job_id: '478', task_id: 'review',
  timestamp: '2026-10-16T17:00:00Z', message: 'missing build dependencies',
  data: { verdict, head_sha: 'abcdef', findings: [{ description: 'tsc unavailable' }] },
});

test('legacy blocked Reviewer outcome becomes failed execution for Troubleshooter', () => {
  const event = normalizeReviewerTerminalEvent(original('blocked'));
  assert.equal(event.type, 'task.failed');
  assert.equal(event.data.reason, 'review_evidence_unavailable');
  assert.equal(event.data.verdict, 'blocked');
  assert.deepEqual(event.data.findings, [{ description: 'tsc unavailable' }]);
});

test('actual review findings keep successful review lifecycle', () => {
  assert.equal(normalizeReviewerTerminalEvent(original('changes-required')).type, 'review.changes_required');
  assert.equal(normalizeReviewerTerminalEvent(original('approved')).type, 'review.approved');
});

test('legacy review retry requires authoritative unblock', () => {
  assert.equal(decideReviewLifecycle('blocked', 'review.retry', {reviewUnblocked:true}).target, 'PENDING');
  assert.equal(decideReviewLifecycle('blocked', 'review.retry', {reviewUnblocked:false}).target, 'BLOCKED');
});
