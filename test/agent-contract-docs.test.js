import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const file = name => readFile(new URL(name, import.meta.url), 'utf8');

test('Agent contract and execution documentation agree on optional soft hints', async () => {
  const contract = await file('../skills/agents-relay/contracts/agent-contract.md');
  for (const field of ['skills: [markcut, shotcraft]', 'model: openai/gpt-6', 'reasoning: high'])
    assert.ok(contract.includes(field), `missing Agent frontmatter example: ${field}`);
  assert.match(contract, /advisory.*never requirements/i);
  assert.match(contract, /Worker\/Planner \*\*user\s*prompt\*\*/);
  assert.match(contract, /Router \*\*decision prompt\*\*/);
  assert.match(contract, /do not create or enable model candidates/);
  assert.match(contract, /user routing instructions, or deterministic fallback/);
  assert.match(contract, /read-only Agent path/);
  for (const name of [
    '../skills/agents-relay/contracts/task-job-contract.md',
    '../docs/agent-prompt-builder.md',
    '../docs/worker-model-routers.md',
    '../skills/agents-relay/SKILL.md',
    '../AGENTS.md',
    '../README.md',
  ]) {
    const content = await file(name);
    assert.match(content, /agent-contract\.md/, `missing canonical Agent contract reference in ${name}`);
  }
});
