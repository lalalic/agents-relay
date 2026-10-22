import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteRelayStore } from '../../dist/relay-store.js';
import { LocalAuthorityDurableStore } from '../../dist/local-authority-store.js';
import { InMemoryStore } from '../../dist/store.js';
import { Reconciler } from '../../dist/reconciler.js';
import { createPlanRound } from '../../dist/planner.js';
import { createIsolatedEnvironment } from './harness.mjs';

const at = '2026-10-22T12:00:00.000Z';
function task(jobId, id, state, extra = {}) {
  return { id, jobId, parentTaskId: null, dependencies: [], capabilities: [], adapter: 'codex', input: id,
    state, attempt: state === 'FAILED' || state === 'SUCCEEDED' ? 1 : 0, maxAttempts: 2, leaseOwner: null,
    leaseExpiresAt: null, executionId: null, executionHistory: [], threadId: null, result: null,
    error: state === 'FAILED' ? 'known semantic failure' : null,
    failureReason: state === 'FAILED' ? 'task_failure' : undefined, timeoutMs: 10000,
    createdAt: at, updatedAt: at, continuation: null, continuationDeliveredAt: null,
    output: { kind: 'task_pr' }, ...extra };
}

async function fixture(forceRestate = true, includeFailed = true) {
  const env = createIsolatedEnvironment('relay-plan-apply-validation-');
  const jobId = `plan-apply-${Math.random().toString(36).slice(2)}`;
  const old = task(jobId, 'failed-old', 'FAILED');
  const reviewer = task(jobId, 'failed-review', 'FAILED', { agentName: 'reviewer' });
  const target = task(jobId, 'verified', 'SUCCEEDED', { error: null, failureReason: undefined });
  const job = { id: jobId, title: 'Atomic plan apply', objective: 'Apply only converged plans', repository: 'local/isolated', prNumber: 0,
    state: 'ACTIVE', executionMode: 'fixed', autoMerge: false, reviewEnabled: false,
    createdAt: at, updatedAt: at, tasks: includeFailed ? [old, reviewer, target] : [target], plans: [] };
  const plan = createPlanRound(job, { manual: true, now: at });
  plan.forceRestate = forceRestate;
  plan.restateTaskIds = forceRestate ? ['failed-old', 'failed-review'] : undefined;
  plan.executionId = 'planner-execution-1';
  plan.leaseOwner = 'planner-test';
  plan.updatedAt = at;
  job.plans = [plan];
  const stores = join(env.storeDir, 'stores'); mkdirSync(stores, { recursive: true });
  const sqlite = new SQLiteRelayStore(join(stores, 'relay.sqlite'), jobId);
  await sqlite.saveJob(job);
  const store = new LocalAuthorityDurableStore(sqlite, new InMemoryStore(), undefined, true);
  return { env, job, plan, sqlite, store };
}

function runtime(store) {
  return new Reconciler(store, { owner: 'planner-test', adapters: [{ name: 'codex', id: 'codex-worker', capabilities: [] }],
    maxConcurrent: 0, noGitHub: true, projectPathForJob: () => process.cwd(), planner: { plan: async () => { throw new Error('not launched'); } } });
}

const cleanup = [
  { taskId: 'failed-old', outcome: 'superseded', targetTaskId: 'verified', evidence: 'Verified replacement output', reason: 'The prior attempt is covered by the verified replacement.' },
  { taskId: 'failed-review', outcome: 'cancelled_review', evidence: 'The review targets an obsolete artifact head.', reason: 'The current Plan replaces that target.' },
];

