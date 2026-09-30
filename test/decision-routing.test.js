import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { managedReconciler } from './test-runtime.js';
import { decisionMode, LayaCliDecisionEngine, parseChoiceDecision, validateDecisionRequest } from '../dist/decision.js';
import { discoverModelCandidates, routeModel } from '../dist/model-routing.js';
import { routeWorker, workerCandidates } from '../dist/worker-routing.js';
import { executionTaskShape, routeExecution } from '../dist/execution-routing.js';
import { MemoryEventBus } from '../dist/events.js';

const contract = { type: 'choice', question: 'Pick one', choices: ['a', 'b'] };

class FakeDecisionEngine {
  constructor(choice, error = null) { this.name = 'fake'; this.choice = choice; this.error = error; this.calls = []; }
  async decide(request, decisionContract) {
    this.calls.push({ request, contract: decisionContract });
    if (this.error) throw this.error;
    if (decisionContract.type === 'multi_choice') {
      const workers = decisionContract.questions.worker.choices;
      const providers = decisionContract.questions.provider.choices;
      const worker = this.choice.includes('chatgpt') ? (workers.find(item => item.includes('chatgpt')) ?? workers[0]) : workers[0];
      const provider = this.choice.includes('zai') ? (providers.find(item => item === 'zai') ?? providers[0]) : worker.includes('chatgpt') ? 'chatgpt' : providers[0];
      const answers = { worker, provider, model: 'provider-default', reasoning: 'provider-default' };
      return {
        type: 'multi_choice',
        answers,
        probabilities: Object.fromEntries(Object.entries(decisionContract.questions).map(([id, question]) => [id, Object.fromEntries(question.choices.map(item => [item, item === answers[id] ? 1 : 0]))])),
      };
    }
    const choice = decisionContract.choices.includes(this.choice)
      ? this.choice
      : this.choice.includes('chatgpt')
        ? (decisionContract.choices.find(item => item.startsWith('chatgpt/browser-worker/')) ?? decisionContract.choices[0])
        : this.choice.includes('zai')
          ? (decisionContract.choices.find(item => item.includes('/zai/')) ?? decisionContract.choices[0])
          : decisionContract.choices[0];
    return { type: 'choice', choice, probabilities: Object.fromEntries(decisionContract.choices.map(item => [item, item === choice ? 0.8 : 0.2])) };
  }
}


test('runtime decision mode is always active and ignores environment configuration', () => {
  const previous = process.env.AGENTS_RELAY_DECISION_MODE;
  process.env.AGENTS_RELAY_DECISION_MODE = 'off';
  try {
    assert.equal(decisionMode(), 'active');
  } finally {
    if (previous === undefined) delete process.env.AGENTS_RELAY_DECISION_MODE; else process.env.AGENTS_RELAY_DECISION_MODE = previous;
  }
});

test('decision request and choice output are validated against the caller contract', () => {
  validateDecisionRequest({ facts: { task: 'x' } }, contract);
  assert.equal(parseChoiceDecision({ answers: { decision: { choice: 'b', probabilities: { a: 0.2, b: 0.8 } } } }, contract).choice, 'b');
  assert.throws(() => parseChoiceDecision({ choice: 'c' }, contract), /outside the contract/);
  assert.throws(() => validateDecisionRequest({ facts: { bad: undefined } }, contract), /undefined/);
});

test('Laya CLI decision engine materializes state/questions files for a transient process', async () => {
  const script = `const fs=require('fs');const args=process.argv.slice(1);const state=JSON.parse(fs.readFileSync(args[args.indexOf('--state-file')+1],'utf8'));const q=JSON.parse(fs.readFileSync(args[args.indexOf('--questions')+1],'utf8'));if(state.task!=='x')process.exit(9);const c=q.decision.criteria;process.stdout.write(JSON.stringify({answers:{decision:{choice:c[1],probabilities:{[c[0]]:0.1,[c[1]]:0.9}}}}));`;
  const engine = new LayaCliDecisionEngine({ command: process.execPath, args: ['-e', script, '--'], timeoutMs: 1000 });
  const result = await engine.decide({ facts: { task: 'x' } }, contract);
  assert.equal(result.choice, 'b');
  assert.deepEqual(result.probabilities, { a: 0.1, b: 0.9 });
});

