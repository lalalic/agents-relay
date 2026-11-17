import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { projectionConflictV2 } from '../dist/workflow/projection-conflict-v2.js';
import { dispatchWorkflowGraph } from '../dist/workflow/dispatcher.js';

const decide = (state, id, durableFacts = {}) => dispatchWorkflowGraph(projectionConflictV2, {
  initialState: state, input: { transport: 'event', id, payload: {} }, durableFacts,
  graphName: 'projection-conflict',
});

test('completed local Git delivery graph skips unusable origins and never reopens Job lifecycle', async () => {
  const skipped = await decide('classify', 'job.completed', { jobState: 'COMPLETED', originUsable: false });
  assert.equal(skipped.target, 'skipped');
  assert.deepEqual(skipped.actions.map(action => action.id), ['delivery.skip']);

  const graph = await readFile(new URL('../workflow/projection-conflict.mmd', import.meta.url), 'utf8');
  assert.match(graph, /authority: SQLite delivery state and completed Job snapshot/);
  assert.doesNotMatch(graph, /createRecoveryTask|projection\.escalate|reopen|task\.create/i);
});

test('completed local Git delivery graph selects inspection, skip-if-current, or safe push', async () => {
  const inspect = await decide('classify', 'job.completed', { originUsable: true });
  assert.equal(inspect.target, 'inspect');

  const alreadyCurrent = await decide('inspect', 'inspect.completed', { remoteContainsMain: true });
  assert.equal(alreadyCurrent.target, 'delivered');
  assert.deepEqual(alreadyCurrent.actions.map(action => action.id), ['delivery.recordDelivered']);

  const needsPush = await decide('inspect', 'inspect.completed', { remoteContainsMain: false });
  assert.equal(needsPush.target, 'push');
  assert.deepEqual(needsPush.actions.map(action => action.id), ['delivery.pushMain']);
});

test('delivery failure selects bounded retry or exhausted record without recovery Tasks', async () => {
  const retry = await decide('push', 'delivery.failed', { attempts: 1, maxAttempts: 3 });
  assert.equal(retry.target, 'waiting');
  assert.deepEqual(retry.actions.map(action => action.id), ['delivery.scheduleRetry']);

  const exhausted = await decide('push', 'delivery.failed', { attempts: 3, maxAttempts: 3 });
  assert.equal(exhausted.target, 'exhausted');
  assert.deepEqual(exhausted.actions.map(action => action.id), ['delivery.recordExhausted']);

  const notDue = await decide('waiting', 'delivery.retry_due', { retryDue: false });
  assert.equal(notDue.accepted, true);
  assert.equal(notDue.target, 'waiting');
  assert.deepEqual(notDue.actions, []);
});
