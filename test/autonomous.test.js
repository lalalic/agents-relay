import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InMemoryStore } from '../dist/store.js';
import { marker, JOB_MARKER, TASK_MARKER, parseJob, parseTask, renderJobComment } from '../dist/markers.js';
import { AgentObjectivePlanner, parsePlannerOutput, parsePlannerResult } from '../dist/planner.js';
import { Reconciler } from '../dist/reconciler.js';
import { schedule } from '../dist/scheduler.js';
import { executionMode } from '../dist/cli.js';
import { dashboardHtml } from '../dist/dashboard.js';

const now = () => new Date().toISOString();
const task = (id, state = 'QUEUED') => ({ jobId: 'auto', id, kind: 'work', parentTaskId: null, dependencies: [], capabilities: [], adapter: 'shell', input: 'true', state, attempt: 0, maxAttempts: 1, leaseOwner: null, leaseExpiresAt: null, executionId: null, threadId: null, result: null, error: null, timeoutMs: 1000, createdAt: now(), updatedAt: now(), continuation: null, continuationDeliveredAt: null });
const job = (tasks = [], executionMode = 'autonomous') => ({ id: 'auto', title: 'Objective', objective: 'finish the objective', executionMode, prNumber: 0, repository: '', state: 'OPEN', continuation: null, createdAt: now(), updatedAt: now(), tasks });
const adapter = { name: 'shell', id: 'test-shell', capabilities: ['shell'], launch: current => ({ id: `exec-${current.id}`, promise: Promise.resolve({ summary: 'done' }), cancel: () => {} }) };
async function settle(reconciler, count = 8) { for (let index = 0; index < count; index += 1) { await reconciler.reconcile('auto'); await reconciler.idle(); } }

test('execution mode and planner result markers round-trip, with legacy jobs fixed by default', () => {
  const autonomous = job();
  assert.equal(parseJob(renderJobComment(autonomous)).executionMode, 'autonomous');
  const legacy = { ...autonomous }; delete legacy.executionMode;
  assert.equal(parseJob(marker(JOB_MARKER, legacy)).executionMode, 'fixed');
  const planner = { ...task('planner-1'), kind: 'planner', plannerResult: { objective_status: 'in_progress', assessment: 'need work', next_tasks: [{ id: 'work-1', input: 'true' }] } };
  assert.equal(parseTask(marker(TASK_MARKER, planner)).plannerResult.next_tasks[0].id, 'work-1');
  assert.equal(parsePlannerOutput('```json\n{"objective_status":"satisfied","assessment":"done","next_tasks":[]}\n```').objective_status, 'satisfied');
  assert.throws(() => parsePlannerResult({ objective_status: 'satisfied', assessment: 'bad', next_tasks: [{ id: 'duplicate', input: 'x' }, { id: 'duplicate', input: 'y' }] }), /duplicate/);
  assert.equal(executionMode(['--mode', 'autonomous']), 'autonomous');
  assert.equal(executionMode([]), 'fixed');
  assert.match(dashboardHtml, /Execution mode/);
  assert.match(dashboardHtml, /executionMode\|\|'fixed'/);
});

