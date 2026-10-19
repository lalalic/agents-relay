import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConditionRegistry, booleanCondition, verifyActionEffect, safeRetryAllowed } from '../dist/workflow/conditions.js';
import { lifecycleConditions } from '../dist/workflow/definitions-v2.js';
test('shared guard/postcondition uses tri-state condition without mutations', () => {
  const registry = new ConditionRegistry([booleanCondition('committed')]);
  const facts = Object.freeze({ committed: true });
  assert.equal(registry.guard('committed')({ durableFacts: facts }), true);
  assert.deepEqual(verifyActionEffect(registry, 'merge', 'committed', facts), { actionId: 'merge', conditionId: 'committed', outcome: 'Verified' });
  assert.equal(registry.evaluate('committed', { committed: false }), 'Failed');
  assert.equal(registry.evaluate('committed', {}), 'Unknown');
  assert.equal(registry.guard('committed')({ durableFacts: {} }), false);
  assert.equal(safeRetryAllowed('Unknown'), false);
  assert.equal(safeRetryAllowed('Verified'), false);
  assert.equal(safeRetryAllowed('Failed'), true);
});
test('registry rejects duplicates and graph guards resolve against shared registry', () => {
  assert.throws(() => new ConditionRegistry([booleanCondition('x'), booleanCondition('x')]), /duplicate/);
  assert.ok(lifecycleConditions.discover().includes('platformFallbackSafe'));
  assert.equal(lifecycleConditions.evaluate('platformFallbackSafe', {}), 'Unknown');
});
