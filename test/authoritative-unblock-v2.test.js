import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { decideAuthoritativeUnblock } from '../dist/workflow/authoritative-unblock-v2.js';

test('Authoritative unblock v2 graph chooses replan vs fixed retry', () => {
  const autonomous=decideAuthoritativeUnblock(true);
  assert.equal(autonomous.target,'autonomous_replan');
  assert.deepEqual(autonomous.actions.map(action=>action.id),['unblock.replan']);

  const fixed=decideAuthoritativeUnblock(false);
  assert.equal(fixed.target,'fixed_retry');
  assert.deepEqual(fixed.actions.map(action=>action.id),['unblock.retry']);
});
