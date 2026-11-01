import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** Skills are execution interfaces: a missing secondary .md reference breaks
 * work even when the top-level Prompt's SHA-pinned files are all readable. */
test('Agents Relay Skill references only existing bundled Markdown contracts and workflows', async () => {
  const root=resolve('skills/agents-relay');
  const skill=await readFile(join(root,'SKILL.md'),'utf8');
  const refs=[...skill.matchAll(/`((?:contracts|workflows|agents)\/[a-zA-Z0-9._/-]+\.md)`/g)].map(m=>m[1]);
  assert.ok(refs.length>0,'at least one secondary contract must be referenced');
  for(const rel of refs){
    assert.ok(!rel.includes('..'),`Ref escapes the Skill root: ${rel}`);
    await assert.doesNotReject(access(join(root,rel)),`Missing reference ${rel}`);
  }
  assert.doesNotMatch(skill,/workflows\/content-generation\.md/,
    'Nonexistent content workflow must not be named as a required dependency');
});
