import assert from 'node:assert/strict';
import test, { managedReconciler } from './test-runtime.js';
import { mkdtemp, writeFile, readFile, realpath, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InMemoryStore } from '../dist/store.js';
import { marker, JOB_MARKER, TASK_MARKER, parseJob, parseTask, renderJobComment } from '../dist/markers.js';
import { AgentObjectivePlanner, createPlannerRoundTask, normalizePlannerPriority, parsePlannerOutput, parsePlannerResult, plannerInput } from '../dist/planner.js';
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



test('new planning rounds use plan-N while historical planner-N remains readable', () => {
  const historical = { ...task('planner-1', 'SUCCEEDED'), kind: 'planner', planningRound: 1, plannerResult: { objective_status: 'satisfied', assessment: 'legacy', next_tasks: [] } };
  const round = createPlannerRoundTask(job([historical]), { guidance: 're-plan from durable state', manual: true, now: '2026-09-26T12:00:00.000Z' });
  assert.equal(round.id, 'plan-2');
  assert.equal(round.parentTaskId, 'planner-1');
  assert.equal(round.planningDecisionId, 'plan-2');
  assert.equal(round.planningRound, 2);
  assert.equal(round.plannerGuidance, 're-plan from durable state');
  assert.equal(round.manualPlanning, true);
  assert.equal(JSON.parse(round.input).caller_prompt, 're-plan from durable state');
});

test('manual plan runs on a zero-task DRAFT job and persists routed-later child provenance', async () => {
  const root = { ...job([], 'fixed'), state: 'DRAFT' };
  const store = new InMemoryStore(root);
  let observed;
  const planner = { plan: async context => { observed = context; return { objective_status: 'in_progress', assessment: 'need implementation', next_tasks: [{ id: 'implement', input: 'implement the objective', output, storySize: 'S', workerRequirements: { capabilities: ['model'] } }] }; } };
  const reconciler = managedReconciler(store, { owner: 'test', adapters: [], planner, maxConcurrent: 0 });
  const result = await reconciler.planJob('auto', 'focus on the durable objective');
  assert.equal(result.round.id, 'plan-1');
  assert.equal(result.round.state, 'SUCCEEDED');
  assert.equal(result.round.plannerResult.objective_status, 'in_progress');
  assert.equal(result.job.state, 'ACTIVE');
  assert.equal(observed.objective, 'finish the objective');
  assert.equal(observed.guidance, 'focus on the durable objective');
  const child = result.job.tasks.find(item => item.id === 'implement');
  assert.ok(child);
  assert.equal(child.parentTaskId, 'plan-1');
  assert.equal(child.planningDecisionId, 'plan-1');
  assert.equal(child.planningSource, 'model-planner');
  assert.equal(child.planningRound, 1);
  assert.equal(child.workerSelection, undefined);
  assert.equal(child.routing, undefined);
});

test('manual satisfied plan persists the planning round without creating work', async () => {
  const store = new InMemoryStore({ ...job([], 'fixed'), state: 'DRAFT' });
  const reconciler = managedReconciler(store, { owner: 'test', adapters: [], maxConcurrent: 0, planner: { plan: async () => ({ objective_status: 'satisfied', assessment: 'already complete', next_tasks: [] }) } });
  const result = await reconciler.planJob('auto');
  assert.equal(result.round.id, 'plan-1');
  assert.equal(result.round.plannerResult.objective_status, 'satisfied');
  assert.equal(result.job.tasks.filter(item => item.kind !== 'planner').length, 0);
});

test('manual plan rejects a concurrent active planning round', async () => {
  const active = createPlannerRoundTask(job([], 'fixed'), { manual: true });
  const store = new InMemoryStore({ ...job([active], 'fixed'), state: 'ACTIVE' });
  const reconciler = managedReconciler(store, { owner: 'test', adapters: [], maxConcurrent: 0, planner: { plan: async () => ({ objective_status: 'satisfied', assessment: 'done', next_tasks: [] }) } });
  await assert.rejects(() => reconciler.planJob('auto'), /already QUEUED/);
});

