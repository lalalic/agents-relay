import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const skillRoot = new URL('../skills/agents-relay/', import.meta.url);
const dataFile = new URL('evals/capabilities.json', skillRoot);
const validDecisions = new Set(['direct','create','adopt','inspect','plan','task_create','review','recover','escalate','service','worker_context']);

test('Agents Relay capability eval fixtures cover real user decisions and negative paths', async () => {
  const { schema, instruction, output_schema, cases } = JSON.parse(await readFile(dataFile,'utf8'));
  assert.equal(schema,'agents-relay-skill-capabilities-v1');
  assert.match(instruction,/Do not perform side effects/);
  assert.match(output_schema.decision,/direct.*create.*recover/);
  assert.ok(cases.length >= 12, 'cover each primary workflow and unsafe alternatives');
  const ids = new Set();
  const categories = new Set();
  for (const item of cases) {
    assert.ok(item.id && !ids.has(item.id), 'unique, nonempty case ID');
    ids.add(item.id);
    assert.ok(item.request && item.request.length > 30, 'realistic user intent');
    assert.ok(validDecisions.has(item.expected?.decision), 'observable action selection');
    assert.ok(item.capability, 'source capability for this test');
    categories.add(item.capability);
    assert.ok(Array.isArray(item.forbidden) && item.forbidden.length > 0, 'negative or adversarial test condition');
    assert.ok(item.forbidden.every(entry => typeof entry === 'string' && entry.length > 0));
    if (item.expected.flags) assert.ok(item.expected.flags.every(flag => flag.startsWith('--')));
  }
  for (const capability of ['route','create','plan','monitor','review','recover','escalate','worker','service']) {
    assert.ok(categories.has(capability), 'missing capability: ' + capability);
  }
  const skill = await readFile(new URL('SKILL.md',skillRoot),'utf8');
  assert.ok(skill.includes('matching-absolute-dist/cli.js'), 'bound execution CLI');
  assert.match(skill,/task context.*--execution-id/, 'worker identity fencing');
  assert.match(skill,/plan context.*--execution-id/, 'planner identity fencing');
  assert.match(skill,/PLAN_APPLIED:/, 'durable Planner receipt');
  assert.match(skill,/diagnose before retrying/i, 'recovery must be evidence-first');
  assert.doesNotMatch(skill,/^requires:/m, 'service management is an on-demand dependency');
  assert.ok(skill.trim().split(/\s+/).length < 1100, 'decision Skill remains compact');
});