test('Laya CLI failure, invalid JSON, out-of-contract output, and timeout reject cleanly', async () => {
  const failed = new LayaCliDecisionEngine({ command: process.execPath, args: ['-e', 'process.exit(7)', '--'], timeoutMs: 1000 });
  await assert.rejects(() => failed.decide({ facts: {} }, contract), /exited 7/);
  const invalid = new LayaCliDecisionEngine({ command: process.execPath, args: ['-e', `process.stdout.write('nope')`, '--'], timeoutMs: 1000 });
  await assert.rejects(() => invalid.decide({ facts: {} }, contract), /invalid JSON/);
  const outside = new LayaCliDecisionEngine({ command: process.execPath, args: ['-e', `process.stdout.write(JSON.stringify({choice:'c'}))`, '--'], timeoutMs: 1000 });
  await assert.rejects(() => outside.decide({ facts: {} }, contract), /outside the contract/);
  const timeout = new LayaCliDecisionEngine({ command: process.execPath, args: ['-e', 'setTimeout(()=>{},1000)', '--'], timeoutMs: 20 });
  await assert.rejects(() => timeout.decide({ facts: {} }, contract), /timed out/);
});

test('worker hard gates run before decide and active mode may choose only an eligible worker', async () => {
  const engine = new FakeDecisionEngine('chatgpt');
  const candidates = [
    { workerId: 'ineligible', adapter: 'codex', capabilities: ['model'], availability: 'offline' },
    { workerId: 'codex', adapter: 'codex', capabilities: ['model'] },
    { workerId: 'chatgpt', adapter: 'chatgpt', capabilities: ['model'] },
  ];
  const routed = await routeWorker(candidates, { capabilities: ['model'] }, { decisionEngine: engine, decisionMode: 'active', taskFacts: { kind: 'research' } });
  assert.equal(routed.selection.workerId, 'chatgpt');
  assert.equal(routed.selection.selectedBy, 'worker-router:laya');
  assert.deepEqual(engine.calls[0].contract.choices, ['codex', 'chatgpt']);
});

test('single eligible worker bypasses decide and shadow mode does not change deterministic selection', async () => {
  const bypass = new FakeDecisionEngine('never');
  const single = await routeWorker([
    { workerId: 'codex', adapter: 'codex', capabilities: ['model'] },
    { workerId: 'offline', adapter: 'chatgpt', capabilities: ['model'], availability: 'offline' },
  ], { capabilities: ['model'] }, { decisionEngine: bypass, decisionMode: 'active' });
  assert.equal(single.selection.workerId, 'codex');
  assert.equal(bypass.calls.length, 0);

  const shadowEngine = new FakeDecisionEngine('chatgpt');
  const shadow = await routeWorker([
    { workerId: 'codex', adapter: 'codex', capabilities: ['model'] },
    { workerId: 'chatgpt', adapter: 'chatgpt', capabilities: ['model'] },
  ], { capabilities: ['model'] }, { decisionEngine: shadowEngine, decisionMode: 'shadow' });
  assert.equal(shadow.selection.workerId, 'codex');
  assert.equal(shadow.selection.decisionEvidence.proposed, 'chatgpt');
  assert.equal(shadow.selection.decisionEvidence.fallback, true);
});

test('worker discovery no longer preselects model routing', () => {
  const [candidate] = workerCandidates([{ name: 'codex', id: 'codex', capabilities: ['model'] }], [], undefined);
  assert.equal(candidate.workerId, 'codex');
  assert.deepEqual(candidate.capabilities, ['model']);
  assert.equal('routing' in candidate, false);
});

