import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SQLiteRelayStore } from '../../dist/relay-store.js';
import { AgentObjectivePlanner } from '../../dist/planner.js';
import { finishPlanner } from '../../dist/planner-runtime.js';
import { createIsolatedEnvironment } from './harness.mjs';

const jobId = 'planner-contract-l1';
const planId = 'plan-1';
const executionId = 'execution-1';
const receipt = `PLAN_APPLIED:${planId}:${executionId}`;
const proposal = {
  objective_status: 'in_progress', assessment: 'Implement the verified deliverable.',
  next_tasks: [{ id: 'implementation', title: 'Create and verify one durable implementation task',
    input: 'Create the requested deliverable and report evidence.', output: { kind: 'task_pr' }, storySize: 'S' }],
};

async function setup() {
  const env = createIsolatedEnvironment('relay-planner-contract-');
  const timestamp = new Date().toISOString();
  const plan = {
    jobId, id: planId, round: 1, source: 'model-planner', previousPlanId: null,
    trigger: { source: 'initial' }, status: 'PLANNING', assessment: 'Planning in progress.',
    generatedTaskIds: [], attempt: 1, maxAttempts: 2, manualPlanning: false,
    leaseOwner: 'planner-l1', leaseExpiresAt: null, executionId, timeoutMs: 10000,
    createdAt: timestamp, updatedAt: timestamp,
  };
  const job = {
    id: jobId, title: 'Planner receipt contract', objective: 'Create one verified Task',
    repository: 'local/isolated', prNumber: 0, state: 'ACTIVE', executionMode: 'autonomous',
    autoMerge: false, reviewEnabled: false, createdAt: timestamp, updatedAt: timestamp,
    plans: [plan], tasks: [],
  };
  const store = new SQLiteRelayStore(join(env.root, 'relay.sqlite'), jobId);
  await store.createJobIfAbsent(job);
  const proposalFile = join(env.root, 'proposal.json');
  await writeFile(proposalFile, JSON.stringify(proposal));
  const fakeModel = join(env.root, 'fake-model.mjs');
  await writeFile(fakeModel, `#!/usr/bin/env node
    const message = process.env.PLANNER_FAKE_MESSAGE;
    process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: message } }) + '\\n');
  `);
  await chmod(fakeModel, 0o700);
  return { env, store, job, proposalFile, fakeModel, cleanup() { store.close(); env.cleanup(); } };
}

function context(job, plan = true) {
  return { job, tasks: [], objective: job.objective, previousPlannerTaskId: null,
    ...(plan ? { planExecution: { planId, executionId } } : {}) };
}

async function runPlanner(fixture, message = receipt) {
  const previous = { storeDir: process.env.AGENTS_RELAY_STORE_DIR, message: process.env.PLANNER_FAKE_MESSAGE };
  Object.assign(process.env, { AGENTS_RELAY_STORE_DIR: fixture.env.storeDir, PLANNER_FAKE_MESSAGE: message });
  try {
    return await new AgentObjectivePlanner(fixture.fakeModel).plan(context(fixture.job), new AbortController().signal);
  } finally {
    for (const [key, value] of Object.entries({ AGENTS_RELAY_STORE_DIR: previous.storeDir, PLANNER_FAKE_MESSAGE: previous.message })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

function applyPlan(fixture) {
  return spawnSync(process.execPath, [join(process.cwd(), 'dist', 'cli.js'), 'plan', 'apply', '--no-github',
    '--repo', fixture.job.repository, '--pr', '0', '--id', jobId, '--plan-id', planId,
    '--execution-id', executionId, '--store-dir', fixture.env.storeDir, '--file', fixture.proposalFile],
    { encoding: 'utf8', env: fixture.env });
}

test('Planner accepts the exact receipt after the CLI durably applies the Plan', async () => {
  const fixture = await setup();
  try {
    const applied = applyPlan(fixture);
    assert.equal(applied.status, 0, applied.stderr || applied.stdout);
    const result = await runPlanner(fixture);
    const durable = await fixture.store.loadJob(jobId);
    assert.equal(result.cliApplied, true, applied.stdout);
    assert.equal(durable?.plans?.[0]?.status, 'SUCCEEDED', applied.stdout);
    assert.equal(durable?.tasks?.length, 1);
    assert.deepEqual(durable?.plans?.[0]?.generatedTaskIds, [durable?.tasks?.[0]?.id]);
  } finally { fixture.cleanup(); }
});

test('Planner rejects missing, decorated, mismatched, and text-only success messages', async () => {
  const fixture = await setup();
  try {
    for (const message of ['', `${receipt}\nApplied successfully.`, `PLAN_APPLIED:${planId}:other`, 'Plan applied successfully']) {
      await assert.rejects(runPlanner(fixture, message), /matching PLAN_APPLIED receipt|return only the matching PLAN_APPLIED receipt|no final message/);
    }
    const durable = await fixture.store.loadJob(jobId);
    assert.equal(durable?.plans?.[0]?.status, 'PLANNING');
    assert.equal(durable?.tasks?.length, 0);
  } finally { fixture.cleanup(); }
});

test('Planner requires a durable Plan execution identity before launching the model', async () => {
  const fixture = await setup();
  try {
    await assert.rejects(new AgentObjectivePlanner(fixture.fakeModel)
      .plan(context(fixture.job, false), new AbortController().signal), /missing its durable Plan and execution identity/);
  } finally { fixture.cleanup(); }
});

test('a matching receipt alone cannot pass the persisted Plan transition guard', async () => {
  const fixture = await setup();
  try {
    const result = await runPlanner(fixture);
    await assert.rejects(finishPlanner({ store: { load: id => fixture.store.loadJob(id) }, live: new Map() }, jobId, planId, executionId, null, result), /reported CLI application, but Plan plan-1 is PLANNING/);
    const durable = await fixture.store.loadJob(jobId);
    assert.equal(durable?.plans?.[0]?.status, 'PLANNING');
    assert.equal(durable?.tasks?.length, 0);
  } finally { fixture.cleanup(); }
});

test('reapplying a succeeded Plan is idempotent and leaves one committed Task', async () => {
  const fixture = await setup();
  try {
    const first = applyPlan(fixture);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const repeated = applyPlan(fixture);
    assert.equal(repeated.status, 0, repeated.stderr || repeated.stdout);
    const durable = await fixture.store.loadJob(jobId);
    assert.equal(durable?.plans?.[0]?.status, 'SUCCEEDED');
    assert.equal(durable?.tasks?.length, 1);
  } finally { fixture.cleanup(); }
});
