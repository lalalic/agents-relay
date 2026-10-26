import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveAgentMarkdown } from '../dist/agent-content-resolver.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'relay-structured-agents-'));
  const builtin = join(root, 'relay'); const project = join(root, 'project');
  await Promise.all([mkdir(builtin, {recursive:true}), mkdir(join(project,'agents'),{recursive:true})]);
  t.after(async () => rm(root,{recursive:true,force:true}));
  await writeFile(join(builtin,'planner.agent.md'), '---\nname: planner\n---\n# Planner\n## A\nOriginal A\n### G\nOriginal G\n## B\nOriginal B\n## C\nOriginal C');
  return {root,builtin,project,write: body => writeFile(join(project,'agents','planner.agent.md'),body)};
}

test('nested section replace and other section extend preserve untouched base', async t => {
  const f=await fixture(t);
  await f.write('---\nname: planner\nextends: relay/planner\nmode: extend\nsections:\n  replace: [Planner/A/G]\n  extend: [Planner/B]\n---\n# Planner\n## A\n### G\nNew G\n## B\nExtra B');
  const effective=await resolveAgentMarkdown('planner',f.builtin,f.project);
  assert.match(effective.content,/Original A/);
  assert.match(effective.content,/New G/);
  assert.doesNotMatch(effective.content,/Original G/);
  assert.match(effective.content,/Original B\nExtra B/);
  assert.match(effective.content,/Original C/);
  assert.equal(effective.sources.length,2);
  assert.equal(effective.hash.length,64);
  assert.equal(effective.hash,(await resolveAgentMarkdown('planner',f.builtin,f.project)).hash);
});

test('whole replacement excludes replaceable base, standalone local and builtin work', async t => {
  const f=await fixture(t);
  await f.write('---\nname: planner\nextends: relay/planner\nmode: replace\n---\n# Entire replacement\nOnly my planning logic');
  const result=await resolveAgentMarkdown('planner',f.builtin,f.project);
  assert.equal(result.content,'# Entire replacement\nOnly my planning logic');
  assert.equal(result.sources.length,2);
  await f.write('---\nname: planner\n---\n# Standalone');
  const standalone=await resolveAgentMarkdown('planner',f.builtin,f.project);
  assert.equal(standalone.content,'# Standalone');
  assert.equal(standalone.sources.length,1);
});

test('invalid parents, conflicting sections, unknown headings and unsafe links fail closed', async t => {
  const f=await fixture(t);
  await f.write('---\nname: planner\nextends: neo/planner\n---\n# Test');
  await assert.rejects(resolveAgentMarkdown('planner',f.builtin,f.project),/Missing Neo base/);
  await f.write('---\nname: planner\nextends: relay/planner\nsections:\n  replace: [Planner/B]\n  extend: [Planner/B]\n---\n# Planner\n## B\nChanged');
  await assert.rejects(resolveAgentMarkdown('planner',f.builtin,f.project),/Conflicting/);
  await f.write('---\nname: planner\nextends: relay/planner\nsections:\n  replace: [Planner/Missing]\n---\n# Planner\n## Missing\nChanged');
  await assert.rejects(resolveAgentMarkdown('planner',f.builtin,f.project),/missing in base/);
  await f.write('---\nname: planner\nsections:\n  replace: [Planner/B]\n---\n## B\nChanged');
  await assert.rejects(resolveAgentMarkdown('planner',f.builtin,f.project),/require extends/);
  await rm(join(f.project,'agents','planner.agent.md'));
  await symlink(join(f.builtin,'planner.agent.md'),join(f.project,'agents','planner.agent.md'));
  await assert.rejects(resolveAgentMarkdown('planner',f.builtin,f.project),/escapes context root/);
});
