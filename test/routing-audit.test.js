import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsonlDecisionAuditStore, outcomeForDecision, recentExecutionRouteResults } from '../dist/decision-audit.js';
import { classifyFailureEvidence, redecideFailedTask } from '../dist/model-redecision.js';
import { routeModel } from '../dist/model-routing.js';
import { routeExecution } from '../dist/execution-routing.js';
import { InMemoryStore } from '../dist/store.js';
import { eventFor } from '../dist/events.js';
import { executionEventSource } from '../dist/reconciler.js';
import { managedReconciler } from './test-runtime.js';

const worker = { workerId: 'codex', adapter: 'codex', capabilities: ['model'] };
const candidate = (id, provider, profile) => ({ id, provider, model: id, profile, resourceHealthy: true, resourceRemainingPercent: 80 });

test('model decisions persist replayable sanitized audit records and policy snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-audit-'));
  const policyPath = join(root, 'policy.json');
  const rulesPath = join(root, 'execution-router-rules.md');
  await writeFile(policyPath, JSON.stringify({ disabledProfiles: ['disabled'], preferredProfiles: ['zai'] }));
  await writeFile(rulesPath, 'ZAI only zai-model while its paid quota remains abundant.');
  const store = new JsonlDecisionAuditStore(join(root, 'decisions.jsonl'));
  const routed = await routeModel(worker, [candidate('openai-model', 'openai', 'openai'), candidate('zai-model', 'zai', 'zai'), candidate('disabled-model', 'openai', 'disabled')], { policyPath, rulesPath, auditStore: store, taskFacts: { kind: 'implementation', secretToken: 'do-not-store' } });
  assert.equal(routed.candidate.profile, 'zai');
  const records = await store.read();
  assert.equal(records.length, 1);
  assert.equal(records[0].record_type, 'decision');
  assert.equal(records[0].policy.snapshot.disabledProfiles[0], 'disabled');
  assert.equal(records[0].policy.rules.text, 'ZAI only zai-model while its paid quota remains abundant.');
  assert.notEqual(records[0].policy.rules.hash, 'none');
  assert.equal(JSON.stringify(records[0]).includes('do-not-store'), false);
  assert.equal(records[0].eligible_candidates.some(item => item.profile === 'disabled'), false);
  assert.equal(routed.routing.decisionId, records[0].decision_id);
});

test('failure classification requires durable evidence and keeps semantic failures out of model recovery', () => {
  const model = classifyFailureEvidence({ events: [{ type: 'task.failed', message: 'provider launch returned incompatible model' }] });
  assert.equal(model.classification, 'model_provider_runtime');
  const semantic = classifyFailureEvidence({ events: [{ type: 'task.failed', message: 'tests failed in implementation' }] });
  assert.equal(semantic.classification, 'semantic_task');
  const unknown = classifyFailureEvidence({ events: [], taskError: 'provider failed' });
  assert.equal(unknown.classification, 'timeout_unknown');
});

test('model re-decision refreshes usage, updates routing, and does not retry the task', async () => {
  let snapshots = 0;
  let updated;
  const task = { id: 'work', jobId: 'job', kind: 'work', capabilities: ['model'], input: 'work', attempt: 1, executionId: 'exec', routing: { provider: 'openai', model: 'old', decisionId: 'prior' } };
  const result = await redecideFailedTask({
    task,
    worker,
    registered: [],
    usage: { snapshot: async () => { snapshots += 1; return { generatedAt: 'fresh', providers: [], credits: [] }; } },
    evidence: { classification: 'model_provider_runtime', summary: 'launch incompatibility', sources: ['events'] },
    updateRouting: async (target, routing) => { updated = { target, routing }; },
  });
  assert.equal(snapshots, 1);
  assert.equal(result.freshUsageGeneratedAt, 'fresh');
  assert.equal(updated.target, task);
  assert.equal(updated.routing.model, result.routing.model);
  assert.notEqual(updated.routing.model, 'old');
  assert.equal(task.attempt, 1);
});


test('routing instruction is appended to the decision contract instead of facts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-rules-'));
  const rulesPath = join(root, 'rules.md');
  const instruction = 'Prefer ZAI when paid quota is abundant.\nRe-decide with fresh usage after provider/runtime failure.';
  await writeFile(rulesPath, '[routing-instruction]\n' + instruction);
  let seen;
  let seenContract;
  const decisionEngine = {
    name: 'capture',
    decide: async (request, contract) => {
      seen = request.facts;
      seenContract = contract;
      return { type: 'choice', choice: contract.choices[0] };
    },
  };
  await routeModel(worker, [candidate('zai-model', 'zai', 'zai'), candidate('openai-model', 'openai', 'openai')], {
    rulesPath,
    decisionEngine,
    decisionMode: 'active',
    taskFacts: { kind: 'implementation' },
  });
  assert.equal(seen.user_input_rules, undefined);
  assert.equal(seen.routing_instruction, undefined);
  assert.ok(seenContract.question.endsWith(instruction));
});


