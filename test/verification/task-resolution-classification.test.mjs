import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTaskResolution } from '../../dist/workflow/task-resolution.js';

const task = overrides => ({ id: 'failed', jobId: 'job', kind: 'work', state: 'FAILED', failureReason: 'task_failure', dependencies: [], updatedAt: '2026-01-01T00:00:00.000Z', ...overrides });

test('Task Resolution Graph classifies history without changing lifecycle and requires evidence', () => {
  const failed = task({});
  const classification = classifyTaskResolution(failed, { kind: 'superseded', targetTaskId: 'replacement', evidence: 'replacement implements the same acceptance criteria', reason: 'the old attempt is no longer the active artifact' });
  assert.equal(failed.state, 'FAILED');
  assert.equal(classification.kind, 'superseded');
  assert.equal(classification.targetTaskId, 'replacement');
  assert.ok(classification.updatedAt);
  assert.throws(() => classifyTaskResolution(task({ failureReason: 'worker_outcome_unknown' }), { kind: 'invalid', targetTaskId: 'replacement', evidence: 'claimed complete', reason: 'unknown execution' }), /rejected/);
  assert.throws(() => classifyTaskResolution(task({ executionId: 'still-running' }), { kind: 'invalid', targetTaskId: 'replacement', evidence: 'x', reason: 'y' }), /rejected/);
  assert.throws(() => classifyTaskResolution(task({}), { kind: 'invalid', targetTaskId: '', evidence: '', reason: '' }), /rejected/);
});
