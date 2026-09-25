import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsonlDecisionAuditStore } from '../dist/decision-audit.js';
import { classifyFailureEvidence, redecideFailedTask } from '../dist/model-redecision.js';
import { routeModel } from '../dist/model-routing.js';

const worker = { workerId: 'codex', adapter: 'codex', capabilities: ['model'] };
const candidate = (id, provider, profile) => ({ id, provider, model: id, profile, resourceHealthy: true, resourceRemainingPercent: 80 });

test('model decisions persist replayable sanitized audit records and policy snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-audit-'));
  const policyPath = join(root, 'policy.json');
  const rulesPath = join(root, 'model-router-rules.md');
  await writeFile(policyPath, JSON.stringify({ disabledProfiles: ['disabled'], preferredProfiles: ['zai'] }));
  await writeFile(rulesPath, 'Prefer ZAI while its paid quota remains abundant.');
  const store = new JsonlDecisionAuditStore(join(root, 'decisions.jsonl'));
  const routed = await routeModel(worker, [candidate('openai-model', 'openai', 'openai'), candidate('zai-model', 'zai', 'zai'), candidate('disabled-model', 'openai', 'disabled')], { policyPath, rulesPath, auditStore: store, taskFacts: { kind: 'implementation', secretToken: 'do-not-store' } });
  assert.equal(routed.candidate.profile, 'zai');
  const records = await store.read();
  assert.equal(records.length, 1);
  assert.equal(records[0].record_type, 'decision');
  assert.equal(records[0].policy.snapshot.disabledProfiles[0], 'disabled');
  assert.equal(records[0].policy.rules.text, 'Prefer ZAI while its paid quota remains abundant.');
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


test('free-text model router rules are passed verbatim to the decision engine', async () => {
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
  assert.equal(seen.environment_policy.rules, rules);
});