test('free-text rules never create an unconfigured non-OpenAI provider or model', async () => {
  const home = await mkdtemp(join(tmpdir(), 'relay-codex-'));
  try {
    await writeFile(join(home, 'config.toml'), 'model = "gpt-main"\nmodel_provider = "openai"\nmodel_reasoning_effort = "medium"\n');
    const rulesPath = join(home, 'rules.md');
    await writeFile(rulesPath, 'zai只用 5.3 flash high thinking\ndeepseek只用 deepseek-flash');
    const worker = { workerId: 'codex', adapter: 'codex', capabilities: ['model'] };
    const candidates = await discoverModelCandidates(worker, [], undefined, home, rulesPath);
    assert.deepEqual(candidates.map(item => ({ provider: item.provider, model: item.model })), [{ provider: 'openai', model: 'gpt-main' }]);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('Codex runtime catalog informs validation without expanding execution choices', async () => {
  const home = await mkdtemp(join(tmpdir(), 'relay-codex-catalog-'));
  const priorHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    await writeFile(join(home, 'config.toml'), 'model = "gpt-5.6-luna"\nmodel_provider = "openai"\nmodel_reasoning_effort = "medium"\n');
    await writeFile(join(home, 'models_cache.json'), JSON.stringify({
      models: [
        { slug: 'gpt-6-astra', visibility: 'list', supported_in_api: true, priority: 1, default_reasoning_level: 'low', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] },
        { slug: 'gpt-5.6-sol', visibility: 'list', supported_in_api: true, priority: 2, default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'high' }] },
        { slug: 'hidden-model', visibility: 'hide', supported_in_api: true, supported_reasoning_levels: [{ effort: 'high' }] },
      ],
    }));
    const worker = { workerId: 'codex', adapter: 'codex', runtime: 'codex', capabilities: ['model'] };
    const models = await discoverModelCandidates(worker, [], undefined, home);
    assert.ok(models.some(item => item.model === 'gpt-6-astra' && item.reasoning === 'high'));
    assert.ok(models.some(item => item.model === 'gpt-5.6-sol' && item.reasoning === 'medium'));
    assert.ok(!models.some(item => item.model === 'hidden-model'));

    const rulesPath = join(home, 'rules.md');
    await writeFile(rulesPath, '');
    const calls = [];
    const engine = {
      name: 'capture',
      async decide(request, contract) {
        calls.push({ request, contract });
        return { type: 'choice', choice: contract.choices[0] };
      },
    };
    const result = await routeExecution([worker], { capabilities: [] }, { decisionEngine: engine, decisionMode: 'active', rulesPath });
    assert.equal(calls[0].contract.type, 'choice');
    assert.deepEqual(calls[0].contract.choices, ['codex/openai/default']);
    const codex = calls[0].request.facts.worker_candidates.find(item => item.id === 'codex');
    const openai = codex.providers.openai;
    assert.equal(openai.default.model, 'gpt-5.6-luna');
    assert.equal(openai.default.reasoning, 'medium');
    assert.equal(openai.runtime_catalog, undefined);
    assert.equal(openai.user_advertised, undefined);
    assert.match(calls[0].request.facts.routing_instruction, /user_input_rules/);
    assert.equal(result.candidate.routing.model, 'gpt-5.6-luna');
    assert.equal(result.candidate.routing.reasoning, 'medium');
  } finally {
    if (priorHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = priorHome;
    await rm(home, { recursive: true, force: true });
  }
});

test('user_input_rules advertise only explicit provider model overrides', async () => {
  const home = await mkdtemp(join(tmpdir(), 'relay-user-advertised-'));
  const priorHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    await writeFile(join(home, 'config.toml'), 'model = "gpt-5.6-luna"\nmodel_provider = "openai"\nmodel_reasoning_effort = "medium"\n');
    await writeFile(join(home, 'models_cache.json'), JSON.stringify({
      models: [
        { slug: 'gpt-6-astra', visibility: 'list', supported_in_api: true, supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'high' }] },
        { slug: 'gpt-5.6-sol', visibility: 'list', supported_in_api: true, supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'high' }] },
        { slug: 'gpt-5.6-terra', visibility: 'list', supported_in_api: true, supported_reasoning_levels: [{ effort: 'medium' }] },
      ],
    }));
    const rulesPath = join(home, 'rules.md');
    await writeFile(rulesPath, 'openai: gpt-5.6-luna high, sol medium, astra medium for complex and big tasks\n');
    const calls = [];
    const engine = {
      name: 'capture',
      async decide(request, contract) {
        calls.push({ request, contract });
        return { type: 'choice', choice: 'codex/openai/gpt-5.6-sol@medium' };
      },
    };
    const worker = { workerId: 'codex', adapter: 'codex', runtime: 'codex', capabilities: ['model'] };
    const result = await routeExecution([worker], { capabilities: [] }, { decisionEngine: engine, decisionMode: 'active', rulesPath });
    assert.deepEqual(calls[0].contract.choices, [
      'codex/openai/default',
      'codex/openai/gpt-5.6-luna@high',
      'codex/openai/gpt-5.6-sol@medium',
      'codex/openai/gpt-6-astra@medium',
    ]);
    assert.equal(calls[0].contract.choices.some(item => item.includes('terra')), false);
    const openai = calls[0].request.facts.worker_candidates.find(item => item.id === 'codex').providers.openai;
    assert.deepEqual(openai.default, { model: 'gpt-5.6-luna', reasoning: 'medium' });
    assert.equal(openai.runtime_catalog, undefined);
    assert.equal(openai.user_advertised, undefined);
    assert.equal(result.candidate.routing.model, 'gpt-5.6-sol');
    assert.equal(result.candidate.routing.reasoning, 'medium');
  } finally {
    if (priorHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = priorHome;
    await rm(home, { recursive: true, force: true });
  }
});

