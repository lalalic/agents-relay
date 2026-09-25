import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, realpath, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InMemoryStore } from '../dist/store.js';
import { marker, JOB_MARKER, TASK_MARKER, parseJob, parseTask, renderJobComment } from '../dist/markers.js';
import { AgentObjectivePlanner, normalizePlannerPriority, parsePlannerOutput, parsePlannerResult } from '../dist/planner.js';
import { storySizeTimeoutMs, taskOverallTimeoutMs, chatGptStartAckTimeoutMs } from '../dist/types.js';
import { Reconciler, executionEventSource } from '../dist/reconciler.js';
import { schedule } from '../dist/scheduler.js';
import { deriveJobRuntimeStatus } from '../dist/runtime-status.js';
import { executionMode } from '../dist/cli.js';
import { dashboardHtml } from '../dist/dashboard.js';
import { MemoryEventBus, eventFor } from '../dist/events.js';

const now = () => new Date().toISOString();
const route = { provider: 'openai', model: 'gpt-5', decidedBy: 'test', decidedAt: now() };
const output = { kind: 'task_pr' };
const task = (id, state = 'QUEUED') => ({ jobId: 'auto', id, kind: 'work', parentTaskId: null, dependencies: [], capabilities: [], adapter: 'codex', input: 'do the described work', output, routing: route, state, attempt: 0, maxAttempts: 1, leaseOwner: null, leaseExpiresAt: null, executionId: null, threadId: null, result: null, error: null, timeoutMs: 1000, createdAt: now(), updatedAt: now(), continuation: null, continuationDeliveredAt: null });
const job = (tasks = [], executionMode = 'autonomous') => ({ id: 'auto', title: 'Objective', objective: 'finish the objective', executionMode, prNumber: 1, repository: 'owner/repo', state: 'ACTIVE', continuation: null, createdAt: now(), updatedAt: now(), tasks });
const spec = id => ({ id, input: 'do the described work', adapter: 'codex', workerRequirements: { capabilities: ['model'] }, output, routing: route });
function startedAutonomousJob() {
  const seed = { ...task('seed', 'SUCCEEDED'), result: { summary: 'seed complete' } };
  return job([seed]);
}
function executionHarness(bus) {
  return {
    name: 'codex',
    id: 'test-codex',
    capabilities: ['model','codex'],
    launch(current) {
      queueMicrotask(async () => {
        const source = { id: executionEventSource('auto', current.id, current.executionId) };
        await bus.publish(eventFor('auto', current.id, current.parentTaskId, 'task.started', 'running', `started ${current.id}`, 'user', undefined, source));
        await bus.publish(eventFor('auto', current.id, current.parentTaskId, 'task.completed', 'succeeded', `completed ${current.id}`, 'orchestrator', undefined, source));
      });
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

test('planner preserves worker requirements for worker-router selection', () => {
  const result = parsePlannerResult({ objective_status: 'in_progress', assessment: 'work', next_tasks: [{
    id: 'resource-aware', input: 'do work', adapter: 'codex', output,
    workerRequirements: { capabilities: ['model', 'browser-harness'], runtime: 'hosted', taskKind: 'research', labels: { region: 'ca' } },
  }] });
  assert.deepEqual(result.next_tasks[0].workerRequirements, { capabilities: ['model', 'browser-harness'], runtime: 'hosted', taskKind: 'research', trustDomain: undefined, region: undefined, labels: { region: 'ca' } });
});

test('planner priority normalization preserves canonical values and accepts safe aliases', () => {
  assert.equal(normalizePlannerPriority('P0', 'next_tasks[0].priority'), 'P0');
  assert.equal(normalizePlannerPriority('p1', 'next_tasks[0].priority'), 'P1');
  assert.equal(normalizePlannerPriority(' P2 ', 'next_tasks[0].priority'), 'P2');
  assert.equal(normalizePlannerPriority(3, 'next_tasks[0].priority'), 'P3');
  assert.equal(normalizePlannerPriority('0', 'next_tasks[0].priority'), 'P0');
  assert.throws(() => normalizePlannerPriority('high', 'next_tasks[0].priority'), /priority is invalid.*"high"/);
  assert.throws(() => normalizePlannerPriority(4, 'next_tasks[0].priority'), /priority is invalid.*4/);
});

test('planner result with a formatting-only priority variation creates a child task', async () => {
  const bus = new MemoryEventBus();
  const store = new InMemoryStore(startedAutonomousJob());
  let calls = 0;
  const planner = { plan: async () => ++calls === 1 ? ({ objective_status:'in_progress', assessment:'work', next_tasks:[{ ...spec('work-1'), priority:'p1' }] }) : ({ objective_status:'satisfied', assessment:'done', next_tasks:[] }) };
  const reconciler = new Reconciler(store, { owner:'test', adapters:[executionHarness(bus)], planner, eventBus:bus });
  const stop = await reconciler.watch('auto');
  await settle(reconciler, 8);
  const result = await store.load('auto');
  assert.equal(result.tasks.find(item => item.id === 'work-1')?.priority, 'P1');
  await stop();
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

test('default planner agent runs from the resolved project working directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-relay-planner-cwd-'));
  try {
    const command = join(root, 'model-runtime');
    const agentFile = join(root, 'planner.agent.md');
    await writeFile(agentFile, '# Planner Agent\nReturn JSON only.\n');
    await writeFile(command, ['#!/bin/sh', 'pwd > planner.cwd', "printf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"{\\\"objective_status\\\":\\\"satisfied\\\",\\\"assessment\\\":\\\"done\\\",\\\"next_tasks\\\":[]}\"}}'"].join('\n'), { mode: 0o700 });
    await chmod(command, 0o700);
    const planner = new AgentObjectivePlanner(command, agentFile);
    const executionContext = {
      project: { name: 'project', path: root, workspaceRoot: root, neoRoot: null, globalRoot: root },
      role: 'planner',
      instructions: [],
      skills: [],
      agents: [],
      runtimes: [],
      delegation: { mode: 'relay-child-task', parentTaskIdRequired: false }
    };
    const result = await planner.plan({ job: job(), tasks: [], objective: 'finish', previousPlannerTaskId: null, executionContext }, new AbortController().signal);
    assert.equal(result.objective_status, 'satisfied');
    assert.equal((await readFile(join(root, 'planner.cwd'), 'utf8')).trim(), await realpath(root));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('fixed and autonomous work reaches runtime review after terminal events, not adapter exit', async () => {
  for (const mode of ['fixed','autonomous']) {
    const bus = new MemoryEventBus();
    const store = new InMemoryStore(mode === 'fixed' ? job([task('fixed-work')], mode) : startedAutonomousJob());
    let calls = 0;
    const planner = { plan: async () => { calls += 1; return calls === 1 ? { objective_status:'in_progress', assessment:'work', next_tasks:[spec('work-1')] } : { objective_status:'satisfied', assessment:'done', next_tasks:[] }; } };
    const reconciler = new Reconciler(store, { owner:'test', adapters:[executionHarness(bus)], planner, eventBus:bus });
    const stop = await reconciler.watch('auto');
    await settle(reconciler);
    const result = await store.load('auto');
    assert.equal(result.state, 'ACTIVE');
    assert.equal(deriveJobRuntimeStatus(result, 'OPEN'), 'REVIEWING');
    if (mode === 'fixed') assert.equal(calls, 0);
    else assert.equal(result.tasks.find(t=>t.id==='work-1')?.state, 'SUCCEEDED');
    await stop();
  }
});

test('planner satisfaction cannot bypass failed or blocked completion gates', () => {
  const satisfied = { ...task('planner-1', 'SUCCEEDED'), kind: 'planner', plannerResult: { objective_status: 'satisfied', assessment: 'done', next_tasks: [] } };
  const failed = schedule(job([satisfied, { ...task('failed', 'FAILED'), error: 'unresolved' }]));
  const blocked = schedule(job([satisfied, { ...task('blocked', 'BLOCKED') }]));
  assert.equal(failed.state, 'ACTIVE');
  assert.equal(deriveJobRuntimeStatus(failed, 'OPEN'), 'FAILED');
  assert.equal(blocked.state, 'ACTIVE');
  assert.equal(deriveJobRuntimeStatus(blocked, 'OPEN'), 'BLOCKED');
});


test('story sizes map only the overall execution timeout', () => {
  assert.equal(storySizeTimeoutMs('S'),300000);
  assert.equal(storySizeTimeoutMs('M'),900000);
  assert.equal(storySizeTimeoutMs('L'),2700000);
  assert.equal(taskOverallTimeoutMs('M','high'),1800000);
  assert.equal(taskOverallTimeoutMs('L','high'),5400000);
  assert.equal(taskOverallTimeoutMs('M','medium'),900000);
  assert.equal(chatGptStartAckTimeoutMs(300000),120000);
  assert.equal(chatGptStartAckTimeoutMs(900000),300000);
  assert.equal(chatGptStartAckTimeoutMs(2700000),600000);
  assert.equal(chatGptStartAckTimeoutMs(1800000),600000);
  const sized=parsePlannerResult({objective_status:'in_progress',assessment:'size',next_tasks:[{id:'large',input:'work',adapter:'codex',output:{kind:'task_pr'},storySize:'L'}]});
  assert.equal(sized.next_tasks[0].storySize,'L');
  assert.equal(sized.next_tasks[0].timeoutMs,2700000);
  const defaulted=parsePlannerResult({objective_status:'in_progress',assessment:'default',next_tasks:[{id:'medium',input:'work',adapter:'codex',output:{kind:'task_pr'}}]});
  assert.equal(defaulted.next_tasks[0].storySize,'M');
  assert.equal(defaulted.next_tasks[0].timeoutMs,900000);
});


test('planner doubles story-size timeout only for high reasoning', () => {
  const high=parsePlannerResult({objective_status:'in_progress',assessment:'high',next_tasks:[{id:'high',input:'work',adapter:'codex',output:{kind:'task_pr'},storySize:'M',routing:{provider:'openai',model:'gpt-test',reasoning:'high',decidedBy:'test',decidedAt:new Date().toISOString()}}]});
  assert.equal(high.next_tasks[0].timeoutMs,1800000);
  const normal=parsePlannerResult({objective_status:'in_progress',assessment:'normal',next_tasks:[{id:'normal',input:'work',adapter:'codex',output:{kind:'task_pr'},storySize:'M',routing:{provider:'openai',model:'gpt-test',reasoning:'medium',decidedBy:'test',decidedAt:new Date().toISOString()}}]});
  assert.equal(normal.next_tasks[0].timeoutMs,900000);
});