test('failed route is a hard negative during model re-decision and is visible in audit gates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-redecide-'));
  const priorHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = root;
  try {
    await writeFile(join(root, 'config.toml'), 'model = "gpt-5.6-luna"\nmodel_provider = "openai"\nmodel_reasoning_effort = "medium"\n');
    await writeFile(join(root, 'zai.config.toml'), 'model = "glm-5.3-flash"\nmodel_provider = "zai"\nmodel_reasoning_effort = "high"\n');
    const rulesPath = join(root, 'rules.md');
    await writeFile(rulesPath, 'zai只用 5.3 flash high thinking');
    const store = new JsonlDecisionAuditStore(join(root, 'audit.jsonl'));
    const task = { id:'recover', jobId:'job', kind:'work', capabilities:['model'], input:'recover', attempt:1, executionId:null, routing:{ provider:'zai', model:'glm-5.3-flash', profile:'zai', decisionId:'prior' } };
    let updated;
    const result = await redecideFailedTask({
      task,
      worker,
      registered: [],
      usage: { snapshot: async () => ({ generatedAt:'fresh', providers:[], credits:[] }) },
      auditStore: store,
      rulesPath,
      evidence: { classification:'model_provider_runtime', summary:'provider launch failed', sources:['events'] },
      updateRouting: async (_task, routing) => { updated = routing; },
    });
    assert.equal(result.routing.provider, 'openai');
    assert.equal(updated.provider, 'openai');
    const records = await store.read();
    const decision = records.find(item => item.record_type === 'decision');
    const failedGate = decision.gate_results.find(item => item.candidate_id.includes('zai'));
    assert.equal(failedGate.eligible, false);
    assert.ok(failedGate.rejection_reasons.includes('prior_failed_route'));
  } finally {
    if (priorHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = priorHome;
  }
});


test('unified execution audit records full worker+model routes and selected route', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-execution-audit-'));
  const priorHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = root;
  try {
    await writeFile(join(root, 'config.toml'), 'model = "gpt-test"\nmodel_provider = "openai"\nmodel_reasoning_effort = "medium"\n');
    const store = new JsonlDecisionAuditStore(join(root, 'audit.jsonl'));
    const engine = {
      name: 'capture',
      decide: async (_request, contract) => ({
        type: 'choice',
        choice: contract.choices.find(item => item.includes('provider=chatgpt')) ?? contract.choices[0],
      }),
    };
    const workers = [
      { workerId: 'codex', adapter: 'codex', runtime: 'codex', capabilities: ['model', 'codex'] },
      { workerId: 'chatgpt/browser-worker', adapter: 'chatgpt', runtime: 'chatgpt', capabilities: ['model', 'chatgpt', 'browser-harness'], browserWorkspaceCapacity: { name: 'Harness', poolSize: 5, idle: 3, leased: 2, available: 3, observedAt: new Date().toISOString(), reason: null } },
    ];
    const rulesPath = join(root, 'rules.md');
    await writeFile(rulesPath, '');
    const result = await routeExecution(workers, { capabilities: [] }, { decisionEngine: engine, decisionMode: 'active', auditStore: store, taskFacts: { kind: 'review' }, rulesPath });
    assert.equal(result.selection.workerId, 'chatgpt/browser-worker');

    const [audit] = await store.read();
    assert.equal(audit.schema_version, 5);
    assert.equal(audit.contract.question, 'execution-route-selection');
    assert.equal(audit.selected.worker.adapter, 'chatgpt');
    assert.equal(audit.selected.model.provider, 'chatgpt');
    assert.ok(audit.candidates.some(item => item.worker.adapter === 'codex' && item.model.provider === 'openai'));
    assert.ok(audit.candidates.some(item => item.worker.adapter === 'chatgpt' && item.model.provider === 'chatgpt'));
    assert.equal(audit.worker_gate_results.find(item => item.worker_id === 'chatgpt/browser-worker').eligible, true);
    assert.equal(audit.decision_input.type, 'merged_choice_decision');
    assert.equal(audit.decision_input.stages.length, 1);
    assert.equal(audit.decision_input.stages[0].name, 'route');
    assert.ok(audit.decision_input.stages[0].contract.choices.includes('worker=codex provider=openai model=gpt-test reasoning=medium default=true'));
    assert.ok(audit.decision_input.stages[0].contract.choices.includes('worker=chatgpt/browser-worker provider=chatgpt model=account-defaults reasoning=provider-default default=true'));
    assert.equal(audit.decision_input.stages[0].facts.runtime.chatgpt_running, 0);
    assert.equal(audit.decision_input.stages[0].facts.worker_candidates, undefined);
    assert.equal(audit.decision_input.stages[0].facts.effective_choices, undefined);
    assert.equal(audit.decision_input.stages[0].facts.context.job, undefined);
    assert.equal(audit.decision_input.stages[0].facts.context.task, undefined);
    assert.ok(Array.isArray(audit.contract.effectiveChoices));
    assert.equal(audit.contract.routingInstruction, '');
  } finally {
    if (priorHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = priorHome;
  }
});