test('configured non-OpenAI profiles are discovered independently of free-text rules', async () => {
  const home = await mkdtemp(join(tmpdir(), 'relay-codex-'));
  try {
    await writeFile(join(home, 'config.toml'), 'model = "gpt-main"\nmodel_provider = "openai"\nmodel_reasoning_effort = "medium"\n');
    await writeFile(join(home, 'zai.config.toml'), 'model_provider = "zai"\nmodel = "glm-5.3-flash"\nmodel_reasoning_effort = "high"\n');
    const genericRules = join(home, 'generic-rules.md');
    await writeFile(genericRules, 'Prefer ZAI while quota is abundant.');
    const explicitRules = join(home, 'explicit-rules.md');
    await writeFile(explicitRules, 'zai只用 5.3 flash high thinking');
    const worker = { workerId: 'codex', adapter: 'codex', capabilities: ['model'] };
    assert.deepEqual((await discoverModelCandidates(worker, [], undefined, home, genericRules)).map(item => item.id), ['default:openai/gpt-main', 'zai:zai/glm-5.3-flash']);
    const candidates = await discoverModelCandidates(worker, [], undefined, home, explicitRules);
    assert.deepEqual(candidates.map(item => item.id), ['default:openai/gpt-main', 'zai:zai/glm-5.3-flash']);
    const engine = new FakeDecisionEngine('zai:zai/glm-5.3-flash@high');
    const routed = await routeModel(worker, candidates, { rulesPath: explicitRules, decisionEngine: engine, decisionMode: 'active', taskFacts: { kind: 'implementation' } });
    assert.equal(routed.routing.provider, 'zai');
    assert.equal(routed.routing.model, 'glm-5.3-flash');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('authorized non-OpenAI profile still obeys zero-credit hard gate', async () => {
  const home = await mkdtemp(join(tmpdir(), 'relay-codex-'));
  try {
    await writeFile(join(home, 'config.toml'), 'model = "gpt-main"\nmodel_provider = "openai"\nmodel_reasoning_effort = "medium"\n');
    await writeFile(join(home, 'deepseek.config.toml'), 'model_provider = "deepseek"\nmodel = "deepseek-flash"\nmodel_reasoning_effort = "high"\n');
    await writeFile(join(home, 'zai.config.toml'), 'model_provider = "zai"\nmodel = "glm-test"\nmodel_reasoning_effort = "high"\n');
    const rulesPath = join(home, 'rules.md');
    await writeFile(rulesPath, 'zai只用 glm-test high thinking\ndeepseek只用 deepseek-flash high thinking');
    const usage = { generatedAt: '2026-09-26T13:00:00.000Z', providers: [], credits: [{ id: 'deepseek', label: 'DeepSeek', credits: { available: false, generatedAt: '2026-09-26T13:00:00.000Z', balances: [{ currency: 'USD', total: 0, used: null, remaining: 0 }], reason: null } }] };
    const worker = { workerId: 'codex', adapter: 'codex', capabilities: ['model'] };
    const candidates = await discoverModelCandidates(worker, [], usage, home, rulesPath);
    assert.equal(candidates.find(item => item.provider === 'deepseek').resourceHealthy, false);
    const engine = new FakeDecisionEngine('zai:zai/glm-test@high');
    const routed = await routeModel(worker, candidates, { rulesPath, decisionEngine: engine, decisionMode: 'active', taskFacts: { kind: 'review' } });
    assert.equal(routed.routing.provider, 'zai');
    assert.ok(!engine.calls[0].contract.choices.includes('deepseek:deepseek/deepseek-flash'));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('model router passes reset-aware resource facts and burn guidance to the decision engine', async () => {
  const worker = { workerId: 'codex', adapter: 'codex', capabilities: ['model'] };
  const candidates = [
    { id: 'standard', provider: 'openai', model: 'standard', reasoning: 'medium', resourceHealthy: true, resourceUsedPercent: 20, resourceRemainingPercent: 80, resourceResetAt: 1000, resourceResetInMinutes: 30, resourceWindows: { fiveHour: { remainingPercent: 80, resetAt: 1000, resetInMinutes: 30 }, weekly: { remainingPercent: 60, resetAt: 9000, resetInMinutes: 3000 } } },
    { id: 'strong', provider: 'openai', model: 'strong', reasoning: 'high', resourceHealthy: true, resourceUsedPercent: 20, resourceRemainingPercent: 80, resourceResetAt: 1000, resourceResetInMinutes: 30, resourceWindows: { fiveHour: { remainingPercent: 80, resetAt: 1000, resetInMinutes: 30 }, weekly: { remainingPercent: 60, resetAt: 9000, resetInMinutes: 3000 } } },
  ];
  const engine = new FakeDecisionEngine('strong@high');
  const routed = await routeModel(worker, candidates, { decisionEngine: engine, decisionMode: 'active', taskFacts: { kind: 'implementation' } });
  const facts = engine.calls[0].request.facts.candidates[0];
  assert.equal(facts.resourceRemainingPercent, 80);
  assert.equal(facts.resourceResetAt, 1000);
  assert.equal(facts.resourceResetInMinutes, 30);
  assert.equal(facts.resourceWindows.fiveHour.resetInMinutes, 30);
  assert.equal(facts.resourceWindows.weekly.remainingPercent, 60);
  assert.match(engine.calls[0].contract.question, /every quota window/);
  assert.equal(routed.routing.model, 'strong');
  assert.equal(routed.routing.reasoning, 'high');
});

test('model hard gates precede decide, single candidate bypasses decide, and failure falls back', async () => {
  const worker = { workerId: 'codex', adapter: 'codex', capabilities: ['model'] };
  const candidates = [
    { id: 'a', provider: 'openai', model: 'a' },
    { id: 'b', provider: 'zai', model: 'b' },
  ];
  const bypass = new FakeDecisionEngine('a');
  const constrained = await routeModel(worker, candidates, { decisionEngine: bypass, decisionMode: 'active', constraints: { provider: 'zai' } });
  assert.equal(constrained.routing.model, 'b');
  assert.equal(bypass.calls.length, 0);

  const failed = new FakeDecisionEngine('b', new Error('laya unavailable'));
  const fallback = await routeModel(worker, candidates, { decisionEngine: failed, decisionMode: 'active' });
  assert.equal(fallback.routing.model, 'a');
  assert.equal(fallback.routing.decisionEvidence.fallback, true);
  assert.match(fallback.routing.decisionEvidence.error, /laya unavailable/);
});

test('reconciler emits worker.selected before model.selected after code routing', async () => {
  const { InMemoryStore } = await import('../dist/store.js');
  const { Reconciler } = await import('../dist/reconciler.js');
  const home = await mkdtemp(join(tmpdir(), 'relay-route-events-'));
  const oldHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    await writeFile(join(home, 'config.toml'), 'model = "gpt-test"\n');
    const now = new Date().toISOString();
    const task = { jobId: 'route-events', id: 'work', kind: 'work', parentTaskId: null, dependencies: [], capabilities: ['model'], workerRequirements: { capabilities: ['model'] }, adapter: 'codex', input: 'work', output: { kind: 'task_pr' }, state: 'QUEUED', attempt: 0, maxAttempts: 1, leaseOwner: null, leaseExpiresAt: null, executionId: null, threadId: null, result: null, error: null, timeoutMs: 0, createdAt: now, updatedAt: now, planningSource: 'model-planner' };
    const job = { id: 'route-events', title: 'routing', executionMode: 'fixed', prNumber: 1, repository: 'owner/repo', state: 'ACTIVE', continuation: null, createdAt: now, updatedAt: now, tasks: [task] };
    const store = new InMemoryStore(job);
    const events = [];
    const adapter = { name: 'codex', id: 'codex', capabilities: ['model'], launch() { throw new Error('must not launch'); } };
    const reconciler = managedReconciler(store, { owner: 'test', adapters: [adapter], maxConcurrent: 0, emit: event => events.push(event) });
    await reconciler.reconcile('route-events');
    const routingEvents = events.filter(event => event.type === 'worker.selected' || event.type === 'model.selected');
    assert.deepEqual(routingEvents.map(event => event.type), ['worker.selected', 'model.selected']);
    const durable = (await store.load('route-events')).tasks[0];
    assert.equal(durable.workerSelection.workerId, 'codex');
    assert.equal(durable.routing.model, 'gpt-test');
  } finally {
    if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
});

test('dependency-unblocked tasks are routed before launch', async () => {
  const { InMemoryStore } = await import('../dist/store.js');
  const home = await mkdtemp(join(tmpdir(), 'relay-route-unlock-'));
  const oldHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    await writeFile(join(home, 'config.toml'), 'model = "gpt-test"\n');
    const current = new Date().toISOString();
    const complete = (id, state, dependencies = []) => ({
      jobId: 'route-unlock', id, kind: 'work', parentTaskId: null, dependencies, capabilities: [],
      workerRequirements: { capabilities: ['model'] }, adapter: 'codex', input: 'work',
      output: { kind: 'task_pr' }, state, attempt: 0, maxAttempts: 1, leaseOwner: null,
      leaseExpiresAt: null, executionId: null, threadId: null, result: null, error: null,
      timeoutMs: 0, createdAt: current, updatedAt: current, planningSource: 'model-planner',
    });
    const dependency = complete('dependency', 'SUCCEEDED');
    dependency.routing = { provider: 'openai', model: 'gpt-test', decidedBy: 'test', decidedAt: current };
    const child = complete('unlocked', 'DRAFT', ['dependency']);
    const job = {
      id: 'route-unlock', title: 'routing', executionMode: 'fixed', prNumber: 1,
      repository: 'owner/repo', state: 'ACTIVE', continuation: null,
      createdAt: current, updatedAt: current, tasks: [dependency, child],
    };
    const store = new InMemoryStore(job);
    const adapter = {
      name: 'codex', id: 'codex', capabilities: ['model', 'codex'], launches: 0,
      launch(task) {
        this.launches += 1;
        if (!task.routing) throw new Error('unrouted launch');
        return { id: 'launched', promise: new Promise(() => {}), cancel() {} };
      },
    };
    const reconciler = managedReconciler(store, { owner: 'test', adapters: [adapter], eventBus: new MemoryEventBus() });
    await reconciler.reconcile('route-unlock');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(adapter.launches, 1);
    const durable = (await store.load('route-unlock')).tasks.find(item => item.id === 'unlocked');
    assert.equal(durable.workerSelection.workerId, 'codex');
    assert.equal(durable.routing.model, 'gpt-test');
  } finally {
    if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
});

test('worker decide receives task, usage, principles, and local rules without quota or capability hard gates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-worker-rules-'));
  try {
    const rulesPath = join(dir, 'rules.md');
    await writeFile(rulesPath, 'Prefer Codex for native app work when ChatGPT cannot operate the local UI.\n');
    const engine = new FakeDecisionEngine('codex');
    const usage = {
      generatedAt: '2026-09-26T01:00:00.000Z',
      providers: [
        { id: 'openai', usage: { available: true, generatedAt: 'x', fiveHour: { usedPercent: 100, windowMinutes: 300, resetsAt: null }, weekly: { usedPercent: 100, windowMinutes: 10080, resetsAt: null }, reason: null } },
      ],
      credits: [],
    };
    const routed = await routeWorker([
      { workerId: 'codex', adapter: 'codex', capabilities: ['model'], resourceHealthy: false, resourceProvider: 'openai', resourceUsedPercent: 100 },
      { workerId: 'chatgpt', adapter: 'chatgpt', capabilities: ['model'] },
    ], { capabilities: ['invented-capability'] }, {
      decisionEngine: engine,
      decisionMode: 'active',
      rulesPath,
      usage,
      taskFacts: { input: 'Open System Settings and change the local app configuration.' },
    });

    assert.equal(routed.selection.workerId, 'codex');
    assert.deepEqual(engine.calls[0].contract.choices, ['codex', 'chatgpt']);
    assert.equal(engine.calls[0].request.facts.task.input, 'Open System Settings and change the local app configuration.');
    assert.equal(engine.calls[0].request.facts.usage_snapshot.generatedAt, usage.generatedAt);
    assert.match(engine.calls[0].request.facts.routing_principles, /Prefer ChatGPT/);
    assert.match(engine.calls[0].request.facts.routing_principles, /native\/local execution/);
    assert.match(engine.calls[0].request.facts.user_input_rules, /Prefer Codex for native app work/);
    assert.deepEqual(engine.calls[0].request.facts.decision_precedence, ['authoritative_hard_constraints', 'user_input_rules', 'routing_principles', 'resource_and_runtime_preferences']);
    assert.match(engine.calls[0].contract.question, /user_input_rules ahead of built-in routing principles/);
    assert.match(engine.calls[0].request.facts.routing_principles, /higher-priority routing guidance/);
    assert.equal(engine.calls[0].request.facts.candidates[0].resourceHealthy, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test('worker router exposes ChatGPT load preference and fallback prefers Codex at the preferred limit', async () => {
  const engine = new FakeDecisionEngine('codex');
  const routed = await routeWorker([
    { workerId: 'codex', adapter: 'codex', capabilities: ['model'] },
    { workerId: 'chatgpt', adapter: 'chatgpt', capabilities: ['model'] },
  ], { capabilities: [] }, {
    decisionEngine: engine,
    decisionMode: 'active',
    chatgptRunning: 10,
  });
  assert.equal(routed.selection.workerId, 'codex');
  assert.equal(engine.calls[0].request.facts.runtime_load.chatgpt_running, 10);
  assert.equal(engine.calls[0].request.facts.runtime_load.preferred_chatgpt_concurrency, 10);

  const fallback = await routeWorker([
    { workerId: 'codex', adapter: 'codex', capabilities: ['model'] },
    { workerId: 'chatgpt', adapter: 'chatgpt', capabilities: ['model'] },
  ], { capabilities: [] }, {
    decisionMode: 'off',
    chatgptRunning: 10,
  });
  assert.equal(fallback.selection.workerId, 'codex');
});


test('worker fallback always chooses Codex when Codex is legal', async () => {
  const failed = new FakeDecisionEngine('chatgpt', new Error('laya unavailable'));
  const routed = await routeWorker([
    { workerId: 'chatgpt', adapter: 'chatgpt', capabilities: ['model'] },
    { workerId: 'codex', adapter: 'codex', capabilities: ['model'] },
  ], { capabilities: [] }, { decisionEngine: failed, decisionMode: 'active', chatgptRunning: 0 });
  assert.equal(routed.selection.workerId, 'codex');
  assert.equal(routed.selection.selectedBy, 'worker-router:fallback');
  assert.equal(routed.selection.decisionEvidence.fallback, true);
});

test('execution router makes one decision over complete routes with compact task-shape facts', async () => {
  const home = await mkdtemp(join(tmpdir(), 'relay-unified-route-'));
  const oldHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    await writeFile(join(home, 'config.toml'), 'model = "gpt-test"\nmodel_provider = "openai"\nmodel_reasoning_effort = "medium"\n');
    const calls = [];
    const engine = {
      name: 'fake',
      async decide(request, decisionContract) {
        calls.push({ request, contract: decisionContract });
        return { type: 'choice', choice: decisionContract.choices.find(item => item.startsWith('chatgpt/browser-worker/chatgpt/')) ?? decisionContract.choices[0] };
      },
    };
    const requirements = { capabilities: ['browser-harness', 'review'], taskKind: 'review', trustDomain: 'trusted', region: 'ca', labels: { tier: 'interactive' } };
    const result = await routeExecution([
      { workerId: 'codex', adapter: 'codex', runtime: 'codex', capabilities: ['model', 'codex'] },
      { workerId: 'chatgpt/browser-worker', adapter: 'chatgpt', runtime: 'chatgpt', capabilities: ['model', 'chatgpt', 'browser-harness'], browserWorkspaceCapacity: { name: 'Harness', poolSize: 5, idle: 1, leased: 0, available: 5, observedAt: new Date().toISOString(), reason: null } },
    ], requirements, { decisionEngine: engine, decisionMode: 'active', taskFacts: { role: 'reviewer' } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].contract.type, 'choice');
    assert.ok(calls[0].contract.choices.some(item => item.startsWith('codex/openai/')));
    assert.ok(calls[0].contract.choices.some(item => item.startsWith('chatgpt/browser-worker/chatgpt/')));
    assert.ok(Array.isArray(calls[0].request.facts.worker_candidates));
    assert.equal(calls[0].request.facts.context.task_shape.story_size, 'M');
    assert.equal(calls[0].request.facts.context.task_shape.preferred_worker, 'chatgpt');
    assert.equal(calls[0].request.facts.preferred_routes, undefined);
    assert.equal(calls[0].request.facts.worker_requirements, undefined);
    assert.equal(result.selection.workerId, 'chatgpt/browser-worker');
    assert.equal(result.candidate.routing.provider, 'chatgpt');
  } finally {
    if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
});

test('execution router falls back to Codex default profile when decision fails', async () => {
  const home = await mkdtemp(join(tmpdir(), 'relay-unified-fallback-'));
  const oldHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    await writeFile(join(home, 'config.toml'), 'model = "gpt-default"\nmodel_provider = "openai"\nmodel_reasoning_effort = "medium"\n');
    const failed = new FakeDecisionEngine('unused', new Error('decision unavailable'));
    const result = await routeExecution([
      { workerId: 'chatgpt/browser-worker', adapter: 'chatgpt', runtime: 'chatgpt', capabilities: ['model'], browserWorkspaceCapacity: { name: 'Harness', poolSize: 5, idle: 1, leased: 0, available: 5, observedAt: new Date().toISOString(), reason: null } },
      { workerId: 'codex', adapter: 'codex', runtime: 'codex', capabilities: ['model'] },
    ], { capabilities: [] }, { decisionEngine: failed, decisionMode: 'active' });
    assert.equal(result.selection.workerId, 'codex');
    assert.equal(result.candidate.routing.model, 'gpt-default');
    assert.equal(result.selection.selectedBy, 'execution-router:fallback');
  } finally {
    if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
});

test('final review uses normal Worker Router decision with current user guidance and reviewer diversity as soft context', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-review-worker-router-'));
  const oldHome = process.env.CODEX_HOME;
  const oldRules = process.env.AGENTS_RELAY_EXECUTION_ROUTER_RULES;
  process.env.CODEX_HOME = dir;
  const rulesPath = join(dir, 'worker-rules.md');
  process.env.AGENTS_RELAY_EXECUTION_ROUTER_RULES = rulesPath;
  try {
    await writeFile(join(dir, 'config.toml'), 'model = "gpt-test"\nmodel_provider = "openai"\n');
    await writeFile(rulesPath, "don't use chatgpt worker\n");
    const { InMemoryStore } = await import('../dist/store.js');
    const now = new Date().toISOString();
    const store = new InMemoryStore({ id: 'review-route', title: 'review route', executionMode: 'fixed', prNumber: 1, repository: 'owner/repo', state: 'ACTIVE', continuation: null, createdAt: now, updatedAt: now, tasks: [] });
    const calls = [];
    const engine = {
      name: 'fake',
      async decide(request, decisionContract) {
        calls.push({ request, contract: decisionContract });
        if (decisionContract.type === 'multi_choice') {
          return { type: 'choice', choice: contract.choices.find(item => item === 'codex/openai/default') ?? contract.choices[0] };
        }
        const choice = decisionContract.choices.includes('codex') ? 'codex' : decisionContract.choices[0];
        return { type: 'choice', choice, probabilities: Object.fromEntries(decisionContract.choices.map(item => [item, item === choice ? 0.9 : 0.1])) };
      },
    };
    const reconciler = managedReconciler(store, {
      owner: 'test',
      adapters: [
        { name: 'codex', id: 'codex', capabilities: ['model', 'codex'] },
        { name: 'chatgpt', id: 'chatgpt/browser-worker', capabilities: ['model', 'chatgpt', 'browser-harness'] },
      ],
      decisionEngine: engine,
      decisionMode: 'active',
      maxConcurrent: 0,
    });
    const implementation = [{ adapter: 'codex', workerSelection: { workerId: 'codex', adapter: 'codex', capabilities: ['model'], selectedBy: 'worker-router:laya', selectedAt: now }, routing: { provider: 'openai', model: 'gpt-test', decidedBy: 'model-router', decidedAt: now }, agentName: 'builder' }];
    const result = await reconciler.selectReviewer(implementation);
    assert.equal(result.selection.workerId, 'codex');
    assert.equal(result.selection.selectedBy, 'execution-router:laya');
    assert.equal(calls.length, 1);
    assert.match(calls[0].request.facts.user_input_rules, /don't use chatgpt worker/);
    assert.equal(calls[0].request.facts.context.reviewer.role, 'reviewer');
    assert.deepEqual(calls[0].request.facts.context.reviewer.reviewer_diversity.implementation_workers, ['codex']);
    assert.match(calls[0].request.facts.context.reviewer.reviewer_diversity.preference, /soft preference below user environment rules/);
  } finally {
    if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome;
    if (oldRules === undefined) delete process.env.AGENTS_RELAY_EXECUTION_ROUTER_RULES; else process.env.AGENTS_RELAY_EXECUTION_ROUTER_RULES = oldRules;
    await rm(dir, { recursive: true, force: true });
  }
});


test('execution router exposes explicit five-hour and weekly code-plan windows to Laya', async () => {
  const calls = [];
  const engine = { name: 'capture', decide: async (request, contract) => {
    calls.push({ request, contract });
    return { type: 'choice', choice: contract.choices.find(item => item === 'codex/openai/default') ?? contract.choices[0] };
  } };
  await routeExecution([
    { workerId: 'codex', adapter: 'codex', capabilities: [], runtime: 'codex' },
    { workerId: 'chatgpt/browser-worker', adapter: 'chatgpt', capabilities: [], runtime: 'chatgpt', browserWorkspaceCapacity: { name: 'Harness', poolSize: 5, idle: 5, leased: 0, available: 5, observedAt: new Date().toISOString(), reason: null } },
  ], { capabilities: [] }, {
    decisionEngine: engine,
    decisionMode: 'active',
    taskFacts: { storySize: 'M' },
    usage: {
      generatedAt: new Date().toISOString(),
      providers: [{
        id: 'openai',
        label: 'OpenAI',
        usage: {
          available: true,
          generatedAt: new Date().toISOString(),
          fiveHour: { usedPercent: 20, windowMinutes: 300, resetsAt: 1790000000 },
          weekly: { usedPercent: 60, windowMinutes: 10080, resetsAt: 1790500000 },
          reason: null,
        },
      }],
      credits: [],
    },
  });
  const codex = calls[0].request.facts.worker_candidates.find(item => item.id === 'codex');
  const openai = codex.providers.openai;
  assert.deepEqual(openai.code_plan.five_hour, {
    remaining_percent: 80,
    reset_at: 1790000000,
    reset_in_minutes: openai.code_plan.five_hour.reset_in_minutes,
  });
  assert.equal(openai.code_plan.weekly.remaining_percent, 40);
  assert.equal(openai.usage, undefined);
  assert.equal(openai.resourceRemainingPercent, undefined);
  assert.equal(openai.resourceWindows, undefined);
});

test('execution task shape keeps router policy simple', () => {
  assert.deepEqual(executionTaskShape({ storySize: 'S' }), {
    storySize: 'S', sustainedWork: false, preferredWorker: 'chatgpt',
    reason: 'Small/medium tasks favor ChatGPT when Browser Workspace capacity is available.',
  });
  assert.equal(executionTaskShape({ storySize: 'M' }).preferredWorker, 'chatgpt');
  assert.equal(executionTaskShape({ storySize: 'L' }).preferredWorker, 'codex');
});
