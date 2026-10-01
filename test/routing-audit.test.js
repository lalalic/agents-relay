import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsonlDecisionAuditStore } from '../dist/decision-audit.js';
import { classifyFailureEvidence, redecideFailedTask } from '../dist/model-redecision.js';
import { routeModel } from '../dist/model-routing.js';
import { routeExecution } from '../dist/execution-routing.js';

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
  assert.equal(updated.routing.model, 'gpt-5.6-luna');
  assert.equal(task.attempt, 1);
});


test('free-text execution router rules are passed verbatim to the decision engine', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-rules-'));
  const rulesPath = join(root, 'rules.md');
  const rules = 'Prefer ZAI when paid quota is abundant.\nRe-decide with fresh usage after provider/runtime failure.';
  await writeFile(rulesPath, rules);
  let seen;
  const decisionEngine = {
    name: 'capture',
    decide: async (request, contract) => {
      seen = request.facts;
      return { type: 'choice', choice: contract.choices[0] };
    },
  };
  await routeModel(worker, [candidate('zai-model', 'zai', 'zai'), candidate('openai-model', 'openai', 'openai')], {
    rulesPath,
    decisionEngine,
    decisionMode: 'active',
    taskFacts: { kind: 'implementation' },
  });
  assert.equal(seen.user_input_rules, rules);
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
    const result = await routeExecution(workers, { capabilities: [] }, { decisionEngine: engine, decisionMode: 'active', auditStore: store, taskFacts: { kind: 'review' } });
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
    assert.ok(Array.isArray(audit.decision_input.stages[0].facts.worker_candidates));
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