test('unified execution audit explains ChatGPT exclusion when Browser Workspace is exhausted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-execution-audit-gate-'));
  const priorHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = root;
  try {
    await writeFile(join(root, 'config.toml'), 'model = "gpt-test"\nmodel_provider = "openai"\nmodel_reasoning_effort = "medium"\n');
    const store = new JsonlDecisionAuditStore(join(root, 'audit.jsonl'));
    const workers = [
      { workerId: 'codex', adapter: 'codex', runtime: 'codex', capabilities: ['model', 'codex'] },
      { workerId: 'chatgpt/browser-worker', adapter: 'chatgpt', runtime: 'chatgpt', capabilities: ['model', 'chatgpt', 'browser-harness'], browserWorkspaceCapacity: { name: 'Harness', poolSize: 5, idle: 0, leased: 5, available: 0, observedAt: new Date().toISOString(), reason: null } },
    ];
    const result = await routeExecution(workers, { capabilities: [] }, { decisionMode: 'active', auditStore: store, taskFacts: { kind: 'implementation' } });
    assert.equal(result.selection.workerId, 'codex');

    const [audit] = await store.read();
    const chatgptGate = audit.worker_gate_results.find(item => item.worker_id === 'chatgpt/browser-worker');
    assert.equal(chatgptGate.eligible, false);
    assert.ok(chatgptGate.rejection_reasons.includes('browser_workspace_exhausted'));
    assert.equal(audit.candidates.some(item => item.worker.adapter === 'chatgpt'), true);
    const chatgptRouteGate = audit.gate_results.find(item => item.candidate_id.startsWith('chatgpt/browser-worker::'));
    assert.equal(chatgptRouteGate.eligible, false);
    assert.ok(chatgptRouteGate.rejection_reasons.includes('browser_workspace_exhausted'));
    assert.equal(audit.worker_candidates.find(item => item.id === 'chatgpt/browser-worker').browserWorkspaceCapacity.available, 0);
  } finally {
    if (priorHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = priorHome;
  }
});


test('unified execution audit persists authoritative model gate reasons before decide', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-execution-audit-model-gates-'));
  const priorHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = root;
  try {
    await writeFile(join(root, 'config.toml'), 'model = "gpt-primary"\nmodel_provider = "openai"\nmodel_reasoning_effort = "high"\n');
    await writeFile(join(root, 'alt.config.toml'), 'model = "gpt-alt"\nmodel_provider = "openai"\nmodel_reasoning_effort = "medium"\n');
    const store = new JsonlDecisionAuditStore(join(root, 'audit.jsonl'));
    const workers = [
      { workerId: 'codex', adapter: 'codex', runtime: 'codex', capabilities: ['model', 'codex'] },
      { workerId: 'chatgpt/browser-worker', adapter: 'chatgpt', runtime: 'chatgpt', capabilities: ['model', 'chatgpt'], browserWorkspaceCapacity: { name: 'Harness', poolSize: 5, idle: 5, leased: 0, available: 5, observedAt: new Date().toISOString(), reason: null } },
    ];

    const result = await routeExecution(workers, { capabilities: [] }, {
      decisionMode: 'active',
      auditStore: store,
      routingConstraints: { provider: 'openai', reasoning: 'high' },
      excludedRoutes: [{ provider: 'openai', model: 'gpt-alt', profile: 'alt' }],
      taskFacts: { kind: 'implementation' },
    });
    assert.equal(result.selection.workerId, 'codex');

    const [audit] = await store.read();
    const altGate = audit.gate_results.find(item => item.candidate_id.includes('alt:openai/gpt-alt'));
    assert.equal(altGate.eligible, false);
    assert.ok(altGate.rejection_reasons.includes('prior_failed_route'));
    assert.ok(altGate.rejection_reasons.includes('reasoning_constraint'));

    const chatgptGate = audit.gate_results.find(item => item.candidate_id.startsWith('chatgpt/browser-worker::'));
    assert.equal(chatgptGate.eligible, false);
    assert.ok(chatgptGate.rejection_reasons.includes('provider_constraint'));
    assert.equal(audit.eligible_candidates.some(item => item.worker.adapter === 'chatgpt'), false);
  } finally {
    if (priorHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = priorHome;
  }
});


