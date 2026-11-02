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
  assert.ok(cases.length >= 25, 'cover each primary workflow and unsafe alternatives');
  const ids = new Set();
  const categories = new Set();
  for (const item of cases) {
    assert.ok(item.id && !ids.has(item.id), 'unique, nonempty case ID');
    ids.add(item.id);
    assert.ok(item.request && item.request.length > 30, 'realistic user intent');
    assert.ok(validDecisions.has(item.expected?.decision), 'observable action selection');
    assert.ok(item.capability, 'source capability for this test');
    assert.ok((item.expected.alternative_decisions??[]).every(d => validDecisions.has(d)), 'valid alternative decision');
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

test('L4 model cases cover distinct supported role/adapters with observable actions', async () => {
  const data = JSON.parse(await readFile(new URL('../test/verification/l4/model-cases.json',import.meta.url),'utf8'));
  assert.equal(data.schema,'relay.l4.behavior-cases.v1');
  assert.ok(data.cases.length >= 9);
  const seen = new Set();
  const roleNames = new Set();
  for(const item of data.cases) {
    assert.ok(item.id && !seen.has(item.id),'unique L4 case');
    seen.add(item.id);
    assert.ok(item.scenario.length > 40,'nontrivial scenario');
    assert.ok(item.prompt && /^[-a-z]+-(codex|chatgpt|z)$/.test(item.prompt),'real Builder Prompt filename');
    assert.ok(item.decision && item.must.length && item.forbidden.length,'falsifiable behavioral expectation');
    roleNames.add(item.prompt.replace(/-(codex|chatgpt|z)$/,''));
  }
  for(const role of ['planner','implementation','reviewer','troubleshooter','vlog-producer','vlog-final-qa'])
    assert.ok(roleNames.has(role),'missing L4 role '+role);
});
