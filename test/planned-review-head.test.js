import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { bindPlannedReviewHead } from '../dist/planned-review-head.js';

test('dependent planner review freezes the latest PR head at execution time', async () => {
  const task = { id: 'review-e2e', reviewHeadSha: 'stale-planning-head' };
  const saved = [];
  const store = {
    async pullRequestHead() { return { sha: 'new-implementation-head' }; },
    async saveTask(value) { saved.push({ ...value }); },
  };
  await bindPlannedReviewHead(store, task);
  assert.equal(task.reviewHeadSha, 'new-implementation-head');
  assert.deepEqual(saved.map(value => value.reviewHeadSha), ['new-implementation-head']);
});

test('dependent review cannot run without a current PR head', async () => {
  const task = { id: 'review-e2e', reviewHeadSha: 'stale-planning-head' };
  await assert.rejects(bindPlannedReviewHead({ async pullRequestHead() { return null; } }, task), /current PR head SHA/);
  assert.equal(task.reviewHeadSha, 'stale-planning-head');
});