test('router receives only the newest ten confirmed cross-Job route outcomes with reasons, not pending selections', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-route-history-'));
  const store = new JsonlDecisionAuditStore(join(root, 'audit.jsonl'));
  const base = {
    record_type: 'decision', schema_version: 5, timestamp: '2026-11-04T00:00:00.000Z',
    correlation: { job_id: 'job-1' }, task: {}, worker: {}, contract: {},
    policy: { path: null, hash: '', snapshot: {}, rules: { path: '', hash: '', text: '' } },
    candidates: [], gate_results: [], eligible_candidates: [], engine: 'execution-router:laya',
    fallback: { used: false },
    selected: {
      worker: { id: 'codex', adapter: 'codex' },
      model: { provider: 'zai', model: 'glm-test', profile: 'zai', reasoning: 'high' },
    },
  };
  // 12 completed attempts with different decision IDs (older outcomes are omitted).
  for (let i = 0; i < 12; i++) {
    const decision_id = 'route-' + i;
    await store.append({ ...base, decision_id, timestamp: '2026-11-04T00:00:00.000Z' });
    await store.append({ ...outcomeForDecision(decision_id, i % 2 ? 'success' : 'task_failure',
      i % 2 ? 'task.completed' : 'stream disconnected: Bearer private-token api_key=private-secret'),
      timestamp: new Date(Date.UTC(2026, 10, 4, 0, i + 1)).toISOString() });
  }
  // An uncompleted route must not displace a completed one.
  await store.append({ ...base, decision_id: 'pending', timestamp: '2026-11-04T23:00:00.000Z' });
  await store.append({ ...outcomeForDecision('pending', 'task_started', 'worker began'),
    timestamp: '2026-11-04T23:00:01.000Z' });
  const history = await recentExecutionRouteResults(store);
  assert.equal(history.length, 10);
  assert.equal(history[0].result, 'success');
  assert.equal(history[0].reason, 'task_completed');
  assert.equal(history[1].result, 'failure');
  assert.equal(history[1].failure_kind, 'task_failure');
  assert.equal(history[1].reason, 'task_reported_failure');
  assert.ok(!JSON.stringify(history).includes('private-secret'));
  assert.ok(!JSON.stringify(history).includes('private-token'));
  assert.equal(history.every(item => item.provider === 'zai' && item.model === 'glm-test'), true);
  assert.equal(JSON.stringify(history).includes('stream disconnected'), false);
  assert.equal(history.some(item => item.timestamp === '2026-11-04T00:01:00.000Z'), false);

  let decisionFacts;
  let decisionContract;
  const engine = { name: 'capture', decide: async (request, contract) => {
    decisionFacts = request.facts;
    decisionContract = contract;
    return { type: 'choice', choice: contract.choices[0] };
  }};
  const workers = [
    { workerId: 'codex', adapter: 'codex', runtime: 'codex', capabilities: ['model', 'codex'] },
    { workerId: 'chatgpt/browser-worker', adapter: 'chatgpt', runtime: 'chatgpt', capabilities: ['model', 'chatgpt'], browserWorkspaceCapacity: { available: 1 } },
  ];
  const decision = await routeExecution(workers, { capabilities: [] }, {
    auditStore: store, decisionEngine: engine, decisionMode: 'active',
  });
  assert.deepEqual(decisionFacts.recent_route_results, history);
  assert.match(decisionContract.question, /recent_route_results/);
  assert.deepEqual(decision.audit.contract.recentRouteResults, history);
});

