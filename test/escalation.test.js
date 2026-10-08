import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { neoEscalationArgs } from '../dist/cli-escalation.js';
import { escalationGraph, runEscalationGraph } from '../dist/workflow/escalation.js';

const request = { intent: 'finish release', blockedOn: 'identity prompt', context: 'browser authenticated' };

test('canonical escalation graph has no version suffix and owns all three result branches', async () => {
  assert.ok(escalationGraph.graph);
  for (const [status, expectedState, expectedAction] of [
    ['resolved', 'resolved', 'escalation.resume_recovery'],
    ['failed', 'technical_failure', 'escalation.technical_failure'],
    ['needs_user', 'needs_user', 'escalation.block_for_user'],
  ]) {
    const actions = [];
    const outcome = await runEscalationGraph(request, {
      invoke: async () => ({ status, summary: status }),
      resumeRecovery: () => actions.push('escalation.resume_recovery'),
      technicalFailure: () => actions.push('escalation.technical_failure'),
      blockForUser: () => actions.push('escalation.block_for_user'),
    });
    assert.equal(outcome.state, expectedState);
    assert.deepEqual(actions, [expectedAction]);
    assert.equal(outcome.requestDecision.actions[0]?.id, 'escalation.invoke');
    assert.equal(outcome.resultDecision.actions[0]?.id, expectedAction);
  }
});

test('needs_user is the only graph path selecting block_for_user', async () => {
  for (const status of ['resolved', 'failed']) {
    let blocked = false;
    await runEscalationGraph(request, {
      invoke: async () => ({ status, summary: status }),
      blockForUser: () => { blocked = true; },
    });
    assert.equal(blocked, false);
  }
  let blocked = false;
  await runEscalationGraph(request, {
    invoke: async () => ({ status: 'needs_user', summary: 'MFA', user_action: 'Approve MFA' }),
    blockForUser: () => { blocked = true; },
  });
  assert.equal(blocked, true);
});

test('Neo escalation adapter uses handoff files instead of legacy split options', () => {
  const args = neoEscalationArgs('/tmp/handoff.md', '/tmp/policy.md', '/tmp/work');
  assert.deepEqual(args, [
    'escalation',
    '--handoff-file', '/tmp/handoff.md',
    '--on-needs-user-file', '/tmp/policy.md',
    '--cwd', '/tmp/work',
  ]);
  assert.equal(args.includes('--intent'), false);
  assert.equal(args.includes('--blocked-on'), false);
  assert.equal(args.includes('--context'), false);
  assert.equal(args.includes('--on-needs-user'), false);
});