test('malformed manual planner output fails the round without materializing children', async () => {
  const store = new InMemoryStore({ ...job([], 'fixed'), state: 'DRAFT' });
  const reconciler = managedReconciler(store, { owner: 'test', adapters: [], maxConcurrent: 0, planner: { plan: async () => ({ objective_status: 'in_progress', assessment: 'bad', next_tasks: [{ id: 'broken', input: 'work without output' }] }) } });
  await assert.rejects(() => reconciler.planJob('auto'), /output is required/);
  const saved = await store.load('auto');
  assert.equal(saved.tasks.some(item => item.id === 'broken'), false);
  assert.equal(saved.tasks.find(item => item.id === 'plan-1')?.state, 'FAILED');
});
test('planner input carries explicit retry feedback for corrective retries', () => {
  const payload = JSON.parse(plannerInput({
    job: { id:'j', title:'j', executionMode:'autonomous', prNumber:1, repository:'owner/repo', state:'ACTIVE', continuation:null, createdAt:new Date().toISOString(), updatedAt:new Date().toISOString(), tasks:[] },
    tasks: [],
    objective: 'make content',
    previousPlannerTaskId: null,
    retryFeedback: 'Planner next_tasks[0].output is required',
  }));
  assert.equal(payload.retry_feedback, 'Planner next_tasks[0].output is required');
});

test('planner input stays compact with a large execution context and planner history', () => {
  const huge = 'x'.repeat(70000);
  const context = {
    project: { name:'neo-build-log', path:'/tmp/neo/neo-build-log', workspaceRoot:'/tmp/neo', neoRoot:'/tmp/neo', globalRoot:'/tmp' },
    role:'planner',
    instructions:[{path:'/tmp/huge',content:huge}],
    skills:[{name:'huge-skill',description:huge,path:'/tmp/skill'}],
    agents:[{name:'build-log-editor',description:huge,capabilities:['content'],restrictions:[],runtime:'codex',path:'/tmp/editor'}],
    runtimes:[],
    delegation:{mode:'relay-child-task',parentTaskIdRequired:false},
  };
  const priorPlanner={...task('planner-old','FAILED'),kind:'planner',input:huge,error:huge,plannerResult:{objective_status:'in_progress',assessment:huge,next_tasks:[spec('episode')]}};
  const payloadText=plannerInput({job:job([priorPlanner]),tasks:[priorPlanner],objective:'make content',previousPlannerTaskId:'planner-old',executionContext:context,retryFeedback:'bad output'});
  const payload=JSON.parse(payloadText);
  assert.equal(payload.execution_context, undefined);
  assert.equal(payload.project.name, 'neo-build-log');
  assert.deepEqual(payload.visible_agents.map(agent => agent.name), ['build-log-editor']);
  assert.equal(payload.tasks[0].input, undefined);
  assert.deepEqual(payload.tasks[0].planner_result.next_task_ids, ['episode']);
  assert.equal(payloadText.includes(huge), false);
  assert.ok(payloadText.length < 20000, `planner input too large: ${payloadText.length}`);
});

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
  assert.match(dashboardHtml, /Cadence/);
  assert.match(dashboardHtml, /function cadence\(job\)/);
  assert.match(dashboardHtml, /Every '\+everyMinute\[1\]\+' min/);
});

test('planner parses authoritative reverse cross-job unblocks and rejects malformed declarations', () => {
  const result=parsePlannerResult({objective_status:'in_progress',assessment:'wait',unblocks:[{repository:'org/app',prNumber:42,jobId:'dependent',taskId:'consume',resolutionMode:'merge'}],next_tasks:[]});
  assert.deepEqual(result.unblocks,[{repository:'org/app',prNumber:42,jobId:'dependent',taskId:'consume',resolutionMode:'merge'}]);
  assert.throws(()=>parsePlannerResult({objective_status:'in_progress',assessment:'bad',unblocks:[{repository:'bad',prNumber:42,jobId:'dependent',taskId:'consume'}],next_tasks:[]}),/repository must be OWNER\/REPO/);
  assert.throws(()=>parsePlannerResult({objective_status:'in_progress',assessment:'bad',unblocks:[{repository:'org/app',prNumber:0,jobId:'dependent',taskId:'consume'}],next_tasks:[]}),/positive integer/);
});