test('L3 rejected Force Restate apply has zero SQLite changes and same execution can retry and commit idempotently', async () => {
  const f = await fixture();
  const reconciler = runtime(f.store);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  reconciler.plannerLive.set(f.plan.id, { executionId: 'planner-execution-1', controller, timer });
  try {
    const before = JSON.stringify(await f.sqlite.loadJob(f.job.id));
    await assert.rejects(reconciler.applyPlannerTree(f.job.id, f.plan.id, 'planner-execution-1', {
      objective_status: 'in_progress', assessment: 'Invalid hierarchy.',
      next_tasks: [{ id: 'bad-hierarchy', title: 'Implement and verify task', input: 'Work', parentTaskId: 'missing-parent', storySize: 'M', output: { kind: 'task_pr' } }],
    }), error => error.code === 'PLAN_APPLY_VALIDATION_FAILED' && error.phase === 'candidate');
    assert.equal(reconciler.plannerLive.get(f.plan.id)?.executionId, 'planner-execution-1', 'plain candidate validation also preserves the running Planner lease timer');
    assert.equal(JSON.stringify(await f.sqlite.loadJob(f.job.id)), before);
    const badHistory = cleanup.map(item => ({ ...item }));
    badHistory[0].targetTaskId = 'missing-proof-target';
    await assert.rejects(reconciler.applyPlannerTree(f.job.id, f.plan.id, 'planner-execution-1', {
      objective_status: 'satisfied', assessment: 'Contradictory historical target.', next_tasks: [], history_cleanup: badHistory,
    }), error => {
      assert.equal(error.code, 'PLAN_APPLY_VALIDATION_FAILED');
      assert.equal(error.phase, 'history_consistency');
      assert.match(error.message, /existing SUCCEEDED Task/);
      return true;
    });
    assert.equal(reconciler.plannerLive.get(f.plan.id)?.executionId, 'planner-execution-1', 'retryable rejection preserves the running Planner lease timer');
    assert.equal(JSON.stringify(await f.sqlite.loadJob(f.job.id)), before, 'failed history validation makes no SQLite writes');
    const empty = { objective_status: 'satisfied', assessment: 'Propose cleanup but no forward work.', next_tasks: [], history_cleanup: cleanup };
    await assert.rejects(reconciler.applyPlannerTree(f.job.id, f.plan.id, 'planner-execution-1', empty), error => {
      assert.equal(error.code, 'PLAN_APPLY_VALIDATION_FAILED');
      assert.equal(error.phase, 'forward_convergence');
      assert.match(error.message, /executable|dependency/);
      return true;
    });
    assert.equal(JSON.stringify(await f.sqlite.loadJob(f.job.id)), before, 'Plan, Task states, history, execution fence, and Job version are unchanged');

    const candidate = { ...empty, next_tasks: [{ id: 'repair', title: 'Implement and verify corrected durable work', input: 'Implement the verified follow-up.', storySize: 'M', output: { kind: 'task_pr' } }] };
    const applied = await reconciler.applyPlannerTree(f.job.id, f.plan.id, 'planner-execution-1', candidate);
    assert.equal(applied.status, 'SUCCEEDED');
    const committed = await f.sqlite.loadJob(f.job.id);
    assert.equal(committed.tasks.find(item => item.id === 'failed-old').resolutionClassification.kind, 'superseded');
    assert.equal(committed.tasks.find(item => item.id === 'failed-old').state, 'FAILED');
    assert.equal(committed.tasks.find(item => item.id === 'failed-review').state, 'CANCELLED');
    const repair = committed.tasks.find(item => item.planningDecisionId === f.plan.id);
    assert.ok(repair);
    assert.equal(repair.state, 'QUEUED');
    const afterCommit = JSON.stringify(committed);
    await reconciler.applyPlannerTree(f.job.id, f.plan.id, 'planner-execution-1', candidate);
    assert.equal(JSON.stringify(await f.sqlite.loadJob(f.job.id)), afterCommit, 'duplicate apply is idempotent');
    assert.equal(reconciler.plannerLive.has(f.plan.id), false, 'successful commit releases the Planner execution');
  } finally { clearTimeout(timer); await reconciler.close(); f.sqlite.close(); f.env.cleanup(); }
});