test('default planner agent loads markdown instructions and returns typed planning JSON', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-relay-planner-agent-'));
  try {
    const command = join(root, 'model-runtime');
    const agentFile = join(root, 'planner.agent.md');
    await writeFile(agentFile, '# Planner Agent\nReturn JSON only.\n');
    await writeFile(command, [
      '#!/bin/sh',
      "printf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"{\\\"objective_status\\\":\\\"satisfied\\\",\\\"assessment\\\":\\\"done\\\",\\\"next_tasks\\\":[]}\"}}'",
    ].join('\n'), { mode: 0o700 });
    await chmod(command, 0o700);
    const planner = new AgentObjectivePlanner(command, agentFile);
    const result = await planner.plan({ job: job(), tasks: [], objective: 'finish', previousPlannerTaskId: null }, new AbortController().signal);
    assert.deepEqual(result, { objective_status: 'satisfied', assessment: 'done', next_tasks: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fixed jobs remain backward compatible and never create planner tasks', async () => {
  const fixed = job([task('fixed-work')], 'fixed');
  const store = new InMemoryStore(fixed);
  let plannerCalls = 0;
  const reconciler = new Reconciler(store, { owner: 'fixed-test', adapters: [adapter], planner: { plan: async () => { plannerCalls += 1; return { objective_status: 'satisfied', assessment: 'unexpected', next_tasks: [] }; } } });
  await settle(reconciler, 2);
  const result = await store.load('auto');
  assert.equal(result.executionMode, 'fixed');
  assert.equal(result.tasks.some(item => item.kind === 'planner'), false);
  assert.equal(plannerCalls, 0);
  assert.equal(result.tasks[0].state, 'SUCCEEDED');
});

test('autonomous reconciliation grows the real parent/subtask tree and completes after satisfaction', async () => {
  const store = new InMemoryStore(job());
  let calls = 0;
  const planner = { plan: async () => { calls += 1; return calls === 1 ? { objective_status: 'in_progress', assessment: 'work remains', next_tasks: [{ id: 'work-1', input: 'true' }] } : { objective_status: 'satisfied', assessment: 'objective complete', next_tasks: [] }; } };
  const reconciler = new Reconciler(store, { owner: 'auto-test', adapters: [adapter], planner });
  await settle(reconciler);
  const result = await store.load('auto');
  const plannerOne = result.tasks.find(item => item.id === 'planner-1');
  const work = result.tasks.find(item => item.id === 'work-1');
  const plannerTwo = result.tasks.find(item => item.id === 'planner-2');
  assert.equal(result.state, 'COMPLETED');
  assert.equal(calls, 2);
  assert.equal(plannerOne?.kind, 'planner');
  assert.equal(plannerOne?.agentName, 'planner');
  assert.equal(work?.parentTaskId, 'planner-1');
  assert.equal(plannerTwo?.parentTaskId, 'planner-1');
  assert.equal(plannerTwo?.plannerResult?.objective_status, 'satisfied');
});

test('autonomous planner creation and stable next task IDs are idempotent', async () => {
  const store = new InMemoryStore(job());
  let calls = 0;
  const planner = { plan: async () => { calls += 1; return calls === 1 ? { objective_status: 'in_progress', assessment: 'work remains', next_tasks: [{ id: 'stable-work', input: 'true' }] } : { objective_status: 'satisfied', assessment: 'done', next_tasks: [{ id: 'stable-work', input: 'true' }] }; } };
  const reconciler = new Reconciler(store, { owner: 'idempotency-test', adapters: [adapter], planner });
  await settle(reconciler, 3);
  const first = await store.load('auto');
  await settle(reconciler, 3);
  const second = await store.load('auto');
  assert.equal(calls, 2);
  assert.equal(second.tasks.filter(item => item.id === 'stable-work').length, 1);
  assert.equal(first.tasks.filter(item => item.kind === 'planner').length, second.tasks.filter(item => item.kind === 'planner').length);
});

test('restart recovery reclaims a durable planner lease without relaunching duplicate work', async () => {
  const plannerTask = { ...task('planner-1', 'RUNNING'), kind: 'planner', parentTaskId: null, attempt: 1, maxAttempts: 2, leaseOwner: 'old-daemon', leaseExpiresAt: new Date(Date.now() + 600000).toISOString(), executionId: 'old-execution', input: '{}', capabilities: ['planner'] };
  const store = new InMemoryStore({ ...job([plannerTask]), state: 'RUNNING' });
  let calls = 0;
  const reconciler = new Reconciler(store, { owner: 'new-daemon', adapters: [adapter], planner: { plan: async () => { calls += 1; return { objective_status: 'satisfied', assessment: 'recovered', next_tasks: [] }; } } });
  await settle(reconciler, 3);
  const result = await store.load('auto');
  assert.equal(calls, 1);
  assert.equal(result.state, 'COMPLETED');
  assert.equal(result.tasks.filter(item => item.kind === 'planner').length, 1);
  assert.equal(result.tasks[0].attempt, 2);
});

test('planner satisfaction cannot bypass failed or blocked completion gates', () => {
  const satisfied = { ...task('planner-1', 'SUCCEEDED'), kind: 'planner', plannerResult: { objective_status: 'satisfied', assessment: 'done', next_tasks: [] } };
  const failed = schedule({ ...job([satisfied, { ...task('failed', 'FAILED'), error: 'unresolved' }]), state: 'RUNNING' });
  assert.equal(failed.state, 'FAILED');
  const blocked = schedule({ ...job([satisfied, { ...task('blocked', 'BLOCKED') }]), state: 'RUNNING' });
  assert.equal(blocked.state, 'BLOCKED');
});
