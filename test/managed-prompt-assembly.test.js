import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { managedWorkerInput } from '../dist/managed-worker-input.js';
import { resolveExecutionContext } from '../dist/execution-context.js';

test('production worker prompt assembly separates roles and snapshots each effective contract', async () => {
  const projectPath = resolve('.');
  const emptyGlobal = await mkdtemp(join(tmpdir(), 'relay-prompt-global-'));
  const refDir = process.env.AGENTS_RELAY_PROMPT_REFERENCE_DIR;
  const snapshotDir = await mkdtemp(join(tmpdir(), 'relay-prompt-snapshots-'));
  process.env.AGENTS_RELAY_PROMPT_REFERENCE_DIR = snapshotDir;
  try {
    const context = await resolveExecutionContext(projectPath, 'worker', { workspaceRoot: projectPath, globalRoot: emptyGlobal });
    for (const role of ['planner', 'reviewer', 'troubleshooter', 'worker']) for (const adapter of ['codex', 'chatgpt']) {
      const task = { id: `task-${role}`, jobId: 'prompt-test', title: `Test ${role}`, state: 'QUEUED', kind: 'work',
        agentName: role === 'worker' ? 'implementation' : role, adapter, input: `UNTRUSTED TASK EVIDENCE ${role}`,
        output: { kind: 'task_pr' }, executionId: `execution-${role}`, attempt: 1, maxAttempts: 1, dependencies: [] };
      const prompt = await managedWorkerInput({ id: 'prompt-test', repository: 'example/repo', title: 'Prompt test', objective: 'Verify assembled prompts', state: 'ACTIVE', localMerge: { sourceRef: 'prompt-test' }, tasks: [task], plans: [] }, task, context);
      assert.match(prompt, new RegExp(`Relay agent: ${role}; adapter: ${adapter}`));
      assert.match(prompt, /\[Versioned local references\]/);
      assert.ok(prompt.indexOf('[Agent instructions') < prompt.indexOf('[Task data'));
      assert.match(prompt, /\[Required event contracts\][\s\S]*Execution source: job\/prompt-test\/task\//);
      assert.match(prompt, new RegExp(`UNTRUSTED TASK EVIDENCE ${role}`));
      const match = prompt.match(/^- instructions: (.+) \(sha256:([a-f0-9]{64})\)$/m);
      assert.ok(match, `${role}/${adapter} must carry an immutable contract reference`);
      assert.match(await readFile(match[1], 'utf8'), new RegExp(`Agent: ${role === 'worker' ? 'implementation' : role}`));
    }
  } finally {
    if (refDir === undefined) delete process.env.AGENTS_RELAY_PROMPT_REFERENCE_DIR;
    else process.env.AGENTS_RELAY_PROMPT_REFERENCE_DIR = refDir;
    await rm(emptyGlobal, { recursive: true, force: true });
    await rm(snapshotDir, { recursive: true, force: true });
  }
});

test('evaluation mode preserves reviewer guidance without production lifecycle actions', async () => {
  const projectPath = resolve('.');
  const emptyGlobal = await mkdtemp(join(tmpdir(), 'relay-prompt-eval-global-'));
  try {
    const context = await resolveExecutionContext(projectPath, 'worker', { workspaceRoot: projectPath, globalRoot: emptyGlobal });
    const task = { id: 'task-reviewer', jobId: 'prompt-test', title: 'Test reviewer', state: 'QUEUED', kind: 'work',
      agentName: 'reviewer', adapter: 'codex', input: 'Evidence: end-to-end verification did not run.',
      output: { kind: 'task_pr' }, executionId: 'execution-reviewer', attempt: 1, maxAttempts: 1, dependencies: [] };
    const prompt = await managedWorkerInput({ id: 'prompt-test', repository: 'example/repo', title: 'Prompt test', objective: 'Evaluate reviewer contract', state: 'ACTIVE', localMerge: { sourceRef: 'prompt-test' }, tasks: [task], plans: [] }, task, context, 'evaluation');
    assert.match(prompt, /evidence|review/i);
    assert.match(prompt, /read-only evaluation/i);
    assert.doesNotMatch(prompt, /publish exactly one canonical task\.(?:started|completed|failed)|events__publish|NEO_EVENTS_EMIT/);
  } finally { await rm(emptyGlobal, { recursive: true, force: true }); }
});
