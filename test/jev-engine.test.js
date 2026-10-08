import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { JevDecisionEngine, executionDecisionEngine } from '../dist/decision.js';
import { taskCapabilityFacts } from '../dist/execution-routing.js';

const contract = { type: 'choice', question: 'Prefer ChatGPT for visual review', choices: ['codex route', 'chatgpt route'] };
test('Jev maps indexed candidates and probabilities to the exact route labels', async () => {
  let request;
  const engine = new JevDecisionEngine({ apiKey: 'test-key', fetcher: async (_url, options) => {
    request = JSON.parse(options.body);
    return { ok: true, json: async () => ({ model: 'typesafe/jev-1.13', answers: { decision: { choice: 'route_2', probabilities: { route_1: 0.03, route_2: 0.97 } } }, usage: { input_tokens: 55, output_tokens: 8, cost: 0.00002 } }) };
  } });
  const result = await engine.decide({ facts: { task_capabilities: ['visual_review'] } }, contract);
  assert.equal(result.choice, contract.choices[1]);
  assert.equal(result.probabilities[contract.choices[1]], 0.97);
  assert.equal(result.usage.cost, 0.00002);
  assert.deepEqual(request.state.task_capabilities, ['visual_review']);
  assert.deepEqual(Object.values(request.questions.decision.criteria), contract.choices);
});
test('Jev rejects unknown routes and HTTP errors', async () => {
  const bad = new JevDecisionEngine({ apiKey: 'test-key', fetcher: async () => ({ ok: true, json: async () => ({ answers: { decision: { choice: 'route_50' } } }) }) });
  await assert.rejects(bad.decide({ facts: {} }, contract), /outside/);
  const unavailable = new JevDecisionEngine({ apiKey: 'test-key', fetcher: async () => ({ ok: false, status: 503 }) });
  await assert.rejects(unavailable.decide({ facts: {} }, contract), /503/);
});
test('execution routing always uses Jev; errors fall back through caller-owned Codex route', () => {
  assert.equal(executionDecisionEngine().name, 'openrouter-jev');
});
test('task capability inference supports explicit declarations and visual requests', () => {
  assert.deepEqual(taskCapabilityFacts({ task: { input: 'Generate an image for this video', capabilities: ['model'] } }), ['model', 'image_generation']);
  assert.deepEqual(taskCapabilityFacts({ task: { input: 'Perform final review of PR' } }), ['final_review']);
  assert.deepEqual(taskCapabilityFacts({ task: { taskCapabilities: ['visual_review'], capabilities: ['model'], input: 'generate an image' } }), ['visual_review', 'model']);
});