test('L3 unknown execution stays unresolved while evidence-backed recovery commits after rejection', async () => {
  const f = await fixture();
  const unknown = task(f.job.id, 'unknown-outcome', 'FAILED', { failureReason: 'worker_outcome_unknown', error: 'Worker exited before a terminal event.' });
  f.job.tasks = [unknown, f.job.tasks.find(item => item.id === 'verified')];
  f.plan.restateTaskIds = ['unknown-outcome'];
  await f.sqlite.saveJob(f.job);
  const reconciler = runtime(f.store);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  reconciler.plannerLive.set(f.plan.id, { executionId: 'planner-execution-1', controller, timer });
  try {
    const before = JSON.stringify(await f.sqlite.loadJob(f.job.id));
    const rejected = { objective_status: 'in_progress', assessment: 'The unknown outcome was not checked.', next_tasks: [
      { id: 'recover-unknown', title: 'Recover unknown execution outcome safely', input: 'Inspect durable evidence and safely recover the unknown prior execution.', storySize: 'M', output: { kind: 'task_pr' }, resolution: { path: 'same_job_dependency', targetTaskId: 'unknown-outcome', rootCause: 'The execution ended without a terminal event; outcome is unknown.', solution: 'Continue with bounded recovery while preserving the original failed record.' } },
    ], history_cleanup: [] };
    await assert.rejects(reconciler.applyPlannerTree(f.job.id, f.plan.id, 'planner-execution-1', rejected), error =>
      error.code === 'PLAN_APPLY_VALIDATION_FAILED' && error.phase === 'history_consistency' && /exactly one history_cleanup/.test(error.message));
    assert.equal(JSON.stringify(await f.sqlite.loadJob(f.job.id)), before, 'rejected candidate persists no Plan, Task, or history mutation');

    const corrected = { ...rejected, assessment: 'The historical execution remains unresolved; a routed recovery Task preserves uncertainty and advances the objective.', history_cleanup: [
      { taskId: 'unknown-outcome', outcome: 'unresolved', evidence: 'No durable task.completed/task.failed event or execution result is present after the worker exit.', reason: 'The execution outcome cannot be inferred; preserve the original failure as unresolved.' },
    ] };
    const applied = await reconciler.applyPlannerTree(f.job.id, f.plan.id, 'planner-execution-1', corrected);
    assert.equal(applied.status, 'SUCCEEDED');
    const committed = await f.sqlite.loadJob(f.job.id);
    const original = committed.tasks.find(item => item.id === 'unknown-outcome');
    assert.equal(original.state, 'FAILED');
    assert.equal(original.resolutionClassification, undefined);
    assert.equal(original.failureReason, 'worker_outcome_unknown');
    const recovery = committed.tasks.find(item => item.planningDecisionId === f.plan.id);
    assert.ok(recovery);
    assert.equal(recovery.state, 'QUEUED');
    assert.equal(recovery.resolution.targetTaskId, 'unknown-outcome');
    assert.equal(committed.plans[0].objectiveStatus, 'in_progress', 'unknown work cannot be reported complete');
  } finally { clearTimeout(timer); await reconciler.close(); f.sqlite.close(); f.env.cleanup(); }
});

test('L3 normal plan validation rejects history cleanup and preserves SQLite state', async () => {
  const f = await fixture(false, false);
  const reconciler = runtime(f.store);
  try {
    const before = JSON.stringify(await f.sqlite.loadJob(f.job.id));
    await assert.rejects(reconciler.applyPlannerTree(f.job.id, f.plan.id, 'planner-execution-1', {
      objective_status: 'in_progress', assessment: 'Invalid normal-plan history mutation.',
      next_tasks: [{ id: 'work', title: 'Implement and verify plan work', input: 'Work', storySize: 'M', output: { kind: 'task_pr' } }], history_cleanup: cleanup,
    }), error => error.code === 'PLAN_APPLY_VALIDATION_FAILED' && error.phase === 'history_consistency');
    assert.equal(JSON.stringify(await f.sqlite.loadJob(f.job.id)), before);
  } finally { await reconciler.close(); f.sqlite.close(); f.env.cleanup(); }
});