test('planner persistence delegates reverse unblock registration to durable store', async () => {
  const store=new InMemoryStore({...job([], 'fixed'),state:'DRAFT'});
  const seen=[];
  store.registerBlockerDependent=async (jobId, dependent)=>{ seen.push({jobId,dependent}); };
  const planner={plan:async()=>({objective_status:'satisfied',assessment:'blocked relation only',unblocks:[{repository:'org/app',prNumber:42,jobId:'dependent',taskId:'consume',resolutionMode:'merge'}],next_tasks:[]})};
  const reconciler=managedReconciler(store,{owner:'test',adapters:[],maxConcurrent:0,planner});
  await reconciler.planJob('auto');
  assert.deepEqual(seen,[{jobId:'auto',dependent:{repository:'org/app',prNumber:42,jobId:'dependent',taskId:'consume',resolutionMode:'merge'}}]);
});

test('planner rejects command-like shell tasks and requires output', () => {
  assert.throws(() => parsePlannerResult({ objective_status:'in_progress', assessment:'x', next_tasks:[{id:'x',input:'npm test',adapter:'shell'}] }), /codex or chatgpt/);
  assert.throws(() => parsePlannerResult({ objective_status:'in_progress', assessment:'x', next_tasks:[{id:'x',input:'work',adapter:'codex'}] }), /output is required/);
});

test('planner reports malformed nested output precisely', () => {
  assert.throws(() => parsePlannerResult({ objective_status:'in_progress', assessment:'x', next_tasks:[{id:'x',input:'work',output:'file'}] }), /output must be an object/);
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

test('automatic planner retry carries prior failure and persists launch-time planner input', async () => {
  const store = new InMemoryStore(startedAutonomousJob());
  const seen = [];
  const planner = { plan: async context => {
    seen.push(context);
    if (seen.length === 1) throw new Error('Planner next_tasks[0].output is required');
    return { objective_status:'satisfied', assessment:'done', next_tasks:[] };
  } };
  const reconciler = managedReconciler(store, { owner:'test', adapters:[], planner });
  await settle(reconciler, 6);
  const result = await store.load('auto');
  const round = result.tasks.find(item => item.kind === 'planner');
  assert.equal(seen.length, 2);
  assert.equal(seen[1].retryFeedback, 'Planner next_tasks[0].output is required');
  assert.equal(JSON.parse(round.input).retry_feedback, 'Planner next_tasks[0].output is required');
  assert.equal(round.plannerRetryFeedback, undefined);
  assert.equal(round.state, 'SUCCEEDED');
});

test('planner result with a formatting-only priority variation creates a child task', async () => {
  const bus = new MemoryEventBus();
  const store = new InMemoryStore(startedAutonomousJob());
  let calls = 0;
  const planner = { plan: async () => ++calls === 1 ? ({ objective_status:'in_progress', assessment:'work', next_tasks:[{ ...spec('work-1'), priority:'p1' }] }) : ({ objective_status:'satisfied', assessment:'done', next_tasks:[] }) };
  const reconciler = managedReconciler(store, { owner:'test', adapters:[executionHarness(bus)], planner, eventBus:bus });
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
    const reconciler = managedReconciler(store, { owner:'test', adapters:[executionHarness(bus)], planner, eventBus:bus });
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


test('planner parser rejects malformed Agent Graph before child materialization', () => {
  assert.throws(() => parsePlannerResult({
    objective_status: 'in_progress',
    assessment: 'work',
    next_tasks: [{ id: 'bad-graph', input: 'work', output: { kind: 'task_pr' }, agentGraph: 'graph LR\na --> b' }],
  }), /next_tasks\[0\]\.agentGraph is invalid: Agent Graph must start with Mermaid flowchart/);
});