test('route outcome collector deduplicates updated results by decision and distinguishes cancellations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-route-update-'));
  const store = new JsonlDecisionAuditStore(join(root, 'audit.jsonl'));
  await store.append({
    record_type: 'decision', schema_version: 5, decision_id: 'x',
    timestamp: '2026-11-04T00:00:00.000Z', correlation: {}, task: {}, worker: {}, contract: {},
    policy: { path: null, hash: '', snapshot: {}, rules: { path: '', hash: '', text: '' } },
    candidates: [], gate_results: [], eligible_candidates: [], engine: 'execution-router:laya', fallback: { used: false },
    selected: { worker: { id: 'codex', adapter: 'codex' }, model: { provider: 'openai', model: 'gpt-test' } },
  });
  await store.append({ ...outcomeForDecision('x', 'provider_failure', 'bad credential'), timestamp: '2026-11-04T00:01:00.000Z' });
  await store.append({ ...outcomeForDecision('x', 'cancelled', 'owner cancelled'), timestamp: '2026-11-04T00:02:00.000Z' });
  assert.deepEqual((await recentExecutionRouteResults(store)).map(item => [item.result, item.reason]), [['cancelled', 'task_cancelled']]);
});

test('Graph-accepted correlated terminal events write one durable outcome; duplicates and stale events do not', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-route-term-'));
  const audit = new JsonlDecisionAuditStore(join(root, 'audit.jsonl'));
  const now = new Date().toISOString();
  const task = {
    jobId: 'j', id: 't', parentTaskId: null, dependencies: [], capabilities: [], adapter: 'codex',
    input: 'test', output: { kind: 'task_pr' },
    routing: { provider: 'openai', model: 'gpt-test', decidedBy: 'test', decidedAt: now, decisionId: 'selected-route' },
    state: 'RUNNING', attempt: 1, maxAttempts: 2, leaseOwner: 'owner', leaseExpiresAt: null,
    executionId: 'live-exec', executionHistory: [{ id: 'live-exec', attempt: 1, startedAt: now }],
    threadId: null, result: null, error: null, timeoutMs: 1000, createdAt: now, updatedAt: now,
    continuation: null, continuationDeliveredAt: null,
  };
  const job = { id: 'j', title: 'test', prNumber: 1, repository: 'owner/repo', state: 'ACTIVE',
    continuation: null, createdAt: now, updatedAt: now, tasks: [task], plans: [] };
  const store = new InMemoryStore(job);
  const reconciler = managedReconciler(store, { owner: 'test', adapters: [], decisionAuditStore: audit });
  const source = { id: executionEventSource('j', 't', 'live-exec') };
  const stale = { id: executionEventSource('j', 't', 'old-exec') };
  const failure = eventFor('j', 't', null, 'task.failed', 'failed', 'stream disconnected', 'user',
    { reason: 'provider_disconnect' }, source);
  assert.equal((await reconciler.applyEvent({ ...failure, source: stale })).applied, false);
  assert.equal((await audit.read()).length, 0);
  assert.equal((await reconciler.applyEvent(failure)).applied, true);
  assert.equal((await reconciler.applyEvent(failure)).applied, false);
  const results = (await audit.read()).filter(item => item.record_type === 'outcome');
  assert.equal(results.length, 1);
  assert.equal(results[0].decision_id, 'selected-route');
  assert.equal(results[0].kind, 'provider_failure');
  assert.match(results[0].summary, /provider_disconnect: stream disconnected/);
  assert.equal((await store.load('j')).tasks[0].state, 'FAILED');
});


test('watchdog-owned terminal failure is captured even when its subsequent event is observational', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-route-watchdog-'));
  const audit = new JsonlDecisionAuditStore(join(root, 'audit.jsonl'));
  const old = '2026-11-03T01:00:00.000Z';
  const task = {
    jobId: 'watchdog-job', id: 'watchdog-task', parentTaskId: null, dependencies: [], capabilities: [], adapter: 'codex',
    input: 'test', output: { kind: 'task_pr' },
    routing: { provider: 'zai', model: 'glm-test', decidedBy: 'test', decidedAt: old, decisionId: 'watchdog-route' },
    state: 'RUNNING', attempt: 1, maxAttempts: 1, leaseOwner: 'owner', leaseExpiresAt: null,
    executionId: 'watchdog-exec', executionHistory: [{ id: 'watchdog-exec', attempt: 1, startedAt: old }],
    threadId: null, result: null, error: null, timeoutMs: 1000, createdAt: old, updatedAt: old,
    continuation: null, continuationDeliveredAt: null,
  };
  const job = { id: 'watchdog-job', title: 'test', prNumber: 1, repository: 'owner/repo', state: 'ACTIVE',
    continuation: null, createdAt: old, updatedAt: old, tasks: [task], plans: [] };
  const store = new InMemoryStore(job);
  const reconciler = managedReconciler(store, { owner: 'test', adapters: [], decisionAuditStore: audit });
  await reconciler.timeoutTask('watchdog-job', 'watchdog-task', 'watchdog-exec');
  const results = (await audit.read()).filter(item => item.record_type === 'outcome');
  assert.equal(results.length, 1);
  assert.equal(results[0].decision_id, 'watchdog-route');
  assert.equal(results[0].kind, 'timeout');
  assert.match(results[0].summary, /inactivity timeout/);
  assert.equal((await store.load('watchdog-job')).tasks[0].state, 'FAILED');
});


