import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveExecutionContext } from '../dist/execution-context.js';
import { managedWorkerInput } from '../dist/reconciler.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agents-relay-context-'));
  const project = join(root, 'project');
  const neo = join(root, 'neo');
  const global = join(root, 'global');
  for (const directory of [project, neo, global]) await mkdir(directory, { recursive: true });
  async function skill(base, name, description = name) {
    const directory = join(base, 'skills', name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${name}`);
    return directory;
  }
  await skill(join(project), 'duplicate', 'project');
  await skill(join(project), 'project-only');
  await skill(join(neo), 'duplicate', 'neo');
  const browser = await skill(join(neo), 'chatgpt-browser-worker');
  await mkdir(join(browser, 'agents'), { recursive: true });
  await writeFile(join(browser, 'agents', 'browser-worker.agent.md'), '# browser worker');
  await skill(join(global), 'duplicate', 'global');
  await skill(join(global), 'global-only');
  await mkdir(join(project, 'agents'), { recursive: true });
  await writeFile(join(project, 'agents', 'nested.agent.md'), '---\nname: nested\ncapabilities: inspect,delegate\ntrust: public\n---\n');
  await mkdir(join(neo, 'agents'), { recursive: true });
  await writeFile(join(neo, 'agents', 'reviewer.agent.md'), '---\nname: reviewer\ncapabilities: review\n---\n');
  await mkdir(join(global, 'agents'), { recursive: true });
  await writeFile(join(global, 'agents', 'fallback.agent.md'), '# fallback');
  await writeFile(join(project, 'AGENTS.md'), 'project instructions');
  await writeFile(join(neo, 'AGENTS.md'), 'neo instructions');
  return { root, project, neo, global };
}

test('execution context uses project > Neo > global precedence and exposes runtime paths', async () => {
  const value = await fixture();
  try {
    const context = await resolveExecutionContext(value.project, 'worker', undefined, undefined, { neoRoot: value.neo, globalSkillsRoot: join(value.global, 'skills'), globalAgentsRoot: join(value.global, 'agents') });
    assert.equal(context.skills.find(item => item.name === 'duplicate')?.source, 'project');
    assert.equal(context.skills.find(item => item.name === 'duplicate')?.path, join(value.project, 'skills', 'duplicate', 'SKILL.md'));
    assert.equal(context.skills.find(item => item.name === 'global-only')?.source, 'global');
    assert.equal(context.skills.find(item => item.name === 'chatgpt-browser-worker')?.path, join(value.neo, 'skills', 'chatgpt-browser-worker', 'SKILL.md'));
    assert.equal(context.agents.find(item => item.name === 'nested')?.source, 'project');
    assert.deepEqual(context.agents.find(item => item.name === 'nested')?.capabilities, ['inspect', 'delegate']);
    assert.equal(context.agents.find(item => item.name === 'fallback')?.source, 'global');
    assert.match(context.instructions, /project instructions/);
    assert.match(context.instructions, /neo instructions/);
    assert.equal(context.runtimes.find(item => item.name === 'chatgpt-browser-worker')?.path, join(value.neo, 'skills', 'chatgpt-browser-worker'));
    assert.deepEqual(context.delegation, { allowed: true, mechanism: 'agents-relay-child-task' });
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test('explicit selections are resolved and missing projects/selections fail clearly', async () => {
  const value = await fixture();
  try {
    const context = await resolveExecutionContext(value.project, 'nested-worker', ['global-only'], ['reviewer'], { neoRoot: value.neo, globalSkillsRoot: join(value.global, 'skills'), globalAgentsRoot: join(value.global, 'agents'), parentTaskId: 'parent' });
    assert.deepEqual(context.skills.map(item => item.name), ['global-only']);
    assert.deepEqual(context.agents.map(item => item.name), ['reviewer']);
    assert.equal(context.delegation.parentTaskId, 'parent');
    await assert.rejects(() => resolveExecutionContext(join(value.root, 'missing'), 'worker'), /does not exist/);
    await assert.rejects(() => resolveExecutionContext(value.project, 'worker', ['missing'], undefined, { neoRoot: value.neo }), /not visible/);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test('managed worker prompt preserves nested lineage and Relay-only delegation', () => {
  const prompt = managedWorkerInput({ id: 'job', repository: 'owner/repo', prNumber: 1 }, { id: 'child', parentTaskId: 'parent', projectName: 'project', adapter: 'codex', input: 'work', output: { kind: 'task_pr' } }, { project: { path: '/project' }, role: 'nested-worker', instructions: '', instructionFiles: [], skills: [], agents: [], runtimes: [], delegation: { allowed: true, mechanism: 'agents-relay-child-task', parentTaskId: 'parent' } });
  assert.match(prompt, /parentTaskId=child/);
  assert.match(prompt, /never spawn an arbitrary child agent directly/);
});