test('L3 normal Plan Apply commits valid routed work atomically', async () => {
  const f = await fixture(false, false);
  const reconciler = runtime(f.store);
  try {
    const applied = await reconciler.applyPlannerTree(f.job.id, f.plan.id, 'planner-execution-1', {
      objective_status: 'in_progress', assessment: 'The next batch has a real codex worker route.',
      next_tasks: [{ id: 'normal-work', title: 'Implement and verify the next durable work item', input: 'Implement and verify this work.', storySize: 'M', output: { kind: 'task_pr' } }],
    });
    assert.equal(applied.status, 'SUCCEEDED');
    const saved = await f.sqlite.loadJob(f.job.id);
    assert.equal(saved.plans.length, 1, 'normal commit does not manufacture another Plan');
    assert.equal(saved.tasks.filter(item => item.planningDecisionId === f.plan.id).length, 1);
  } finally { await reconciler.close(); f.sqlite.close(); f.env.cleanup(); }
});

test('L3 invalid schema and missing real worker route reject without SQLite writes', async () => {
  const f = await fixture(false, false);
  const reconciler = runtime(f.store);
  try {
    const before = JSON.stringify(await f.sqlite.loadJob(f.job.id));
    await assert.rejects(reconciler.applyPlannerTree(f.job.id, f.plan.id, 'planner-execution-1', {
      objective_status: 'in_progress', assessment: 'Malformed Planner candidate.', next_tasks: [{ title: 'Missing required input' }],
    }), error => error.code === 'PLAN_APPLY_VALIDATION_FAILED' && error.phase === 'candidate');
    assert.equal(JSON.stringify(await f.sqlite.loadJob(f.job.id)), before);
    const noAdapter = new Reconciler(f.store, { owner: 'planner-test', adapters: [], maxConcurrent: 0, noGitHub: true,
      projectPathForJob: () => process.cwd(), planner: { plan: async () => { throw new Error('not launched'); } } });
    try {
      await assert.rejects(noAdapter.applyPlannerTree(f.job.id, f.plan.id, 'planner-execution-1', {
        objective_status: 'in_progress', assessment: 'No eligible worker is registered.',
        next_tasks: [{ id: 'unroutable', title: 'Implement and verify unroutable work', input: 'Work', storySize: 'M', output: { kind: 'task_pr' } }],
      }), error => error.code === 'PLAN_APPLY_VALIDATION_FAILED' && error.phase === 'forward_convergence');
      assert.equal(JSON.stringify(await f.sqlite.loadJob(f.job.id)), before);
    } finally { await noAdapter.close(); }
  } finally { await reconciler.close(); f.sqlite.close(); f.env.cleanup(); }
});

test('L3 apply fences a concurrent Job version change before candidate commit', async () => {
  const f = await fixture(false, false);
  const reconciler = runtime(f.store);
  const originalListAgents = f.store.listAgents.bind(f.store);
  let concurrentSnapshot;
  f.store.listAgents = async () => {
    await f.sqlite.mutateJob(f.job.id, current => ({ ...current, title: 'Concurrent durable edit' }));
    concurrentSnapshot = JSON.stringify(await f.sqlite.loadJob(f.job.id));
    f.store.listAgents = originalListAgents;
    return originalListAgents();
  };
  try {
    await assert.rejects(reconciler.applyPlannerTree(f.job.id, f.plan.id, 'planner-execution-1', {
      objective_status: 'in_progress', assessment: 'candidate work',
      next_tasks: [{ id: 'fenced-work', title: 'Implement and verify fenced work', input: 'Work', storySize: 'M', output: { kind: 'task_pr' } }],
    }), error => error.code === 'PLAN_APPLY_VALIDATION_FAILED' && error.phase === 'fencing');
    assert.equal(JSON.stringify(await f.sqlite.loadJob(f.job.id)), concurrentSnapshot, 'apply adds no Plan/Task/history mutation on a stale snapshot');
  } finally { await reconciler.close(); f.sqlite.close(); f.env.cleanup(); }
});