test('accepted task completion records success and launch failure captures precise auth reason', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-route-two-outcomes-'));
  const audit = new JsonlDecisionAuditStore(join(root, 'audit.jsonl'));
  const now = new Date().toISOString();
  const live = (id, decisionId, state) => ({
    jobId: 'j', id, parentTaskId: null, dependencies: [], capabilities: [], adapter: 'codex',
    input: 'test', output: { kind: 'task_pr' }, state, attempt: 1, maxAttempts: 2,
    routing: { provider: 'openai', model: 'gpt-test', decidedBy: 'test', decidedAt: now, decisionId },
    leaseOwner: 'owner', leaseExpiresAt: null, executionId: 'exec-' + id,
    executionHistory: [{ id: 'exec-' + id, attempt: 1, startedAt: now }],
    threadId: null, result: null, error: null, timeoutMs: 1000,
    createdAt: now, updatedAt: now, continuation: null, continuationDeliveredAt: null,
  });
  const success = live('success', 'route-success', 'RUNNING');
  const launch = live('launch', 'route-launch', 'QUEUED');
  const job = { id: 'j', title: 'test', prNumber: 1, repository: 'owner/repo', state: 'ACTIVE',
    continuation: null, createdAt: now, updatedAt: now, tasks: [success, launch], plans: [] };
  const store = new InMemoryStore(job);
  const reconciler = managedReconciler(store, { owner: 'test', adapters: [], decisionAuditStore: audit });
  const event = eventFor('j', 'success', null, 'task.completed', 'succeeded', 'done', 'user', {},
    { id: executionEventSource('j', 'success', 'exec-success') });
  assert.equal((await reconciler.applyEvent(event)).applied, true);
  assert.equal((await store.load('j')).tasks.find(item => item.id === 'success').state, 'SUCCEEDED');
  await reconciler.failLaunch('j', 'launch', 'exec-launch', new Error('invalid API key'), 'launch');
  const outcomes = (await audit.read()).filter(item => item.record_type === 'outcome');
  assert.equal(outcomes.length, 2);
  assert.equal(outcomes.find(item => item.decision_id === 'route-success').kind, 'success');
  assert.equal(outcomes.find(item => item.decision_id === 'route-success').summary, 'task.completed');
  assert.equal(outcomes.find(item => item.decision_id === 'route-launch').kind, 'auth_config_failure');
  assert.match(outcomes.find(item => item.decision_id === 'route-launch').summary, /invalid API key/);
});

test('uncertain transport outcomes are not falsely treated as provider failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-route-uncertain-'));
  const audit = new JsonlDecisionAuditStore(join(root, 'audit.jsonl'));
  await audit.append({
    record_type: 'decision', schema_version: 5, decision_id: 'uncertain',
    timestamp: '2026-11-04T00:00:00.000Z', correlation: {}, task: {}, worker: {}, contract: {},
    policy: { path: null, hash: '', snapshot: {}, rules: { path: '', hash: '', text: '' } },
    candidates: [], gate_results: [], eligible_candidates: [], engine: 'execution-router:laya', fallback: { used: false },
    selected: { worker: { id: 'chatgpt/browser-worker', adapter: 'chatgpt' }, model: { provider: 'chatgpt', model: 'account-defaults' } },
  });
  await audit.append(outcomeForDecision('uncertain', 'outcome_unknown', 'no delivery acknowledgment'));
  const results = await recentExecutionRouteResults(audit);
  assert.equal(results.length, 1);
  assert.equal(results[0].result, 'unknown');
  assert.equal(results[0].failure_kind, null);
  assert.equal(results[0].reason, 'execution_outcome_unknown');
});


