import test, { managedReconciler } from './test-runtime.js';
import assert from 'node:assert/strict';
import { exhaustedTroubleshooterRecoveries, pendingTroubleshooterTasks, pendingTroubleshooterReopens, troubleshooterTaskId } from '../dist/troubleshooter.js';
import { InMemoryStore } from '../dist/store.js';
import { Reconciler } from '../dist/reconciler.js';
import { MemoryEventBus } from '../dist/events.js';
import { resolveExecutionContext, executionContextPrompt } from '../dist/execution-context.js';

const now = () => new Date().toISOString();

function failedReview() {
  return {
    jobId: 'neo-pr40',
    id: 'final-review-3a941f98a1ad',
    kind: 'work',
    priority: 'P1',
    storySize: 'M',
    projectName: 'Neo PR 40',
    agentName: 'reviewer',
    parentTaskId: null,
    dependencies: ['implementation'],
    capabilities: ['review'],
    workerSelection: {
      workerId: 'chatgpt/browser-worker',
      adapter: 'chatgpt',
      capabilities: ['model', 'browser-harness'],
      selectedBy: 'test',
      selectedAt: now(),
    },
    adapter: 'chatgpt',
    input: 'review exact head',
    output: { kind: 'task_pr' },
    routing: { provider: 'chatgpt', model: 'account-defaults', decidedBy: 'test', decidedAt: now() },
    state: 'FAILED',
    attempt: 1,
    maxAttempts: 2,
    leaseOwner: null,
    leaseExpiresAt: null,
    executionId: null,
    threadId: null,
    result: null,
    error: 'Worker delivery failed: Temporary Chat toggle was not uniquely observed',
    timeoutMs: 900000,
    createdAt: now(),
    updatedAt: now(),
    continuation: null,
    continuationDeliveredAt: null,
  };
}

function job(tasks) {
  return {
    id: 'neo-pr40',
    title: 'Neo PR 40',
    objective: 'finish the original job',
    reviewEnabled: true,
    autoMerge: true,
    prNumber: 40,
    repository: 'lalalic/neo',
    state: 'ACTIVE',
    continuation: null,
    createdAt: now(),
    updatedAt: now(),
    tasks,
  };
}

test('troubleshooter recovery is P0, evidence-rich, local-capable, and idempotent per failed attempt', () => {
  const failed = failedReview();
  const [recovery] = pendingTroubleshooterTasks(job([failed]));
  assert.equal(recovery.id, troubleshooterTaskId(failed));
  assert.equal(recovery.agentName, 'troubleshooter');
  assert.equal(recovery.parentTaskId, failed.id);
  assert.equal(recovery.priority, 'P0');
  assert.deepEqual(recovery.workerRequirements, {
    capabilities: ['model', 'local_repo', 'iterative_tools'],
    runtime: 'codex',
  });
  assert.match(recovery.input, /chatgpt\/browser-worker/);
  assert.match(recovery.input, /Temporary Chat toggle was not uniquely observed/);
  assert.match(recovery.input, /P0\/self-job/);
  assert.match(recovery.input, /MANDATORY EVENT EVIDENCE BEFORE DIAGNOSIS/);
  assert.match(recovery.input, /api\/events\?job=neo-pr40&task=final-review-3a941f98a1ad&limit=200/);
  assert.match(recovery.input, /duplicate events/);
  assert.match(recovery.input, /Do not treat the final task\.error string as the complete root cause/);
  assert.match(recovery.input, /agents-relay escalation/);
  assert.match(recovery.input, /canonical escalation graph invokes Neo escalation and owns the resolved\/failed\/needs_user branch/);
  assert.deepEqual(pendingTroubleshooterTasks(job([failed, recovery])), []);
});


test('active recovery suppresses a new troubleshooter when the root attempt increases', () => {
  const failed = failedReview();
  const [recovery] = pendingTroubleshooterTasks(job([failed]));
  recovery.state = 'RUNNING';

  const retriedFailure = {
    ...failed,
    attempt: failed.attempt + 1,
    executionId: 'exec-next',
    error: 'same deterministic delivery failure after retry',
    updatedAt: now(),
  };
  assert.equal(troubleshooterTaskId(retriedFailure), recovery.id);
  assert.deepEqual(pendingTroubleshooterTasks(job([retriedFailure, recovery])), []);
});

test('legacy active recovery without parent linkage still suppresses duplicate root recovery', () => {
  const failed = failedReview();
  const [recovery] = pendingTroubleshooterTasks(job([failed]));
  recovery.parentTaskId = null;
  recovery.state = 'BLOCKED';

  const retriedFailure = { ...failed, attempt: 2, updatedAt: now() };
  assert.deepEqual(pendingTroubleshooterTasks(job([retriedFailure, recovery])), []);
});

