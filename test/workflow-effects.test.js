import test from './test-runtime.js';
import assert from 'node:assert/strict';
import {
  WORKFLOW_EFFECT_POLICIES,
  classifyWorkflowActions,
  workflowEffectFailureEvent,
} from '../dist/workflow/contracts.js';
import {
  CallbackWorkflowEffectHandler,
  MemoryWorkflowEffectReceiptStore,
  WorkflowEffectExecutor,
} from '../dist/workflow/effects.js';
import {
  decideJobLifecycle,
  decideTaskLifecycle,
} from '../dist/workflow/lifecycle.js';
import { transitionTaskEvent } from '../dist/task-transitions.js';

test('graph decision separates deterministic mutations from declarative effects', () => {
    const dispatch = decideTaskLifecycle(
      { jobId: 'j1', id: 't1', state: 'QUEUED' },
      'dispatch',
      { dispatchable: true },
    );
    assert.equal(dispatch.target, 'QUEUED');
    assert.deepEqual(dispatch.mutations, []);
    assert.deepEqual(dispatch.effects, ['effect.launchTask']);

    const closed = decideJobLifecycle(
      { id: 'j1', state: 'ACTIVE' },
      'cancel',
      {},
    );
    assert.equal(closed.target, 'CANCELLED');
    assert.deepEqual(closed.effects, ['effect.cancelActiveTasks']);
});

test('workflow mutation registry owns healthy-state cleanup', async () => {
    const task = {
      id: 't1',
      state: 'FAILED',
      error: 'watchdog timeout',
      failureReason: 'watchdog_timeout',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const decision = await transitionTaskEvent(task, 'retry');
    assert.equal(task.state, 'QUEUED');
    assert.equal(task.error, null);
    assert.equal(task.failureReason, undefined);
    assert.deepEqual(decision.mutations, ['mutation.clearError', 'mutation.clearFailureReason']);
});

test('effect executor deduplicates by handler idempotency key', async () => {
  let executions = 0;
  const executor = new WorkflowEffectExecutor(
    [new CallbackWorkflowEffectHandler('effect.launchTask', async () => { executions += 1; })],
    new MemoryWorkflowEffectReceiptStore(),
  );
  const context = { jobId: 'j1', taskId: 't1', transitionKey: 'dispatch:1', data: { attempt: 1 } };
  const first = await executor.execute(['effect.launchTask'], context);
  const second = await executor.execute(['effect.launchTask'], context);
  assert.equal(executions, 1);
  assert.equal(first[0].status, 'completed');
  assert.equal(second[0].status, 'deduplicated');
});

test('effect failures map back to canonical workflow events', async () => {
  const executor = new WorkflowEffectExecutor([
    new CallbackWorkflowEffectHandler('effect.deliverLocalMerge', async () => {
      throw new Error('local Git merge unavailable');
    }),
  ]);
  const outcomes = await executor.execute(
    ['effect.deliverLocalMerge'],
    { jobId: 'j1', transitionKey: 'local.merge.requested:abc', data: { sourceSha: 'abc' } },
  );
  assert.equal(outcomes[0].status, 'failed');
  assert.equal(workflowEffectFailureEvent(outcomes[0].effect), 'effect.deliverLocalMerge.failed');

    const feedback = decideJobLifecycle(
      { id: 'j1', state: 'ACTIVE' },
      'effect.deliverLocalMerge.failed',
    );
    assert.equal(feedback.accepted, true);
    assert.equal(feedback.target, 'ACTIVE');
});

test('canonical action classifier rejects undeclared next actions', () => {
  assert.throws(() => classifyWorkflowActions(['effect.notRegistered']), /Unknown canonical workflow action/);
  assert.equal(WORKFLOW_EFFECT_POLICIES['effect.launchTask'].retry, 'workflow');
  assert.equal(WORKFLOW_EFFECT_POLICIES['effect.deliverLocalMerge'].idempotency, 'job-local-source-sha');
});
