import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveExecutionContext } from '../dist/execution-context.js';
import { managedWorkerInput } from '../dist/reconciler.js';

async function skill(root, name, body = `---\nname: ${name}\n---\n`) {
  const dir = join(root, 'skills', name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), body);
  return join(dir, 'SKILL.md');
}
async function agent(root, name, capabilities = 'review') {
  const dir = join(root, 'agents');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${name}.agent.md`);
  await writeFile(path, `---\nname: ${name}\ntype: worker\ncapabilities: [${capabilities}]\ntrust_domains: [local]\nruntimes: [codex]\n---\n`);
  return path;
}

test('shared execution context resolves precedence, fallbacks, explicit selections, and visible agents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-relay-context-'));
  try {
    const workspace = join(root, 'workspace');
    const neo = join(workspace, 'neo');
    const project = join(workspace, 'project');
    const globalRoot = join(root, 'global');
    await Promise.all([mkdir(project, { recursive: true }), mkdir(neo, { recursive: true }), mkdir(globalRoot, { recursive: true })]);
    await writeFile(join(globalRoot, 'AGENTS.md'), 'global');
    await writeFile(join(neo, 'AGENTS.md'), 'neo');
    await writeFile(join(project, 'AGENTS.md'), 'project');
    await writeFile(join(project, 'README.md'), 'readme');
    const globalShared = await skill(globalRoot, 'shared');
    const neoShared = await skill(neo, 'shared');
    const projectShared = await skill(project, 'shared');
    const globalOnly = await skill(globalRoot, 'global-only');
    const browserWorker = await skill(neo, 'chatgpt-browser-worker');
    await skill(neo, 'neo-only');
    await agent(globalRoot, 'duplicate', 'global');
    await agent(neo, 'duplicate', 'neo');
    const projectAgent = await agent(project, 'duplicate', 'project,review');
    const reviewer = await agent(neo, 'reviewer', 'review');

    const context = await resolveExecutionContext(project, 'worker', {
      workspaceRoot: workspace,
      neoRoot: neo,
      globalRoot,
      runtimes: [{ adapter: 'codex', capabilities: ['model', 'codex'] }],
    });
    const bySkill = new Map(context.skills.map(item => [item.name, item]));
    assert.equal(bySkill.get('shared').source, 'project');
    assert.equal(bySkill.get('shared').path, await realpath(projectShared));
    assert.equal(bySkill.get('global-only').path, await realpath(globalOnly));
    assert.equal(bySkill.get('chatgpt-browser-worker').path, await realpath(browserWorker));
    assert.notEqual(bySkill.get('shared').path, await realpath(neoShared));
    assert.notEqual(bySkill.get('shared').path, await realpath(globalShared));
    const byAgent = new Map(context.agents.map(item => [item.name, item]));
    assert.equal(byAgent.get('duplicate').path, await realpath(projectAgent));
    assert.deepEqual(byAgent.get('duplicate').capabilities, ['project', 'review']);
    assert.deepEqual(byAgent.get('duplicate').trustDomains, ['local']);
    assert.deepEqual(byAgent.get('duplicate').delegation, []);
    assert.equal(byAgent.get('reviewer').path, await realpath(reviewer));
    assert.deepEqual(context.instructions.map(item => item.source), ['global', 'project', 'project']);
    const neoAgents = await realpath(join(neo, 'AGENTS.md'));
    assert.equal(context.instructions.some(item => item.path === neoAgents), false);
    assert.deepEqual(context.runtimes, [{ name: 'codex', id: undefined, capabilities: ['model', 'codex'], source: 'runtime' }]);

    const selected = await resolveExecutionContext(project, 'reviewer', { workspaceRoot: workspace, neoRoot: neo, globalRoot, explicitSkills: ['neo-only'], explicitAgents: ['reviewer'] });
    assert.deepEqual(selected.skills.map(item => item.name), ['neo-only']);
    assert.deepEqual(selected.agents.map(item => item.name), ['reviewer']);
    await assert.rejects(resolveExecutionContext(project, 'worker', { workspaceRoot: workspace, neoRoot: neo, globalRoot, explicitSkills: ['missing'] }), /not visible/);
    await assert.rejects(resolveExecutionContext(project, 'worker', { workspaceRoot: workspace, neoRoot: neo, globalRoot, explicitAgents: ['missing-agent'] }), /not visible/);
    await assert.rejects(resolveExecutionContext(join(root, 'missing-project'), 'worker', { workspaceRoot: workspace, neoRoot: neo, globalRoot }), /Project path not found/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('registered agents preserve runtime, trust, and delegation restrictions without overriding local definitions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-relay-registry-context-'));
  try {
    const project = join(root, 'project');
    await mkdir(project, { recursive: true });
    const registration = {
      id:'remote-1', name:'remote-reviewer', responsibility:'review public diffs', role:'reviewer', capabilities:['review'],
      boundaries:['no credentials','relay delegation only'], endpoint:{kind:'adapter',target:'codex'}, runtime:{adapter:'codex',provider:'openai',model:'gpt'},
      availability:'available', routing:{trustDomains:['public'],regions:['ca']}, evidence:{evaluations:[],outcomes:{succeeded:0,failed:0,timedOut:0},lastObservedAt:null},
      registeredAt:'2026-01-01T00:00:00Z', updatedAt:'2026-01-01T00:00:00Z'
    };
    const context = await resolveExecutionContext(project, 'worker', { workspaceRoot:root, neoRoot:null, globalRoot:join(root,'global'), registeredAgents:[registration] });
    const resolved = context.agents.find(item => item.name === 'remote-reviewer');
    assert.equal(resolved.source, 'registry');
    assert.equal(resolved.runtime, 'codex');
    assert.deepEqual(resolved.trustDomains, ['public']);
    assert.deepEqual(resolved.restrictions, ['no credentials','relay delegation only']);
  } finally { await rm(root, { recursive:true, force:true }); }
});

test('managed worker prompt exposes resolved context and durable retrieval guidance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-relay-nested-context-'));
  try {
    const project = join(root, 'project');
    await mkdir(project, { recursive: true });
    const context = await resolveExecutionContext(project, 'nested-worker', { workspaceRoot: root, globalRoot: join(root, 'global'), neoRoot: join(root, 'missing-neo') });
    const job = { id:'j', title:'job', executionMode:'fixed', prNumber:54, repository:'lalalic/agents-relay', state:'RUNNING', continuation:null, createdAt:'', updatedAt:'', tasks:[] };
    const task = { id:'child', taskUrl:'https://github.com/lalalic/agents-relay/pull/54#issuecomment-1', parentTaskId:'parent', dependencies:[], capabilities:[], adapter:'codex', input:'do work', output:{kind:'task_pr'}, routing:{provider:'openai',model:'gpt',decidedBy:'test',decidedAt:''}, state:'READY', attempt:0, maxAttempts:1, leaseOwner:null, leaseExpiresAt:null, executionId:null, threadId:null, result:null, error:null, timeoutMs:1000, createdAt:'', updatedAt:'' };
    const prompt = managedWorkerInput(job, task, context);
    assert.match(prompt, /Role: nested-worker/);
    assert.match(prompt, /Retrieve the durable job and task from GitHub before doing the work/);
    assert.match(prompt, /Task URL: https:\/\/github\.com\/lalalic\/agents-relay\/pull\/54#issuecomment-1/);
    assert.doesNotMatch(prompt, /do work/);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('context resolve CLI exposes the same resolver for XChat without durable state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-relay-context-cli-'));
  try {
    const workspace = join(root, 'workspace');
    const project = join(workspace, 'project');
    const globalRoot = join(root, 'global');
    await Promise.all([mkdir(project, { recursive: true }), mkdir(globalRoot, { recursive: true })]);
    await skill(globalRoot, 'shared');
    await skill(project, 'local');
    const result = spawnSync(process.execPath, [
      'dist/cli.js', 'context', 'resolve', '--project-path', project, '--role', 'orchestrator',
      '--workspace-root', workspace, '--neo-root', 'none', '--global-root', globalRoot, '--skills', 'local'
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const context = JSON.parse(result.stdout);
    assert.equal(context.role, 'orchestrator');
    assert.equal(context.project.path, await realpath(project));
    assert.deepEqual(context.skills.map(item => item.name), ['local']);
    assert.equal(context.delegation.mode, 'relay-child-task');
  } finally { await rm(root, { recursive: true, force: true }); }
});
