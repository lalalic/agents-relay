import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { decideTaskResolution, dispatchTaskResolution, validateResolutionProposal, materializeResolution } from '../dist/workflow/task-resolution.js';
import { validatePlannerResolutionMaterialization } from '../dist/planner.js';

const task = (id, state = 'FAILED') => ({ jobId: 'j', id, kind: 'work', state, dependencies: [], parentTaskId: null, adapter: 'codex', input: id, capabilities: [], attempt: 1, maxAttempts: 3, leaseOwner: null, leaseExpiresAt: null, executionId: null, threadId: null, result: null, error: 'failure', timeoutMs: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' });
const job = (tasks) => ({ id: 'j', repository: 'o/r', prNumber: 0, title: 'j', executionMode: 'fixed', state: 'ACTIVE', continuation: null, createdAt: '', updatedAt: '', tasks });

test('resolution graph exposes exact-original retry and never replacement_task', () => {
  const original = task('original');
  const proposal = { path: 'exact_original_retry', targetTaskId: 'original', rootCause: 'transient runtime', solution: 'repair runtime' };
  validateResolutionProposal(job([original]), original, proposal);
  const decision = decideTaskResolution(original, proposal, 'troubleshooter');
  assert.equal(decision.accepted, true);
  assert.deepEqual(decision.actions.map(action => action.id), ['resolution.activateRecovery']);
  assert.equal(JSON.stringify(decision).includes('replacement_task'), false);
  assert.equal(materializeResolution(original, proposal, 'troubleshooter').owner, 'troubleshooter');
});

test('planner cannot materialize an unresolved sibling without a graph resolution', () => {
  const original = task('failed');
  assert.throws(() => validatePlannerResolutionMaterialization([original], [{ id: 'failed-r2', input: 'try again' }]), /sibling replacement/);
  assert.throws(() => validatePlannerResolutionMaterialization([original, task('second')], [{ id: 'recovery', input: 'repair', resolution: { path: 'exact_original_retry', targetTaskId: 'failed' } }]), /second/);
  assert.doesNotThrow(() => validatePlannerResolutionMaterialization([task('done', 'SUCCEEDED')], [{ id: 'new', input: 'genuine new work' }]));
});

test('resolution guards validate same-job and blocker-job targets deterministically', () => {
  const original = task('blocked', 'BLOCKED');
  assert.doesNotThrow(() => validateResolutionProposal(job([original, task('repair', 'QUEUED')]), original, { path: 'same_job_dependency', targetTaskId: 'repair' }));
  assert.throws(() => validateResolutionProposal(job([original]), original, { path: 'same_job_dependency', targetTaskId: 'missing' }), /existing target/);
  assert.doesNotThrow(() => validateResolutionProposal(job([original]), original, { path: 'blocker_job_dependency', targetJobId: 'blocker', mode: 'verified' }));
});


test('troubleshooter resolution owner does not override selected path', () => {
  const original = task('blocked', 'BLOCKED');
  const cases = [
    [{ path: 'same_job_dependency', targetTaskId: 'repair' }, 'resolution.attachSameJobDependency'],
    [{ path: 'blocker_job_dependency', targetJobId: 'blocker-job', mode: 'verified' }, 'resolution.registerBlockerDependency'],
    [{ path: 'escalation_gate', rootCause: 'human approval', solution: 'request approval' }, 'resolution.createEscalationGate'],
    [{ path: 'cancel_supersede', rootCause: 'objective obsolete' }, 'resolution.cancelSupersede'],
  ];
  const context = job([original, task('repair', 'QUEUED')]);
  for (const [proposal, action] of cases) {
    validateResolutionProposal(context, original, proposal);
    const decision = decideTaskResolution(original, proposal, 'troubleshooter');
    assert.equal(decision.accepted, true);
    assert.deepEqual(decision.actions.map(item => item.id), [action]);
  }
});

test('planner and troubleshooter owners share the same path selection graph', () => {
  const original = task('blocked', 'BLOCKED');
  const proposal = { path: 'blocker_job_dependency', targetJobId: 'blocker-job', mode: 'merge' };
  const trouble = decideTaskResolution(original, proposal, 'troubleshooter');
  const planner = decideTaskResolution(original, proposal, 'planner');
  assert.deepEqual(trouble.actions.map(item => item.id), ['resolution.registerBlockerDependency']);
  assert.deepEqual(planner.actions.map(item => item.id), ['resolution.registerBlockerDependency']);
});


test('dispatches graph-selected production effect exactly once', async () => {
  const original = task('blocked', 'BLOCKED');
  const cases = [
    [{ path: 'same_job_dependency', targetTaskId: 'repair' }, 'same'],
    [{ path: 'blocker_job_dependency', targetJobId: 'blocker', mode: 'verified' }, 'blocker'],
    [{ path: 'escalation_gate', rootCause: 'human', solution: 'ask' }, 'gate'],
    [{ path: 'cancel_supersede', rootCause: 'obsolete' }, 'cancel'],
  ];
  for (const [proposal, expected] of cases) {
    const calls=[];
    const decision=await dispatchTaskResolution(original, proposal, 'troubleshooter', {
      activateRecovery:()=>calls.push('retry'), attachSameJobDependency:()=>calls.push('same'),
      registerBlockerDependency:()=>calls.push('blocker'), createEscalationGate:()=>calls.push('gate'),
      cancelSupersede:()=>calls.push('cancel'),
    });
    assert.equal(decision.accepted,true); assert.deepEqual(calls,[expected]);
  }
});

test('task resolution fails closed when selected effect is unavailable', async () => {
  const original=task('failed','FAILED');
  await assert.rejects(()=>dispatchTaskResolution(original,{path:'exact_original_retry',targetTaskId:'failed'},'troubleshooter',{}),/effect resolution.activateRecovery is unavailable/);
});