test('cross-Job history contains only fixed reason codes, never arbitrary task text or paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-route-private-'));
  const audit = new JsonlDecisionAuditStore(join(root, 'audit.jsonl'));
  await audit.append({
    record_type: 'decision', schema_version: 5, decision_id: 'private',
    timestamp: '2026-11-04T00:00:00.000Z', correlation: { job_id: 'private-job' }, task: {}, worker: {}, contract: {},
    policy: { path: null, hash: '', snapshot: {}, rules: { path: '', hash: '', text: '' } },
    candidates: [], gate_results: [], eligible_candidates: [], engine: 'execution-router:laya', fallback: { used: false },
    selected: { worker: { id: 'codex', adapter: 'codex' }, model: { provider: 'zai', model: 'glm-test' } },
  });
  const privateText = 'source episode Top Secret ClientName episode-1.mp4 path /Users/private/sensitive.mov';
  await audit.append(outcomeForDecision('private', 'provider_failure', 'stream disconnected ' + privateText));
  const history = await recentExecutionRouteResults(audit);
  assert.equal(history.length, 1);
  assert.equal(history[0].reason, 'provider_stream_disconnected');
  assert.equal(JSON.stringify(history).includes(privateText), false);
  assert.equal(JSON.stringify(history).includes('Top Secret ClientName'), false);
  assert.equal(JSON.stringify(history).includes('/Users/private/'), false);
});


test('existing provider_unavailable and rate_limit_exceeded worker codes are classified as provider errors', async () => {
  const { classifyRoutingFailure } = await import('../dist/route-outcome-recording.js');
  assert.equal(classifyRoutingFailure('provider_unavailable', 'task_failure'), 'provider_failure');
  assert.equal(classifyRoutingFailure('rate_limit_exceeded', 'task_failure'), 'provider_failure');
  assert.equal(classifyRoutingFailure('model_not_found', 'task_failure'), 'provider_failure');
  assert.equal(classifyRoutingFailure('model_unavailable', 'task_failure'), 'provider_failure');
  assert.equal(classifyRoutingFailure('tests failed in implementation', 'task_failure'), 'task_failure');
  const store = {
    read: async () => [{
      record_type: 'decision', schema_version: 5, decision_id: 'provider-signal',
      timestamp: '2026-11-04T00:00:00.000Z', selected: {
        worker: { id: 'codex', adapter: 'codex' },
        model: { provider: 'zai', model: 'glm' },
      },
    }, {
      ...outcomeForDecision('provider-signal', 'provider_failure', 'rate_limit_exceeded'),
    }],
  };
  const [history] = await recentExecutionRouteResults(store);
  assert.equal(history.result, 'failure');
  assert.equal(history.failure_kind, 'provider_failure');
  assert.equal(history.reason, 'provider_rate_limited');
});


test('two execution attempts sharing a decision_id contribute two separate route outcomes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-route-multiple-attempts-'));
  const audit = new JsonlDecisionAuditStore(join(root, 'audit.jsonl'));
  await audit.append({
    record_type: 'decision', schema_version: 5, decision_id: 'reused-route',
    timestamp: '2026-11-04T00:00:00.000Z', correlation: {}, task: {}, worker: {}, contract: {},
    policy: { path: null, hash: '', snapshot: {}, rules: { path: '', hash: '', text: '' } },
    candidates: [], gate_results: [], eligible_candidates: [], engine: 'execution-router:laya', fallback: { used: false },
    selected: { worker: { id: 'codex', adapter: 'codex' }, model: { provider: 'zai', model: 'glm' } },
  });
  await audit.append({
    ...outcomeForDecision('reused-route', 'provider_failure', 'provider_unavailable', { attempt: 1, execution_id: 'exec-1' }),
    timestamp: '2026-11-04T00:01:00.000Z',
  });
  await audit.append({
    ...outcomeForDecision('reused-route', 'success', 'task.completed', { attempt: 2, execution_id: 'exec-2' }),
    timestamp: '2026-11-04T00:02:00.000Z',
  });
  // Idempotent repeat receipt from exec-2 cannot add another counted outcome.
  await audit.append({
    ...outcomeForDecision('reused-route', 'success', 'task.completed', { attempt: 2, execution_id: 'exec-2' }),
    timestamp: '2026-11-04T00:02:01.000Z',
  });
  const history = await recentExecutionRouteResults(audit);
  assert.equal(history.length, 2);
  assert.deepEqual(history.map(item => item.result), ['success', 'failure']);
  assert.deepEqual(history.map(item => item.reason), ['task_completed', 'provider_failure']);
});