test('failed prior recovery suppresses another automatic recovery generation', () => {
  const failed = failedReview();
  const [recovery] = pendingTroubleshooterTasks(job([failed]));
  recovery.state = 'FAILED';

  const retriedFailure = { ...failed, attempt: 2, updatedAt: now() };
  assert.deepEqual(pendingTroubleshooterTasks(job([retriedFailure, recovery])), []);
});

test('successful prior recovery is reopened rather than creating another Task', () => {
  const failed = failedReview();
  const [recovery] = pendingTroubleshooterTasks(job([failed]));
  recovery.state = 'SUCCEEDED';

  const retriedFailure = { ...failed, attempt: 2, updatedAt: now() };
  assert.deepEqual(pendingTroubleshooterTasks(job([retriedFailure, recovery])), []);
  const [next] = pendingTroubleshooterReopens(job([retriedFailure, recovery]));
  assert.equal(next.recovery.id, recovery.id);
  assert.equal(next.original.id, failed.id);
});

test('one durable Troubleshooter reopens for a subsequent failed attempt', async () => {
  const original = failedReview();
  const [recovery] = pendingTroubleshooterTasks(job([original]));
  recovery.state = 'SUCCEEDED';
  const again = { ...original, attempt: 2, error: 'second separate delivery failure' };
  const store = new InMemoryStore(job([again, recovery]));
  const emitted = [];
  const reconciler = managedReconciler(store, { owner: 'test', adapters: [], maxConcurrent: 0, emit: event => emitted.push(event) });
  await reconciler.reconcile(original.jobId);
  await reconciler.reconcile(original.jobId);
  const result = await store.load(original.jobId);
  const recoveries = result.tasks.filter(t => t.agentName === 'troubleshooter');
  assert.equal(recoveries.length, 1);
  assert.equal(recoveries[0].id, recovery.id);
  assert.equal(recoveries[0].state, 'QUEUED');
  assert.equal(recoveries[0].recoveryForAttempt, 2);
  assert.match(recoveries[0].input, /second separate delivery failure/);
  assert.equal(emitted.filter(e => e.type === 'troubleshooter.reopened').length, 1);
  assert.equal(emitted.filter(e => e.type === 'troubleshooter.created').length, 0);
});

test('legacy cancelled recovery can be reused without creating a third recovery', async () => {
  const original = { ...failedReview(), attempt: 3 };
  const [first] = pendingTroubleshooterTasks(job([{...original,attempt:1}]));
  first.id = `troubleshoot-${original.id}-a1`;
  first.state = 'SUCCEEDED';
  first.recoveryForAttempt = undefined;
  const second = { ...first, id: `troubleshoot-${original.id}-a2`, state: 'CANCELLED', createdAt: now(), updatedAt: now() };
  const store = new InMemoryStore(job([original, first, second]));
  const reconciler = managedReconciler(store, { owner: 'test', adapters: [], maxConcurrent: 0, emit() {} });
  await reconciler.reconcile(original.jobId);
  const result = await store.load(original.jobId);
  assert.equal(result.tasks.filter(t => t.agentName === 'troubleshooter').length, 2);
  assert.equal(result.tasks.find(t => t.id === second.id).state, 'QUEUED');
  assert.equal(result.tasks.find(t => t.id === first.id).state, 'SUCCEEDED');
});

test('reconcile automatically creates and routes one troubleshooter for failed work', async () => {
  const failed = failedReview();
  const store = new InMemoryStore(job([failed]));
  const events = [];
  const adapter = {
    name: 'codex',
    id: 'codex',
    capabilities: ['model', 'codex'],
    launch() { return { id: 'held', promise: new Promise(() => {}), cancel() {} }; },
  };
  const reconciler = managedReconciler(store, {
    owner: 'test',
    adapters: [adapter],
    eventBus: new MemoryEventBus(),
    maxConcurrent: 1,
    emit: event => events.push(event),
  });

  await reconciler.reconcile('neo-pr40');
  await reconciler.reconcile('neo-pr40');

  const durable = await store.load('neo-pr40');
  const recovery = durable.tasks.filter(task => task.agentName === 'troubleshooter');
  assert.equal(recovery.length, 1);
  assert.equal(recovery[0].state, 'QUEUED');
  assert.equal(recovery[0].adapter, 'codex');
  assert.equal(recovery[0].workerSelection?.workerId, 'codex');
  assert.equal(recovery[0].routing?.provider, 'openai');
  assert.equal(events.filter(event => event.type === 'troubleshooter.created').length, 1);
});

