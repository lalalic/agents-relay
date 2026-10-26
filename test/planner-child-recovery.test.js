import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { recoverPlannerChildren } from '../dist/planner-child-recovery.js';
import { validateResolutionProposal } from '../dist/workflow/task-resolution.js';

const now = () => new Date().toISOString();

function task(id, state, values = {}) {
  return {
    jobId: 'job-473', id, kind: 'work', priority: 'P1', storySize: 'S', projectName: 'Job 473',
    parentTaskId: null, dependencies: [], capabilities: [], adapter: 'codex', input: id,
    output: { kind: 'task_pr' }, state, attempt: 0, maxAttempts: 3, leaseOwner: null,
    leaseExpiresAt: null, executionId: null, threadId: null, result: null, plannerResult: null,
    error: null, timeoutMs: 1000, createdAt: now(), updatedAt: now(),
    continuation: null, continuationDeliveredAt: null, ...values,
  };
}

function fixture(targetState) {
  const proposal = {
    path: 'same_job_dependency', targetTaskId: 'target',
    rootCause: 'The task needs the target result.', solution: 'Wait for target completion.',
  };
  const child = task('planned-child', 'FAILED', {
    attempt: 2, executionId: null, error: 'historical failure', result: 'historical result',
    resolution: { ...proposal, state: 'active', owner: 'planner', updatedAt: now() },
  });
  const target = task('target', targetState);
  const spec = { id: child.id, title: 'Run planned child', input: child.input,
    output: child.output, storySize: 'S', resolution: proposal };
  const plan = {
    jobId: 'job-473', id: 'plan-1', round: 1, source: 'model-planner', previousPlanId: null,
    trigger: { source: 'initial' }, status: 'SUCCEEDED', generatedTaskIds: [child.id],
    assessment: 'Continue work.', createdAt: now(), updatedAt: now(),
    plannerResult: { objective_status: 'in_progress', assessment: 'Continue work.', next_tasks: [spec], unblocks: [] },
  };
  const job = { id: 'job-473', title: 'Job 473', objective: 'Complete the objective', repository: 'local/test',
    prNumber: 0, state: 'ACTIVE', autoMerge: false, reviewEnabled: false,
    createdAt: now(), updatedAt: now(), plans: [plan], tasks: [target, child] };
  return { job, child, plan, spec };
}

test('historical succeeded Plan skips rematerializing an existing child after its target becomes terminal', async () => {
  for (const targetState of ['SUCCEEDED', 'CANCELLED']) {
    const { job, child } = fixture(targetState);
    let contextCalls = 0;
    const store = { saveTask: async () => assert.fail('existing Resolution must not be rewritten'),
      appendTask: async () => assert.fail('existing child must not be duplicated') };
    await recoverPlannerChildren(store, job, async () => { contextCalls++; return { agents: [] }; });
    assert.equal(contextCalls, 0);
    assert.equal(job.tasks.filter(item => item.id === child.id).length, 1);
    assert.equal(child.attempt, 2);
    assert.equal(child.executionId, null);
    assert.equal(child.result, 'historical result');
    assert.equal(child.error, 'historical failure');
    assert.equal(child.resolution.targetTaskId, 'target');
  }
});

test('new same-Job dependency proposals still reject a terminal target', () => {
  const { job } = fixture('SUCCEEDED');
  const original = task('original', 'FAILED');
  job.tasks.push(original);
  assert.throws(() => validateResolutionProposal(job, original,
    { path: 'same_job_dependency', targetTaskId: 'target' }),
    /Same-Job dependency resolution requires an existing unresolved target Task in the same Job/);
});
