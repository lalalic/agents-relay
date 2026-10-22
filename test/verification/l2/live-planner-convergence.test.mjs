import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SQLiteRelayStore } from '../../../dist/relay-store.js';
import { createPlanRound, AgentObjectivePlanner } from '../../../dist/planner.js';

const enabled = process.env.RELAY_L2_LIVE === '1';
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const at = new Date().toISOString();

test('L2 real Codex Planner corrects rejected forced restatement in one execution', { skip: !enabled, timeout: 240_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-relay-l2-planner-'));
  const storeDirectory = join(root, 'agent-relay', 'stores');
  const projectDirectory = join(root, 'project');
  const binDirectory = join(root, 'bin');
  await Promise.all([mkdir(storeDirectory, { recursive: true }), mkdir(projectDirectory), mkdir(binDirectory)]);
  const initialized = spawnSync('git', ['init', projectDirectory], { encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stderr);
  await writeFile(join(projectDirectory, 'README.md'), 'Isolated L2 planner fixture.\n');
  for (const args of [
    ['-C', projectDirectory, 'config', 'user.email', 'l2@example.invalid'],
    ['-C', projectDirectory, 'config', 'user.name', 'L2 Fixture'],
    ['-C', projectDirectory, 'add', 'README.md'],
    ['-C', projectDirectory, 'commit', '-m', 'Initialize isolated planner fixture'],
  ]) {
    const result = spawnSync('git', args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  const originalEnv = { path: process.env.PATH, store: process.env.AGENTS_RELAY_STORE_DIR };
  const jobId = `l2-planner-${randomUUID()}`;
  const planId = 'plan-1';
  const executionId = `execution-${randomUUID()}`;
  const job = {
    id: jobId, title: 'Resolve the outstanding objective',
    objective: 'Safely converge the work represented by historical Task task-150. Inspect its actual evidence. Its worker ended without a terminal event, so do not claim completion or infer the outcome. Preserve history and either create a justified safe recovery task or an evidence-backed blocked Troubleshooter.',
    repository: 'local/planner-l2', prNumber: 0, state: 'ACTIVE', executionMode: 'fixed',
    autoMerge: false, reviewEnabled: false, tasks: [], plans: [], createdAt: at, updatedAt: at,
  };
  job.tasks.push({
    id: 'task-150', jobId, title: 'Investigate the interrupted worker outcome', kind: 'work', parentTaskId: null,
    dependencies: [], capabilities: [], adapter: 'codex', input: 'A previous worker process exited before a terminal task event was recorded.',
    output: { kind: 'file', path: 'runs/task-150/worker-output.md' }, state: 'FAILED', attempt: 1, maxAttempts: 2, leaseOwner: null,
    leaseExpiresAt: null, executionId: null, threadId: null, result: null,
    error: 'Codex process exited; no task.completed/task.failed event was captured.',
    failureReason: 'worker_outcome_unknown', executionHistory: [{ executionId: 'lost-execution-150', attempt: 1, outcome: 'unknown', endedAt: at }],
    timeoutMs: 300000, createdAt: at, updatedAt: at, continuation: null, continuationDeliveredAt: null,
  });
  const plan = createPlanRound(job, { manual: true, now: at });
  plan.id = planId;
  plan.forceRestate = true;
  plan.restateTaskIds = ['task-150'];
  plan.executionId = executionId;
  plan.leaseOwner = 'l2-planner';
  plan.attempt = 1;
  job.plans = [plan];

  const databasePath = join(dirname(storeDirectory), 'relay.sqlite');
  const store = new SQLiteRelayStore(databasePath, jobId);
  try {
    await store.saveJob(job);

    const attemptsPath = join(root, 'apply-attempts');
    const firstFailurePath = join(root, 'first-apply-failure.json');
    const codexOutputPath = join(root, 'codex-output.log');
    const cliPath = join(repo, 'dist', 'cli.js');
    const wrapperPath = join(binDirectory, 'agents-relay');
    const wrapper = `#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const isApply = args[0] === 'plan' && args[1] === 'apply' && !args.includes('--help') && !args.includes('-h');
const isolatedArgs = [...args];
for (let index = isolatedArgs.length - 1; index >= 0; index -= 1) {
  if (isolatedArgs[index] === '--workspace-root') isolatedArgs.splice(index, 2);
}
isolatedArgs.push('--events', 'none', '--no-github', '--workspace-root', ${JSON.stringify(join(root, '.worktrees'))});
if (isApply) isolatedArgs.push('--project-path', ${JSON.stringify(projectDirectory)});
if (!isApply) {
  const result = spawnSync(process.execPath, [${JSON.stringify(cliPath)}, ...isolatedArgs], { stdio: 'inherit', env: process.env });
  process.exit(result.status ?? 1);
}
const countPath = ${JSON.stringify(attemptsPath)};
const failurePath = ${JSON.stringify(firstFailurePath)};
const cliPath = ${JSON.stringify(cliPath)};
const databasePath = ${JSON.stringify(databasePath)};
const jobId = ${JSON.stringify(jobId)};
const nextCount = Number(existsSync(countPath) ? readFileSync(countPath, 'utf8') : '0') + 1;
writeFileSync(countPath, String(nextCount));
let runArgs = isolatedArgs;
if (nextCount === 1) {
  const fileIndex = isolatedArgs.indexOf('--file');
  if (fileIndex < 0 || !args[fileIndex + 1]) process.exit(97);
  const candidate = JSON.parse(readFileSync(isolatedArgs[fileIndex + 1], 'utf8'));
  delete candidate.history_cleanup;
  const rejectedPath = ${JSON.stringify(join(root, 'rejected-candidate.json'))};
  writeFileSync(rejectedPath, JSON.stringify(candidate));
  runArgs = [...isolatedArgs];
  runArgs[fileIndex + 1] = rejectedPath;
}
const result = spawnSync(process.execPath, [cliPath, ...runArgs], { encoding: 'utf8', env: process.env });
const validationFailure = /"code":"PLAN_APPLY_VALIDATION_FAILED"/.test(result.stderr ?? '');
if (nextCount === 1) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  const row = db.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get(jobId);
  const snapshot = row ? JSON.parse(row.json) : null;
  db.close();
  const plan = snapshot?.plans?.find(item => item.id === ${JSON.stringify(planId)});
  const original = snapshot?.tasks?.find(item => item.id === 'task-150');
  writeFileSync(failurePath, JSON.stringify({ status: validationFailure ? 1 : result.status, stderr: result.stderr ?? '', planStatus: plan?.status, generatedTaskIds: plan?.generatedTaskIds, taskCount: snapshot?.tasks?.length, originalState: original?.state, originalFailureReason: original?.failureReason, resolutionClassification: original?.resolutionClassification }));
}
process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
process.exitCode = validationFailure ? 1 : result.status ?? 1;
`;
    await writeFile(wrapperPath, wrapper, { mode: 0o700 });
    await chmod(wrapperPath, 0o700);
    const codexPath = process.env.RELAY_L2_CODEX ?? spawnSync('which', ['codex'], { encoding: 'utf8' }).stdout.trim();
    assert.ok(codexPath, 'Codex CLI must be available');
    const codexWrapperPath = join(binDirectory, 'codex-l2');
    const codexWrapper = `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const separator = args.indexOf('--');
if (separator < 0) process.exit(96);
args.splice(separator, 0, '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '--add-dir', ${JSON.stringify(root)}, '--add-dir', ${JSON.stringify(join(projectDirectory, '.git'))});
const result = spawnSync(${JSON.stringify(codexPath)}, args, { encoding: 'utf8', env: process.env });
const { appendFileSync } = await import('node:fs');
appendFileSync(${JSON.stringify(codexOutputPath)}, (result.stdout ?? '') + (result.stderr ?? ''));
process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
process.exitCode = result.status ?? 1;
`;
    await writeFile(codexWrapperPath, codexWrapper, { mode: 0o700 });
    await chmod(codexWrapperPath, 0o700);
    process.env.PATH = `${binDirectory}:${originalEnv.path ?? '/usr/bin:/bin'}`;
    process.env.AGENTS_RELAY_STORE_DIR = storeDirectory;

    const executionContext = {
      project: { name: 'planner-l2-fixture', path: projectDirectory, workspaceRoot: projectDirectory, neoRoot: null, globalRoot: null },
      role: 'planner', instructions: [], skills: [], runtimes: [],
      agents: [{ name: 'implementation', description: 'Implement justified recovery work.', capabilities: ['implementation'], restrictions: [], trustDomains: [], runtime: 'codex', source: 'test' }],
      delegation: { mode: 'relay-child-task', parentTaskIdRequired: false },
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 210_000);
    let result;
    try {
      result = await new AgentObjectivePlanner(codexWrapperPath).plan({
        job, tasks: job.tasks, objective: job.objective, previousPlannerTaskId: null,
        planExecution: { planId, executionId }, forceRestate: true, restateTaskIds: ['task-150'], executionContext,
      }, controller.signal);
    } catch (error) {
      if (process.env.RELAY_L2_KEEP_FIXTURE === '1') console.error(`L2 planner fixture retained at ${root}`);
      throw error;
    } finally { clearTimeout(timeout); }

    assert.equal(result.cliApplied, true);
    const applyAttempts = Number((await readFile(attemptsPath, 'utf8')).trim());
    assert.ok(applyAttempts >= 2 && applyAttempts <= 4, `expected one rejected apply and at most three corrections, saw ${applyAttempts}`);
    const firstFailure = JSON.parse(await readFile(firstFailurePath, 'utf8'));
    assert.equal(firstFailure.status, 1);
    assert.match(firstFailure.stderr, /"code":"PLAN_APPLY_VALIDATION_FAILED"/);
    assert.match(firstFailure.stderr, /"phase":"history_consistency"/);
    assert.match(firstFailure.stderr, /exactly one history_cleanup/);
    assert.equal(firstFailure.planStatus, 'PLANNING');
    assert.deepEqual(firstFailure.generatedTaskIds, []);
    assert.equal(firstFailure.taskCount, 1, 'rejected apply persisted no recovery Task');
    assert.equal(firstFailure.originalState, 'FAILED');
    assert.equal(firstFailure.originalFailureReason, 'worker_outcome_unknown');
    assert.equal(firstFailure.resolutionClassification, undefined);
    const persisted = await store.loadJob(jobId);
    const committedPlan = persisted.plans.find(item => item.id === planId);
    const original = persisted.tasks.find(item => item.id === 'task-150');
    assert.equal(committedPlan.status, 'SUCCEEDED');
    assert.equal(committedPlan.appliedExecutionId, executionId);
    assert.equal(committedPlan.objectiveStatus, 'in_progress');
    assert.equal(original.state, 'FAILED');
    assert.equal(original.failureReason, 'worker_outcome_unknown');
    assert.equal(original.resolutionClassification, undefined, 'unknown outcome was not fabricated into a history classification');
    const recovery = persisted.tasks.find(item => item.planningDecisionId === planId && item.id !== 'task-150');
    const blocked = persisted.tasks.find(item => item.recoveryPlanId === planId && item.agentName === 'troubleshooter');
    assert.ok(recovery?.state === 'QUEUED' && recovery.resolution?.targetTaskId === 'task-150'
      || blocked?.state === 'BLOCKED' && blocked.result?.data?.evidence && blocked.result?.data?.unblock_conditions,
    'accepted candidate must either provide safe executable recovery or an evidence-backed block');
    assert.notEqual(persisted.state, 'COMPLETED', 'unknown historical execution cannot yield false completion');
  } finally {
    process.env.PATH = originalEnv.path;
    if (originalEnv.store === undefined) delete process.env.AGENTS_RELAY_STORE_DIR;
    else process.env.AGENTS_RELAY_STORE_DIR = originalEnv.store;
    store.close();
    if (process.env.RELAY_L2_KEEP_FIXTURE !== '1') await rm(root, { recursive: true, force: true });
  }
});
