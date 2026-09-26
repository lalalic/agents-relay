import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { decisionMode, LayaCliDecisionEngine, parseChoiceDecision, validateDecisionRequest } from '../dist/decision.js';
import { discoverModelCandidates, routeModel } from '../dist/model-routing.js';
import { routeWorker, workerCandidates } from '../dist/worker-routing.js';

const contract = { type: 'choice', question: 'Pick one', choices: ['a', 'b'] };

class FakeDecisionEngine {
  constructor(choice, error = null) { this.name = 'fake'; this.choice = choice; this.error = error; this.calls = []; }
  async decide(request, decisionContract) {
    this.calls.push({ request, contract: decisionContract });
    if (this.error) throw this.error;
    return { type: 'choice', choice: this.choice, probabilities: Object.fromEntries(decisionContract.choices.map(item => [item, item === this.choice ? 0.8 : 0.2])) };
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
  assert.equal(shadow.selection.workerId, 'chatgpt');
  assert.equal(shadow.selection.decisionEvidence.proposed, 'chatgpt');
  assert.equal(shadow.selection.decisionEvidence.fallback, true);
});

test('worker discovery no longer preselects model routing', () => {
  const [candidate] = workerCandidates([{ name: 'codex', id: 'codex', capabilities: ['model'] }], [], undefined);
  assert.equal(candidate.workerId, 'codex');
  assert.deepEqual(candidate.capabilities, ['model']);
  assert.equal('routing' in candidate, false);
});

test('model router discovers configured Codex profiles then calls decide after worker selection', async () => {
  const home = await mkdtemp(join(tmpdir(), 'relay-codex-'));
  try {
    await writeFile(join(home, 'config.toml'), 'model = "gpt-main"\nmodel_reasoning_effort = "medium"\n');
    await writeFile(join(home, 'zai.config.toml'), 'model_provider = "zai"\nmodel = "glm-test"\nmodel_reasoning_effort = "high"\n');
    const worker = { workerId: 'codex', adapter: 'codex', capabilities: ['model'] };
    const candidates = await discoverModelCandidates(worker, [], undefined, home);
    assert.deepEqual(candidates.map(item => item.id), ['default:openai/gpt-main', 'zai:zai/glm-test']);
    const engine = new FakeDecisionEngine('zai:zai/glm-test');
    const routed = await routeModel(worker, candidates, { decisionEngine: engine, decisionMode: 'active', taskFacts: { kind: 'implementation' } });
    assert.equal(routed.routing.provider, 'zai');
    assert.equal(routed.routing.model, 'glm-test');
    assert.equal(routed.routing.profile, 'zai');
    assert.equal(routed.routing.decidedBy, 'model-router:laya');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});


test('model router passes reset-aware resource facts and burn guidance to the decision engine', async () => {
  const worker = { workerId: 'codex', adapter: 'codex', capabilities: ['model'] };
  const candidates = [
    { id: 'standard', provider: 'openai', model: 'standard', reasoning: 'medium', resourceHealthy: true, resourceUsedPercent: 20, resourceRemainingPercent: 80, resourceResetAt: 1000, resourceResetInMinutes: 30, resourceWindows: { fiveHour: { remainingPercent: 80, resetAt: 1000, resetInMinutes: 30 }, weekly: { remainingPercent: 60, resetAt: 9000, resetInMinutes: 3000 } } },
    { id: 'strong', provider: 'openai', model: 'strong', reasoning: 'high', resourceHealthy: true, resourceUsedPercent: 20, resourceRemainingPercent: 80, resourceResetAt: 1000, resourceResetInMinutes: 30, resourceWindows: { fiveHour: { remainingPercent: 80, resetAt: 1000, resetInMinutes: 30 }, weekly: { remainingPercent: 60, resetAt: 9000, resetInMinutes: 3000 } } },
  ];
  const engine = new FakeDecisionEngine('strong');
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
    const reconciler = new Reconciler(store, { owner: 'test', adapters: [adapter], maxConcurrent: 0, emit: event => events.push(event) });
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
    assert.match(engine.calls[0].request.facts.environment_rules, /Prefer Codex for native app work/);
    assert.equal(engine.calls[0].request.facts.candidates[0].resourceHealthy, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
