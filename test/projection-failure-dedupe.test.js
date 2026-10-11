import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { ProjectionFailureDeduplicator } from '../dist/projection-failure-dedupe.js';

test('terminal projection error is reported once per job state and error, without blocking retries', () => {
  const tracker = new ProjectionFailureDeduplicator();
  assert.equal(tracker.shouldReport('one','v1','missing ref','terminal'),true);
  assert.equal(tracker.shouldReport('one','v1','missing ref','terminal'),false);
  assert.equal(tracker.shouldReport('two','v1','missing ref','terminal'),true);
  assert.equal(tracker.shouldReport('one','v2','missing ref','terminal'),true);
  assert.equal(tracker.shouldReport('one','v2','new error','terminal'),true);
  assert.equal(tracker.shouldReport('one','v2','new error','transient'),true);
  assert.equal(tracker.shouldReport('one','v2','new error','terminal'),true);
});
