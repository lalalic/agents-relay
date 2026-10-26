import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteRelayStore } from '../../dist/relay-store.js';
import { AgentObjectivePlanner } from '../../dist/planner.js';
import { createIsolatedEnvironment } from './harness.mjs';

test('L3 plan apply CLI commits its Plan and Tasks to isolated SQLite', async () => {
  const env = createIsolatedEnvironment('relay-planner-cli-');
  const jobId = 'planner-cli-l3';
  const planId = 'plan-1';
  const executionId = 'execution-l3';
  const timestamp = new Date().toISOString();
  const plan = {
    jobId, id: planId, round: 1, source: 'model-planner', previousPlanId: null,
    trigger: { source: 'initial' }, status: 'PLANNING', assessment: 'Planning in progress.',
    generatedTaskIds: [], attempt: 1, maxAttempts: 2, manualPlanning: false,
    leaseOwner: 'planner-l3', leaseExpiresAt: null, executionId, timeoutMs: 10000,
    createdAt: timestamp, updatedAt: timestamp,
  };
  const job = {
    id: jobId, title: 'Planner CLI receipt', objective: 'Create one verified Task',
    repository: 'local/isolated', prNumber: 0, state: 'ACTIVE', autoMerge: false, reviewEnabled: false, createdAt: timestamp, updatedAt: timestamp,
    plans: [plan], tasks: [],
  };
  const store = new SQLiteRelayStore(join(env.root, 'relay.sqlite'), jobId);
  try {
    await store.createJobIfAbsent(job);
    const proposal = {
      objective_status: 'in_progress', assessment: 'Implement the verified deliverable.',
      next_tasks: [{ id: 'implementation', title: 'Create and verify one durable task',
        input: 'Create the requested deliverable and report evidence.', output: { kind: 'task_pr' }, storySize: 'S' }],
    };
    const proposalFile = join(env.root, 'proposal.json');
    await writeFile(proposalFile, JSON.stringify(proposal));
    const cli = join(process.cwd(), 'dist', 'cli.js');
    const result = spawnSync(process.execPath, [cli, 'plan', 'apply', '--no-github', '--repo', job.repository,
      '--pr', '0', '--id', jobId, '--plan-id', planId, '--execution-id', executionId,
      '--store-dir', env.storeDir, '--file', proposalFile], {
      cwd: process.cwd(), encoding: 'utf8', env: { ...env.env, AGENTS_RELAY_STORE_DIR: env.storeDir },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const durable = await store.loadJob(jobId);
    assert.equal(durable?.plans?.[0]?.status, 'SUCCEEDED');
    assert.equal(durable?.plans?.[0]?.generatedTaskIds?.length, 1);
    assert.equal(durable?.tasks?.length, 1);
    assert.equal(durable?.plans?.[0]?.generatedTaskIds?.[0], durable?.tasks?.[0]?.id);
  } finally {
    store.close();
    env.cleanup();
  }
});

test('L3 live Codex Planner applies through CLI and returns the matching receipt', {
  skip: process.env.RELAY_L3_CODEX_LIVE !== '1' ? 'set RELAY_L3_CODEX_LIVE=1 to use the authenticated Codex CLI' : false,
}, async () => {
  const env = createIsolatedEnvironment('relay-planner-codex-');
  const bin = await mkdtemp(join(tmpdir(), 'relay-planner-bin-'));
  const oldStoreDir = process.env.AGENTS_RELAY_STORE_DIR;
  const oldPath = process.env.PATH;
  const jobId = 'planner-codex-l3';
  const planId = 'plan-1';
  const executionId = 'execution-codex-l3';
  const timestamp = new Date().toISOString();
  const plan = {
    jobId, id: planId, round: 1, source: 'model-planner', previousPlanId: null,
    trigger: { source: 'initial' }, status: 'PLANNING', assessment: 'Planning in progress.',
    generatedTaskIds: [], attempt: 1, maxAttempts: 2, manualPlanning: false,
    leaseOwner: 'planner-l3', leaseExpiresAt: null, executionId, timeoutMs: 180000,
    createdAt: timestamp, updatedAt: timestamp,
  };
  const job = {
    id: jobId, title: 'Planner CLI receipt', objective: 'Create one small executable task for a hello world deliverable.',
    repository: 'local/isolated', prNumber: 0, state: 'ACTIVE', autoMerge: false, reviewEnabled: false, createdAt: timestamp, updatedAt: timestamp,
    plans: [plan], tasks: [],
  };
  const store = new SQLiteRelayStore(join(env.root, 'relay.sqlite'), jobId);
  try {
    await store.createJobIfAbsent(job);
    const cli = join(process.cwd(), 'dist', 'cli.js');
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    const shim = join(bin, 'agents-relay');
    await mkdir(bin, { recursive: true });
    await writeFile(shim, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(cli)} "$@"\n`);
    await chmod(shim, 0o700);
    process.env.AGENTS_RELAY_STORE_DIR = env.storeDir;
    process.env.PATH = `${bin}:${oldPath ?? '/usr/bin:/bin'}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180000);
    try {
      const planner = new AgentObjectivePlanner(process.env.RELAY_L3_CODEX ?? 'codex');
      const result = await planner.plan({ job, tasks: [], objective: job.objective, previousPlannerTaskId: null,
        planExecution: { planId, executionId } }, controller.signal);
      assert.equal(result.cliApplied, true);
      const durable = await store.loadJob(jobId);
      assert.equal(durable?.plans?.[0]?.status, 'SUCCEEDED');
      assert.equal(durable?.plans?.[0]?.generatedTaskIds?.length, 1);
      assert.equal(durable?.tasks?.length, 1);
    } finally { clearTimeout(timer); }
  } finally {
    store.close();
    if (oldStoreDir === undefined) delete process.env.AGENTS_RELAY_STORE_DIR; else process.env.AGENTS_RELAY_STORE_DIR = oldStoreDir;
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    env.cleanup();
    await rm(bin, { recursive: true, force: true });
  }
});
