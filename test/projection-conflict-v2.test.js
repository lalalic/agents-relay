import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { decideProjectionFailure, projectionConflictV2 } from '../dist/workflow/projection-conflict-v2.js';
import { dispatchWorkflowGraph } from '../dist/workflow/dispatcher.js';

test('Projection Conflict v2 graph owns deterministic-conflict disposition', () => {
  const deterministic = decideProjectionFailure({ deterministicDefinitionConflict: true });
  assert.equal(deterministic.accepted, true);
  assert.equal(deterministic.target, 'conflict');
  assert.deepEqual(deterministic.actions, []);

  const transient = decideProjectionFailure({ deterministicDefinitionConflict: false });
  assert.equal(transient.accepted, true);
  assert.equal(transient.target, 'retry');
});

test('Projection Conflict v2 graph is the single authority for conflict vs retry', () => {
  // Missing fact is not deterministic: absent evidence never classifies a conflict.
  assert.equal(decideProjectionFailure({}).target, 'retry');
});

test('projection recovery graph gates task creation, reviewed projection, and escalation', async () => {
  const created = await dispatchWorkflowGraph(projectionConflictV2, {
    initialState: 'classify', input: { transport: 'event', id: 'projection.delivery_failed', payload: {} },
    durableFacts: { jobState: 'COMPLETED', mergeSucceeded: true, projectionStrategy: 'target_ref_push',
      divergenceConfirmed: true, remoteShaAvailable: true, attempts: 0, maxAttempts: 2 }, graphName: 'projection-conflict',
  });
  assert.deepEqual(created.actions.map(action => action.id), ['projection.createRecoveryTask']);

  const activeRecovery = await dispatchWorkflowGraph(projectionConflictV2, {
    initialState: 'classify', input: { transport: 'event', id: 'projection.delivery_failed', payload: {} },
    durableFacts: { jobState: 'COMPLETED', mergeSucceeded: true, projectionStrategy: 'target_ref_push',
      divergenceConfirmed: true, remoteShaAvailable: true, recoveryInProgress: true, attempts: 0, maxAttempts: 2 }, graphName: 'projection-conflict',
  });
  assert.equal(activeRecovery.accepted, true);
  assert.deepEqual(activeRecovery.actions, []);

  const reviewed = await dispatchWorkflowGraph(projectionConflictV2, {
    initialState: 'repairing', input: { transport: 'event', id: 'reconcile', payload: {} },
    durableFacts: { repairTaskState: 'SUCCEEDED', reviewOutcome: 'approved', taskRetryAvailable: true, attempts: 1, maxAttempts: 2 }, graphName: 'projection-conflict',
  });
  assert.deepEqual(reviewed.actions.map(action => action.id), ['effect.projectLocalMerge']);

  const exhausted = await dispatchWorkflowGraph(projectionConflictV2, {
    initialState: 'repairing', input: { transport: 'event', id: 'reconcile', payload: {} },
    durableFacts: { repairTaskState: 'SUCCEEDED', reviewOutcome: 'approved', taskRetryAvailable: true, attempts: 2, maxAttempts: 2 }, graphName: 'projection-conflict',
  });
  assert.deepEqual(exhausted.actions.map(action => action.id), ['projection.escalate']);
});

test('projection CLI help is available without job storage', async () => {
  const { spawnSync } = await import('node:child_process');
  const help = spawnSync(process.execPath, ['dist/cli.js', 'projection', '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /projection resolve/);
  assert.match(help.stdout, /never\s+auto-overwritten/);
});
