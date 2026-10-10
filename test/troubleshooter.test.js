import test, { managedReconciler } from './test-runtime.js';
import assert from 'node:assert/strict';
import { exhaustedTroubleshooterRecoveries, pendingTroubleshooterTasks, troubleshooterTaskId } from '../dist/troubleshooter.js';
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
    executionMode: 'fixed',
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
  assert.notEqual(troubleshooterTaskId(retriedFailure), recovery.id);
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

test('successful prior recovery permits a later recovery generation', () => {
  const failed = failedReview();
  const [recovery] = pendingTroubleshooterTasks(job([failed]));
  recovery.state = 'SUCCEEDED';

  const retriedFailure = { ...failed, attempt: 2, updatedAt: now() };
  const [next] = pendingTroubleshooterTasks(job([retriedFailure, recovery]));
  assert.equal(next.id, troubleshooterTaskId(retriedFailure));
  assert.equal(next.parentTaskId, failed.id);
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
  assert.equal(durable.recoveryFailures?.length, 1);
  assert.equal(durable.recoveryFailures?.[0].taskId, failed.id);
  assert.equal(durable.recoveryFailures?.[0].recoveryTaskId, recovery.id);
  assert.match(durable.recoveryFailures?.[0].reason ?? '', /runtime failed/);
  assert.equal(events.filter(event => event.type === 'recovery.exhausted').length, 1, 'reconcile must emit exhaustion once');
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
