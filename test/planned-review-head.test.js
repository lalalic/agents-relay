import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { bindPlannedReviewHead } from '../dist/planned-review-head.js';

test('dependent planner review freezes the current local source SHA at execution', async () => {
  const task = { id: 'review-e2e', reviewHeadSha: 'stale-planning-head', input: 'Review the artifact.' };
  const saved = [];
  const store = {
    async pullRequestHead() { throw new Error('remote PR head is audit-only'); },
    async saveTask(value) { saved.push({ ...value }); },
  };
  await bindPlannedReviewHead(store, task, 'new-implementation-head');
  assert.equal(task.reviewHeadSha, 'new-implementation-head');
  assert.deepEqual(saved.map(value => value.reviewHeadSha), ['new-implementation-head']);
  assert.match(task.input, /Do not require a remote PR MERGED/);
  assert.match(task.input, /pre-existing local baseline\/seed files/);
  await bindPlannedReviewHead(store, task, 'new-implementation-head');
  assert.equal((task.input.match(/Do not require a remote PR MERGED/g) || []).length, 1);
});

test('dependent review cannot run without the local source SHA', async () => {
  const task = { id: 'review-e2e', reviewHeadSha: 'stale-planning-head', input: 'Review the artifact.' };
  await assert.rejects(bindPlannedReviewHead({ async saveTask() {} }, task, null), /current local Git head SHA/);
  assert.equal(task.reviewHeadSha, 'stale-planning-head');
});