test('historical successful plan does not prevent failed Task recovery', async () => {
  const failed = { ...failedReview(), id: '18', planningDecisionId: 'plan-1' };
  const j = job([failed]);
  j.plans = [{
    jobId: j.id, id: 'plan-1', status: 'SUCCEEDED', round: 1,
    source: 'model-planner', trigger: { source: 'manual' }, generatedTaskIds: ['18'], assessment: 'work required', createdAt: now(), updatedAt: now(),
    plannerResult: { objective_status: 'in_progress', assessment: 'work required',
      next_tasks: [{ id: '18', title: 'Implement planned work in local repo', input: failed.input,
        output: { kind: 'task_pr' }, storySize: 'M' }] },
  }];
  const store = new InMemoryStore(j);
  const reconciler = managedReconciler(store, { owner: 'test', maxConcurrent: 0, adapters: [], emit() {} });
  await reconciler.reconcile(j.id);
  const state = await store.load(j.id);
  assert.equal(state.tasks.filter(t => t.id === '18').length, 1);
  assert.equal(state.tasks.find(t => t.id === '18').state, 'FAILED');
  assert.equal(state.tasks.filter(t => t.agentName === 'troubleshooter').length, 1);
  assert.equal(state.tasks.find(t => t.agentName === 'troubleshooter').parentTaskId, '18');
});

test('troubleshooter is a discoverable orchestrator-side execution role', async () => {
  const context = await resolveExecutionContext(process.cwd(), 'troubleshooter');
  const agent = context.agents.find(item => item.name === 'troubleshooter');
  assert.ok(agent?.path);
  assert.ok(agent.capabilities.includes('recovery'));
  const prompt = executionContextPrompt(context);
  assert.match(prompt, /Role: troubleshooter/);
  assert.match(prompt, /orchestrator-side recovery role/);
  assert.match(prompt, /P0\/self-job repair authority/);
  const agentContract = await import('node:fs/promises').then(fs => fs.readFile(agent.path, 'utf8'));
  assert.match(agentContract, /Mandatory before diagnosis/);
  assert.match(agentContract, /api\/events\?job=<job_id>&task=<task_id>&limit=200/);
  assert.match(agentContract, /event history cannot be retrieved/);
  assert.match(agentContract, /agents-relay escalation/);
  assert.match(agentContract, /`resolved`/);
  assert.match(agentContract, /`failed`/);
  assert.match(agentContract, /`needs_user`/);
  assert.doesNotMatch(agentContract, /genuine human\/external blocker, do not fake progress\. Publish task\.blocked/);
});