test('read-only dashboard Router preview uses last outcomes without persisting a phantom decision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-route-preview-'));
  const store = new JsonlDecisionAuditStore(join(root, 'audit.jsonl'));
  await store.append({
    record_type: 'decision', schema_version: 5, decision_id: 'real-execution',
    timestamp: '2026-11-04T00:00:00.000Z', correlation: {}, task: {}, worker: {}, contract: {},
    policy: { path: null, hash: '', snapshot: {}, rules: { path: '', hash: '', text: '' } },
    candidates: [], gate_results: [], eligible_candidates: [], engine: 'execution-router:laya', fallback: { used: false },
    selected: { worker: { id: 'codex', adapter: 'codex' }, model: { provider: 'openai', model: 'gpt' } },
  });
  await store.append(outcomeForDecision('real-execution', 'success', 'task.completed'));
  let seenHistory;
  const preview = await routeExecution([
    { workerId: 'codex', adapter: 'codex', runtime: 'codex', capabilities: ['model', 'codex'] },
    { workerId: 'chatgpt/browser-worker', adapter: 'chatgpt', runtime: 'chatgpt', capabilities: ['model', 'chatgpt'], browserWorkspaceCapacity: { available: 1 } },
  ], { capabilities: [] }, {
    historyStore: store,
    decisionMode: 'active',
    decisionEngine: { name: 'preview', decide: async (request, contract) => {
      seenHistory = request.facts.recent_route_results;
      return { type: 'choice', choice: contract.choices[0] };
    } },
  });
  assert.equal(seenHistory.length, 1);
  assert.equal(seenHistory[0].reason, 'task_completed');
  assert.equal(preview.audit.contract.recentRouteResults.length, 1);
  const records = await store.read();
  assert.equal(records.length, 2);
  assert.equal(records.filter(item => item.record_type === 'decision').length, 1);
});


test('JSONL route history uses bounded reverse scan and never loads the old audit archive after ten outcomes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-reverse-audit-'));
  const path = join(root, 'audit.jsonl');
  // Large historic decisions precede the ten recent self-contained outcomes.
  const legacy = JSON.stringify({ record_type: 'decision', data: 'older-private-data-' + 'x'.repeat(140) }) + '\n';
  await writeFile(path, legacy.repeat(1400));
  const store = new JsonlDecisionAuditStore(path);
  for (let i = 0; i < 12; i++) {
    await store.append({
      ...outcomeForDecision('decision-' + i, i % 2 ? 'success' : 'provider_failure', i % 2 ? 'done' : 'provider_unavailable', {
        attempt: 1, execution_id: 'exec-' + i,
        route: { worker: 'codex', adapter: 'codex', provider: 'zai', model: 'glm-test', profile: 'zai', reasoning: 'high' },
      }),
      timestamp: new Date(Date.UTC(2026, 10, 4, 3, i)).toISOString(),
    });
  }
  // A full-log read would fail: only the bounded tail path is allowed.
  store.read = async () => { throw new Error('unbounded audit read'); };
  const history = await recentExecutionRouteResults(store);
  assert.equal(history.length, 10);
  assert.deepEqual(history.map(item => item.result).slice(0, 4), ['success', 'failure', 'success', 'failure']);
  assert.equal(history[0].model, 'glm-test');
  assert.equal(history[0].reason, 'task_completed');
  assert.equal(history[1].reason, 'provider_failure');
  assert.equal(history.at(-1).timestamp, new Date(Date.UTC(2026, 10, 4, 3, 2)).toISOString());
});

test('reverse audit reader handles chunk boundaries, UTF-8 and a non-newline-terminated record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-audit-chunks-'));
  const path = join(root, 'audit.jsonl');
  const { readJsonlNewestFirst } = await import('../dist/audit-tail.js');
  const line = { route: '长期记录' + '中文'.repeat(36000) };
  await writeFile(path, JSON.stringify(line) + '\n' + JSON.stringify({ last: 2 }));
  const results = [];
  for await (const row of readJsonlNewestFirst(path)) results.push(row);
  assert.equal(results.length, 2);
  assert.deepEqual(results[0], { last: 2 });
  assert.deepEqual(results[1], line);
});


test('audit I/O failure does not block Router and degrades to empty advisory history', async () => {
  let captured;
  const workers = [
    { workerId: 'codex', adapter: 'codex', runtime: 'codex', capabilities: ['model', 'codex'] },
    { workerId: 'chatgpt/browser-worker', adapter: 'chatgpt', runtime: 'chatgpt', capabilities: ['model', 'chatgpt'], browserWorkspaceCapacity: { available: 2 } },
  ];
  const routed = await routeExecution(workers, { capabilities: [] }, {
    historyStore: { read: async () => { throw new Error('audit disk temporarily unavailable'); } },
    decisionMode: 'active',
    decisionEngine: { name: 'capture', decide: async (request, contract) => {
      captured = request.facts.recent_route_results;
      return { type: 'choice', choice: contract.choices[0] };
    } },
  });
  assert.deepEqual(captured, []);
  assert.ok(routed.selection.workerId);
});
