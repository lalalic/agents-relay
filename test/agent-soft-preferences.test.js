import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveExecutionContext } from '../dist/execution-context.js';
import { managedWorkerInput } from '../dist/managed-worker-input.js';
import { agentModelPreferenceForJob } from '../dist/reconciler-context.js';
import { routeExecution } from '../dist/execution-routing.js';

test('agent frontmatter is advisory in worker prompt and model routing, including inherited definitions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-agent-soft-hints-'));
  try {
    const project = join(root, 'project'), shared = join(root, 'shared'), globalRoot = join(root, 'global');
    await Promise.all([mkdir(join(project, 'agents'), { recursive: true }), mkdir(join(shared, 'agents'), { recursive: true }), mkdir(globalRoot)]);
    await writeFile(join(shared, 'agents', 'vlog-editor.agent.md'), '---\nname: vlog-editor\nmodel: zai/glm-old\nreasoning: medium\n---\nShared editor role.');
    await writeFile(join(project, 'agents', 'vlog-editor.agent.md'), [
      '---', 'name: vlog-editor', 'extends: shared/vlog-editor',
      'skills: [shotcraft, markcut]', 'model: openai/gpt-6', 'reasoning: high', '---', 'Project editor guidance.',
    ].join('\n'));
    const roots = { workspaceRoot: root, sharedRoot: shared, globalRoot };
    const context = await resolveExecutionContext(project, 'worker', roots);
    const editor = context.agents.find(agent => agent.name === 'vlog-editor');
    assert.deepEqual(editor.suggestedSkills, ['shotcraft', 'markcut']);
    assert.equal(editor.preferredModel, 'openai/gpt-6');
    assert.equal(editor.preferredReasoning, 'high');
    assert.deepEqual(context.skills, [], 'suggestions do not install, filter, or require skills');

    const job = { id: 'test-job', repository: 'repo', title: 'Make vlog', tasks: [], plans: [] };
    const task = { id: 'test-task', title: 'Compose video', executionId: 'exec-test', agentName: 'vlog-editor',
      adapter: 'codex', output: { kind: 'task_pr' }, input: 'private task input', kind: 'work' };
    const prompt = await managedWorkerInput(job, task, context);
    assert.match(prompt, /Suggested skills \(optional, use only when relevant and available\): shotcraft, markcut/);
    assert.doesNotMatch(prompt, /Prefer model: openai\/gpt-6|Prefer reasoning: high/);
    assert.doesNotMatch(prompt, /private task input/);
    const preference = await agentModelPreferenceForJob({ projectPathForJob: () => { throw new Error('execution path must not run'); }, agentPreferenceContextPathForJob: () => project, executionContextRoots: roots }, job, 'vlog-editor', task);
    assert.deepEqual(preference, { model: 'openai/gpt-6', reasoning: 'high' });

    const noPreference = await agentModelPreferenceForJob({ agentPreferenceContextPathForJob: () => project, executionContextRoots: roots }, job, 'missing-agent', task);
    assert.equal(noPreference, undefined, 'missing advisory Agent must not block the router');
    assert.equal(await agentModelPreferenceForJob({}, job, undefined, task), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('model preference is only appended to Router prompt; cannot add routes, override user guidance, or bypass constraints', async () => {
  const home = await mkdtemp(join(tmpdir(), 'relay-model-soft-hints-'));
  const oldHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    await writeFile(join(home, 'config.toml'), 'model = "gpt-default"\nmodel_provider = "openai"\nmodel_reasoning_effort = "medium"\n');
    const rules = join(home, 'router-rules.md');
    await writeFile(rules, '[routing-instruction]\nPrefer the standard configured route when available.\n');
    const calls = [];
    const engine = { name: 'capture', async decide(facts, contract) {
      calls.push({ facts, contract });
      return { type: 'choice', choice: contract.choices[0] };
    }};
    const workers = [
      { workerId: 'codex', adapter: 'codex', runtime: 'codex', capabilities: ['model'] },
      { workerId: 'chatgpt/browser-worker', adapter: 'chatgpt', runtime: 'chatgpt', capabilities: ['model'],
        browserWorkspaceCapacity: { available: 1 } },
    ];
    const options = { rulesPath: rules, decisionEngine: engine, decisionMode: 'active', taskFacts: { storySize: 'S' },
      modelPreference: { model: 'openai/gpt-does-not-exist', reasoning: 'high' } };
    const routed = await routeExecution(workers, { capabilities: ['model'] }, options);
    assert.equal(calls.length, 1);
    assert.match(calls[0].contract.question, /Prefer the standard configured route/);
    assert.match(calls[0].contract.question, /Agent model preference \(advisory only;/);
    assert.match(calls[0].contract.question, /Prefer model: openai\/gpt-does-not-exist/);
    assert.match(calls[0].contract.question, /Prefer reasoning: high/);
    assert.ok(calls[0].contract.choices.every(choice => !choice.includes('gpt-does-not-exist')));
    assert.notEqual(routed.candidate.routing.model, 'gpt-does-not-exist');

    calls.length = 0;
    const constrained = await routeExecution(workers, { capabilities: ['model'] }, {
      ...options, routingConstraints: { provider: 'openai', model: 'gpt-default' },
    });
    assert.equal(constrained.candidate.routing.model, 'gpt-default');
    assert.equal(calls.length, 0, 'single legal route remains authoritative even with a different preferred model');

    calls.length = 0;
    await routeExecution(workers, { capabilities: ['model'] }, { ...options, modelPreference: undefined });
    assert.doesNotMatch(calls[0].contract.question, /Agent model preference/);
  } finally {
    if (oldHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
});

test('reconciler forwards the selected task Agent preference to the real unified Router', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-agent-routing-integration-'));
  const oldHome = process.env.CODEX_HOME;
  const home = join(root, 'codex-home'), project = join(root, 'project');
  process.env.CODEX_HOME = home;
  try {
    await Promise.all([mkdir(home), mkdir(join(project, 'agents'), { recursive: true })]);
    await writeFile(join(home, 'config.toml'), 'model = "gpt-default"\nmodel_provider = "openai"\nmodel_reasoning_effort = "medium"\n');
    await writeFile(join(home, 'models_cache.json'), JSON.stringify({ models: [
      { slug: 'gpt-alt', visibility: 'list', supported_in_api: true, priority: 1,
        supported_reasoning_levels: [{ effort: 'high' }] },
    ] }));
    const rules = join(root, 'rules.md');
    await writeFile(rules, '[choices]\nopenai: gpt-alt high\n');
    await writeFile(join(project, 'agents', 'implementation.agent.md'),
      '---\nname: implementation\nmodel: openai/gpt-alt\nreasoning: high\n---\nImplement the Task.');
    const { InMemoryStore } = await import('../dist/store.js');
    const { managedReconciler } = await import('./test-runtime.js');
    const now = new Date().toISOString();
    const task = { id: 'task-1', jobId: 'job-1', kind: 'work', agentName: 'implementation', state: 'QUEUED',
      adapter: 'codex', capabilities: ['model'], input: 'Implement', output: { kind: 'task_pr' }, storySize: 'M', attempt: 0, maxAttempts: 1,
      dependencies: [], executionId: null, leaseOwner: null, leaseExpiresAt: null, createdAt: now, updatedAt: now };
    const job = { id: 'job-1', repository: 'project', prNumber: 1, title: 'Test',
      state: 'ACTIVE', tasks: [task], createdAt: now, updatedAt: now };
    const store = new InMemoryStore(job);
    const calls = [];
    const engine = { name: 'capture', async decide(_facts, contract) {
      calls.push(contract);
      return { type: 'choice', choice: contract.choices[0] };
    }};
    const reconciler = managedReconciler(store, { owner: 'test', adapters: [
      { name: 'codex', id: 'codex', capabilities: ['model'] },
    ], decisionEngine: engine, decisionMode: 'active', maxConcurrent: 0,
    projectPathForJob: () => { throw new Error('route must not start or prepare the Task worktree'); },
    agentPreferenceContextPathForJob: () => project,
    executionContextRoots: { workspaceRoot: root, globalRoot: home },
    });
    // Explicit rules remain the Router's authoritative candidate source.
    const oldRules = process.env.AGENTS_RELAY_EXECUTION_ROUTER_RULES;
    process.env.AGENTS_RELAY_EXECUTION_ROUTER_RULES = rules;
    try {
      const result = await reconciler.routeTaskForExecution(job, task);
      assert.equal(result.routed, true);
      assert.equal(calls.length, 1);
      assert.match(calls[0].question, /Prefer model: openai\/gpt-alt/);
      assert.match(calls[0].question, /Prefer reasoning: high/);
      assert.ok(calls[0].choices.some(choice => choice.includes('gpt-alt')));
      assert.ok(calls[0].choices.some(choice => choice.includes('gpt-default')));
    } finally {
      if (oldRules === undefined) delete process.env.AGENTS_RELAY_EXECUTION_ROUTER_RULES;
      else process.env.AGENTS_RELAY_EXECUTION_ROUTER_RULES = oldRules;
    }
  } finally {
    if (oldHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldHome;
    await rm(root, { recursive: true, force: true });
  }
});

test('Planner Agent skill suggestions appear in Planner User Assignment without requiring installed skills', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-planner-soft-skills-'));
  try {
    const project = join(root, 'project'), globalRoot = join(root, 'global');
    await Promise.all([mkdir(join(project, 'agents'), { recursive: true }), mkdir(globalRoot)]);
    await writeFile(join(project, 'agents', 'planner.agent.md'),
      '---\nname: planner\nextends: relay/planner\nskills: [ponytail, spec-kit]\nmodel: openai/gpt-6\nreasoning: high\n---\nUse a focused Plan.');
    const context = await resolveExecutionContext(project, 'planner', { workspaceRoot: root, globalRoot });
    const { buildPlannerExecutionPrompt } = await import('../dist/planner.js');
    const prompt = await buildPlannerExecutionPrompt({
      job: { id: 'job-planner', repository: 'project', title: 'Plan' },
      planExecution: { planId: 'plan-1', executionId: 'exec-planner' },
      executionContext: context,
    });
    assert.match(prompt, /Suggested skills \(optional, use only when relevant and available\): ponytail, spec-kit/);
    assert.doesNotMatch(prompt, /Prefer model: openai\/gpt-6|Prefer reasoning: high/);
    assert.deepEqual(context.skills, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