test('auto-routed troubleshooter avoids parent route that failed before task.started', async () => {
  const root = await import('node:fs/promises').then(fs => fs.mkdtemp('/tmp/relay-troubleshooter-route-'));
  const priorHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = root;
  try {
    const fs = await import('node:fs/promises');
    await fs.writeFile(`${root}/config.toml`, 'model = "gpt-5.6-luna"\nmodel_provider = "openai"\nmodel_reasoning_effort = "medium"\n');
    await fs.writeFile(`${root}/zai.config.toml`, 'model = "glm-5.3-flash"\nmodel_provider = "zai"\nmodel_reasoning_effort = "high"\n');
    const failed = failedReview();
    failed.agentName = null;
    failed.adapter = 'codex';
    failed.workerSelection = undefined;
    failed.routing = { provider:'zai', model:'glm-5.3-flash', profile:'zai', reasoning:'high', decidedBy:'test', decidedAt:now() };
    failed.error = 'Worker original exited before publishing task.started';
    const store = new InMemoryStore(job([failed]));
    const adapter = { name:'codex', id:'codex', capabilities:['model','codex','local_repo','iterative_tools'], launch(){ return { id:'held', promise:new Promise(() => {}), cancel(){} }; } };
    const reconciler = managedReconciler(store, { owner:'test', adapters:[adapter], eventBus:new MemoryEventBus(), maxConcurrent:1 });
    await reconciler.reconcile('neo-pr40');
    const durable = await store.load('neo-pr40');
    const recovery = durable.tasks.find(task => task.agentName === 'troubleshooter');
    assert.equal(recovery.routing.provider, 'openai');
    assert.notEqual(`${recovery.routing.provider}/${recovery.routing.model}`, 'zai/glm-5.3-flash');
  } finally {
    if (priorHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = priorHome;
  }
});

test('failed Troubleshooter records one durable recovery.exhausted fact without recursive recovery', async () => {
  const failed = failedReview();
  const [recovery] = pendingTroubleshooterTasks(job([failed]));
  recovery.state = 'FAILED';
  recovery.error = 'Troubleshooter runtime failed after diagnosis';
  recovery.attempt = recovery.maxAttempts;
  const root = job([failed, recovery]);
  const store = new InMemoryStore(root);
  const events = [];
  const reconciler = managedReconciler(store, {
    owner: 'test', adapters: [], eventBus: new MemoryEventBus(), maxConcurrent: 0,
    emit: event => events.push(event),
  });

  await reconciler.reconcile(root.id);
  await reconciler.reconcile(root.id);

  const durable = await store.load(root.id);
  assert.equal(durable.tasks.filter(task => task.agentName === 'troubleshooter').length, 1, 'must not recursively create a Troubleshooter for a Troubleshooter');
  const escalated = durable.tasks.find(task => task.id === recovery.id);
  assert.equal(escalated.state, 'BLOCKED');
  assert.equal(escalated.escalation?.status, 'pending');
  assert.match(escalated.escalation?.context ?? '', /runtime failed/);
  assert.equal(events.filter(event => event.type === 'task.blocked').length, 1, 'Core must escalate exactly once');
  assert.deepEqual(pendingTroubleshooterTasks(durable), []);
});


test('failed Troubleshooter within retry budget requeues same recovery Task without exhaustion', async () => {
  const failed = failedReview();
  const [recovery] = pendingTroubleshooterTasks(job([failed]));
  recovery.state = 'FAILED'; recovery.attempt = 1; recovery.error = 'transient provider failure';
  recovery.routing = { provider: 'openai', model: 'test-model', decidedBy: 'test', decidedAt: new Date().toISOString() };
  const root = job([failed, recovery]);
  const store = new InMemoryStore(root);
  const events=[];
  const reconciler = managedReconciler(store, { owner:'test', adapters:[], eventBus:new MemoryEventBus(), maxConcurrent:0, emit:event=>events.push(event) });
  await reconciler.reconcile(root.id);
  const durable=await store.load(root.id);
  const retried=durable.tasks.find(task=>task.id===recovery.id);
  assert.equal(retried.state,'QUEUED');
  assert.equal(retried.routing,undefined);
  assert.equal(durable.tasks.filter(task=>task.agentName==='troubleshooter').length,1);
  assert.equal(durable.recoveryFailures?.length??0,0);
  assert.equal(events.filter(e=>e.type==='troubleshooter.retry_queued').length,1);
});

test('exhausted runtime Troubleshooter uses Codex configured default then escalates if it fails', async () => {
  const original = failedReview();
  const [recovery] = pendingTroubleshooterTasks(job([original]));
  recovery.state = 'FAILED'; recovery.attempt = recovery.maxAttempts;
  recovery.failureReason = 'terminal_event_timeout';
  recovery.error = 'terminal_event_timeout';
  recovery.routing = { provider: 'openai', model: 'gpt-6-luna', decidedBy: 'execution-router:laya', decidedAt: now(), decisionEvidence: { probabilities: { 'worker=codex provider=openai model=gpt-6-luna reasoning=high default=true': 0.61, 'worker=codex provider=openai model=gpt-5.6-terra reasoning=medium default=false': 0.39 } } };
  const store = new InMemoryStore(job([original, recovery]));
  const events = [];
  const reconciler = managedReconciler(store, { owner: 'test', adapters: [], maxConcurrent: 0, eventBus: new MemoryEventBus(), emit: e => events.push(e) });
  await reconciler.reconcile('neo-pr40');
  let task = (await store.load('neo-pr40')).tasks.find(item => item.id === recovery.id);
  assert.equal(task.state, 'QUEUED');
  assert.equal(task.routing.model, '', 'fallback must omit -m and use Codex configured default');
  assert.equal(task.maxAttempts, recovery.maxAttempts + 1);
  assert.equal(events.filter(e => e.type === 'troubleshooter.retry_queued').length, 1);
  task.state = 'FAILED'; task.attempt = task.maxAttempts; task.error = 'terminal_event_timeout';
  await store.saveTask(task);
  await reconciler.reconcile('neo-pr40');
  await reconciler.reconcile('neo-pr40');
  task = (await store.load('neo-pr40')).tasks.find(item => item.id === recovery.id);
  assert.equal(task.state, 'BLOCKED');
  assert.equal(task.escalation.status, 'pending');
  assert.equal(events.filter(e => e.type === 'task.blocked').length, 1);
  await reconciler.close();
});
