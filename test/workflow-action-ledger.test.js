import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { WorkflowActionLedger } from '../dist/workflow/action-ledger.js';
import { ConditionRegistry, booleanCondition } from '../dist/workflow/conditions.js';
const identity = { attemptKey: 'job1/task2/exec3/g4/merge', executionId: 'exec3', generation: 4, graph: 'job-lifecycle.mmd', actionId: 'effect.mergePullRequest' };
const authorized = { accepted: true, source: 'ACTIVE', target: 'COMPLETED', actions: [{ id: identity.actionId, input: {transport:'event',id:'reconcile',payload:{}}, emittedEvents:[] }] };
test('SQLite ledger fences duplicate action and preserves unknown until externally verified', () => {
  const ledger = new WorkflowActionLedger(new DatabaseSync(':memory:'));
  const conditions = new ConditionRegistry([booleanCondition('merged')]);
  assert.equal(ledger.reserve(identity, authorized, 'merged'), true);
  assert.equal(ledger.reserve(identity, authorized, 'merged'), false);
  assert.equal(ledger.verify(identity.attemptKey, conditions, {}).outcome, 'Unknown');
  assert.equal(ledger.reserve(identity, authorized, 'merged'), false);
  assert.equal(ledger.verify(identity.attemptKey, conditions, {merged:true}).outcome, 'Verified');
  assert.equal(ledger.verify(identity.attemptKey, conditions, {merged:false}).outcome, 'Verified');
});
test('action without matching graph decision cannot reserve side effect', () => {
  const ledger = new WorkflowActionLedger(new DatabaseSync(':memory:'));
  assert.throws(() => ledger.reserve(identity, {accepted:false,source:'ACTIVE',reason:'no_transition'}, 'merged'), /not authorized/);
});
