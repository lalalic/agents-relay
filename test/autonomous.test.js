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
import { MemoryEventBus, eventFor } from '../dist/events.js';

const now = () => new Date().toISOString();
const route = { provider: 'openai', model: 'gpt-5', decidedBy: 'test', decidedAt: now() };
const output = { kind: 'task_pr' };
const task = (id, state = 'QUEUED') => ({ jobId: 'auto', id, kind: 'work', parentTaskId: null, dependencies: [], capabilities: [], adapter: 'codex', input: 'do the described work', output, routing: route, state, attempt: 0, maxAttempts: 1, leaseOwner: null, leaseExpiresAt: null, executionId: null, threadId: null, result: null, error: null, timeoutMs: 1000, createdAt: now(), updatedAt: now(), continuation: null, continuationDeliveredAt: null });
const job = (tasks = [], executionMode = 'autonomous') => ({ id: 'auto', title: 'Objective', objective: 'finish the objective', executionMode, prNumber: 1, repository: 'owner/repo', state: 'OPEN', continuation: null, createdAt: now(), updatedAt: now(), tasks });
const spec = id => ({ id, input: 'do the described work', adapter: 'codex', output, routing: route });
function executionHarness(bus) {
  return {
    name: 'codex',
    id: 'test-codex',
    capabilities: ['model','codex'],
    launch(current) {
      queueMicrotask(() => bus.publish(eventFor('auto', current.id, current.parentTaskId, 'task.completed', 'succeeded', `completed ${current.id}`, 'orchestrator')));
      return { id: `exec-${current.id}`, promise: Promise.resolve({ summary: 'runtime exited' }), cancel() {} };
    },
  };
}
async function settle(reconciler, count = 8) { for (let index = 0; index < count; index += 1) { await reconciler.reconcile('auto'); await reconciler.idle(); await new Promise(resolve => setTimeout(resolve, 0)); } }

test('execution mode and planner result markers round-trip', () => {
  const autonomous = job();
  assert.equal(parseJob(renderJobComment(autonomous)).executionMode, 'autonomous');
  const legacy = { ...autonomous }; delete legacy.executionMode;
  assert.equal(parseJob(marker(JOB_MARKER, legacy)).executionMode, 'fixed');
  const planner = { ...task('planner-1'), kind: 'planner', plannerResult: { objective_status: 'in_progress', assessment: 'need work', next_tasks: [spec('work-1')] } };
  assert.equal(parseTask(marker(TASK_MARKER, planner)).plannerResult.next_tasks[0].id, 'work-1');
  assert.equal(parsePlannerOutput('{"objective_status":"satisfied","assessment":"done","next_tasks":[]}').objective_status, 'satisfied');
  assert.throws(() => parsePlannerResult({ objective_status: 'satisfied', assessment: 'bad', next_tasks: [spec('duplicate'), spec('duplicate')] }), /duplicate/);
  assert.equal(executionMode(['--mode', 'autonomous']), 'autonomous');
  assert.equal(executionMode([]), 'fixed');
  assert.match(dashboardHtml, /Execution mode/);
});

test('planner rejects command-like shell tasks and requires output', () => {
  assert.throws(() => parsePlannerResult({ objective_status:'in_progress', assessment:'x', next_tasks:[{id:'x',input:'npm test',adapter:'shell'}] }), /codex or chatgpt/);
  assert.throws(() => parsePlannerResult({ objective_status:'in_progress', assessment:'x', next_tasks:[{id:'x',input:'work',adapter:'codex'}] }), /output is required/);
});

test('default planner agent loads markdown instructions and returns typed planning JSON', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-relay-planner-agent-'));
  try {
    const command = join(root, 'model-runtime');
    const agentFile = join(root, 'planner.agent.md');
    await writeFile(agentFile, '# Planner Agent\nReturn JSON only.\n');
    await writeFile(command, ['#!/bin/sh', "printf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"{\\\"objective_status\\\":\\\"satisfied\\\",\\\"assessment\\\":\\\"done\\\",\\\"next_tasks\\\":[]}\"}}'"].join('\n'), { mode: 0o700 });
    await chmod(command, 0o700);
    const planner = new AgentObjectivePlanner(command, agentFile);
    assert.equal((await planner.plan({ job: job(), tasks: [], objective: 'finish', previousPlannerTaskId: null }, new AbortController().signal)).objective_status, 'satisfied');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('fixed and autonomous jobs complete from terminal events, not adapter exit', async () => {
  for (const mode of ['fixed','autonomous']) {
    const bus = new MemoryEventBus();
    const store = new InMemoryStore(job(mode === 'fixed' ? [task('fixed-work')] : [], mode));
    let calls = 0;
    const planner = { plan: async () => { calls += 1; return calls === 1 ? { objective_status:'in_progress', assessment:'work', next_tasks:[spec('work-1')] } : { objective_status:'satisfied', assessment:'done', next_tasks:[] }; } };
    const reconciler = new Reconciler(store, { owner:'test', adapters:[executionHarness(bus)], planner, eventBus:bus });
    const stop = await reconciler.watch('auto');
    await settle(reconciler);
    const result = await store.load('auto');
    assert.equal(result.state, 'COMPLETED');
    if (mode === 'fixed') assert.equal(calls, 0);
    else assert.equal(result.tasks.find(t=>t.id==='work-1')?.state, 'SUCCEEDED');
    await stop();
  }
});

test('planner satisfaction cannot bypass failed or blocked completion gates', () => {
  const satisfied = { ...task('planner-1', 'SUCCEEDED'), kind: 'planner', plannerResult: { objective_status: 'satisfied', assessment: 'done', next_tasks: [] } };
  assert.equal(schedule({ ...job([satisfied, { ...task('failed', 'FAILED'), error: 'unresolved' }]), state: 'RUNNING' }).state, 'FAILED');
  assert.equal(schedule({ ...job([satisfied, { ...task('blocked', 'BLOCKED') }]), state: 'RUNNING' }).state, 'BLOCKED');
});
