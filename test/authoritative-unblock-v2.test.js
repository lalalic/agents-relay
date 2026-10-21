import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { decideAuthoritativeUnblock } from '../dist/workflow/authoritative-unblock-v2.js';

test('Authoritative unblock queues only the blocked Troubleshooter', () => {
  const eligible=decideAuthoritativeUnblock(true);
  assert.equal(eligible.target,'troubleshooter_queued');
  assert.deepEqual(eligible.actions.map(action=>action.id),['unblock.retry']);

  const ordinary=decideAuthoritativeUnblock(false);
  assert.equal(ordinary.target,'blocked');
  assert.deepEqual(ordinary.actions,[]);
});
