import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveAgentMarkdown } from '../dist/agent-content-resolver.js';
import { resolveExecutionContext, resolveAgentContract } from '../dist/execution-context.js';

test('project Agent extends differently named absolute SKILL.md', async t => {
  const root = await mkdtemp(join(tmpdir(), 'relay-absolute-base-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const project=join(root,'project'), builtins=join(root,'builtin'), pool=join(root,'pool');
  await Promise.all([mkdir(join(project,'agents'),{recursive:true}),mkdir(builtins),mkdir(pool)]);
  const base=join(pool,'SKILL.md'), local=join(project,'agents','campaign-strategist.agent.md');
  await writeFile(base, "---\nname: 'agency-growth-hacker'\n---\n# Strategy\n## Channel\nOriginal channel\n## Research\nOriginal research\n[guide](./guide.md)");
  await writeFile(local, `---\nname: campaign-strategist\nextends: \"${base}\"\nsections:\n  replace: [Strategy/Channel]\n---\n# Strategy\n## Channel\nNew channel`);
  const resolved=await resolveAgentMarkdown('campaign-strategist',builtins,project);
  assert.deepEqual(resolved.sources,[await realpath(base),await realpath(local)]);
  assert.match(resolved.content,/New channel/);
  assert.match(resolved.content,/Original research/);
  assert.doesNotMatch(resolved.content,/Original channel/);
  assert.match(resolved.content,/pool\/guide.md/);
  const context=await resolveExecutionContext(project,'worker',{workspaceRoot:root,explicitAgents:['campaign-strategist']});
  const first=await resolveAgentContract(context,'campaign-strategist');
  assert.equal(first.hash,resolved.hash);
  await writeFile(base,"---\nname: agency-growth-hacker\n---\n# Strategy\n## Channel\nOriginal channel\n## Research\nUpdated research");
  const second=await resolveAgentContract(context,'campaign-strategist');
  assert.notEqual(second.hash,first.hash);
  assert.match(second.definition,/Updated research/);
});

test('absolute base rejects missing and malformed references', async t => {
  const root=await mkdtemp(join(tmpdir(),'relay-bad-base-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const project=join(root,'project'),builtin=join(root,'builtin'),source=join(root,'base.md');
  await Promise.all([mkdir(join(project,'agents'),{recursive:true}),mkdir(builtin)]);
  const target=join(project,'agents','role.agent.md');
  await writeFile(target,`---\nname: role\nextends: ${source}\n---\n# Role`);
  await assert.rejects(resolveAgentMarkdown('role',builtin,project),/ENOENT/);
  await writeFile(source,'# Unnamed profile');
  await assert.rejects(resolveAgentMarkdown('role',builtin,project),/requires name frontmatter/);
  await writeFile(source,'---\nname: specialist\n---\n');
  await assert.rejects(resolveAgentMarkdown('role',builtin,project),/nonempty body/);
  await writeFile(source,'---\nname: specialist\nextends: relay/specialist\n---\n# Specialist');
  await assert.rejects(resolveAgentMarkdown('role',builtin,project),/standalone definition/);
  await writeFile(target,'---\nname: role\nextends: ../role.md\n---\n# Role');
  await assert.rejects(resolveAgentMarkdown('role',builtin,project),/absolute Markdown path/);
});
