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
    const context = await resolveExecutionContext(projectPath, 'worker', { globalRoot: emptyGlobal });
    for (const role of ['planner', 'reviewer', 'troubleshooter', 'worker']) for (const adapter of ['codex', 'chatgpt']) {
      if (role === 'troubleshooter' && adapter !== 'codex') continue; // Agent runtime is codex-only.
      const task = { id: `task-${role}`, jobId: 'prompt-test', title: `Test ${role}`, state: 'QUEUED', kind: 'work',
        agentName: role === 'worker' ? 'implementation' : role, adapter, input: `UNTRUSTED TASK EVIDENCE ${role}`,
        output: { kind: 'task_pr' }, executionId: `execution-${role}`, attempt: 1, maxAttempts: 1, dependencies: [] };
      const prompt = await managedWorkerInput({ id: 'prompt-test', repository: 'example/repo', title: 'Prompt test', objective: 'Verify assembled prompts', state: 'ACTIVE', localMerge: { sourceRef: 'prompt-test' }, tasks: [task], plans: [] }, task, context);
      assert.match(prompt, /^# Role\nYou are /);
      assert.match(prompt, /## Contracts\n/);
      assert.match(prompt, /## Contexts\n/);
      assert.match(prompt, /## Task\n/);
      assert.match(prompt, /## User Assignment\n/);
      assert.ok(prompt.indexOf('## User Assignment') > prompt.indexOf('## Task'));
      assert.ok(prompt.includes(`Assigned ${role === 'planner' ? 'Plan' : 'Task'} title (locator):`));
      if (role === 'worker') {
        assert.match(prompt, /at least TWO independent full Task-to-result review\/fix rounds/);
        assert.match(prompt, /reading context, starting, or summarizing it is preparation only/);
        assert.match(prompt, /For EACH completed self-review round .*publish a separate correlated `task.progress` event/);
      } else assert.doesNotMatch(prompt, /at least TWO independent full Task-to-result/);
      assert.match(prompt, new RegExp(`Task: task-${role}\\nExecution: execution-${role}`));
      assert.doesNotMatch(prompt, new RegExp(`UNTRUSTED TASK EVIDENCE ${role}`));
      assert.doesNotMatch(prompt, /GitHub is the source of truth|Job URL: null|\[Resolved execution context\]/);
      const match = prompt.match(/^You are [^\n]+ with responsibility at (\/\S+\.md)/m);
      assert.ok(match, `${role}/${adapter} must carry the resolved Agent snapshot`);
      assert.doesNotMatch(prompt, /\(sha256:/);
      assert.doesNotMatch(prompt, /Use the agents-relay skill at \//);
      assert.match(await readFile(match[1], 'utf8'), new RegExp(role === 'worker' ? 'implementation' : role, 'i'));
      assert.ok(prompt.length < 4500, `${role}/${adapter} must remain compact`);
      assert.ok(prompt.indexOf('## Contracts') < prompt.indexOf('## Contexts'));
      assert.ok(prompt.indexOf('## Contexts') < prompt.indexOf('## Task'));
    }
  } finally {
    if (refDir === undefined) delete process.env.AGENTS_RELAY_PROMPT_REFERENCE_DIR;
    else process.env.AGENTS_RELAY_PROMPT_REFERENCE_DIR = refDir;
    await rm(emptyGlobal, { recursive: true, force: true });
    await rm(snapshotDir, { recursive: true, force: true });
  }
});

test('regression: implementation Task cannot be interpreted as only context retrieval', async () => {
  const context = await resolveExecutionContext(resolve('.'), 'worker');
  const task = { id:'893', jobId:'601', title:'Implement opt-in Rust Core parity', kind:'work',
    state:'RUNNING', agentName:'implementation', adapter:'codex',
    input:'Implement native Rust Core; validate MCP E2E and complete implementation self review.',
    output:{kind:'task_pr'}, executionId:'exec-893', attempt:1, maxAttempts:3, dependencies:[] };
  const job = { id:'601', repository:'lalalic/neox', title:'Rust NeoY Core', objective:'Build Rust Core', state:'ACTIVE', tasks:[task], plans:[] };
  const prompt = await managedWorkerInput(job,task,context);
  const assignment = prompt.split('## User Assignment\n')[1];
  assert.ok(assignment, 'The task-specific user assignment must be last');
  assert.match(assignment,/Implement opt-in Rust Core parity/);
  assert.match(assignment,/Read the FULL authoritative Task input, output, and acceptance criteria/);
  assert.match(assignment,/reading context, starting, or summarizing it is preparation only/);
  assert.match(assignment,/at least TWO independent full Task-to-result review\/fix rounds/);
  assert.match(assignment,/reread the Task requirements, check every requirement, fix real gaps, and review again until clean/);
  assert.match(assignment,/if you cannot fulfill the Task, report task.failed/);
  assert.match(assignment,/For EACH completed self-review round .*publish a separate correlated `task.progress` event/);
  assert.match(assignment,/round number, Task requirements checked, findings, fixes and verification outcome/);
  assert.match(assignment,/Verify event acceptance before continuing or publishing the terminal event/);
  assert.doesNotMatch(prompt,/Implement native Rust Core; validate MCP E2E/, 'Authoritative Task text still comes from SQLite context');
});

test('evaluation mode preserves reviewer guidance without production lifecycle actions', async () => {
  const projectPath = resolve('.');
  const emptyGlobal = await mkdtemp(join(tmpdir(), 'relay-prompt-eval-global-'));
  try {
    const context = await resolveExecutionContext(projectPath, 'worker', { globalRoot: emptyGlobal });
    const task = { id: 'task-reviewer', jobId: 'prompt-test', title: 'Test reviewer', state: 'QUEUED', kind: 'work',
      agentName: 'reviewer', adapter: 'codex', input: 'Evidence: end-to-end verification did not run.',
      output: { kind: 'task_pr' }, executionId: 'execution-reviewer', attempt: 1, maxAttempts: 1, dependencies: [] };
    const prompt = await managedWorkerInput({ id: 'prompt-test', repository: 'example/repo', title: 'Prompt test', objective: 'Evaluate reviewer contract', state: 'ACTIVE', localMerge: { sourceRef: 'prompt-test' }, tasks: [task], plans: [] }, task, context, 'evaluation');
    assert.match(prompt, /evidence|review/i);
    assert.match(prompt, /read-only evaluation/i);
    assert.doesNotMatch(prompt, /publish exactly one canonical task\.(?:started|completed|failed)|events__publish|EVENTS_BUS_EMIT/);
  } finally { await rm(emptyGlobal, { recursive: true, force: true }); }
});

test('Job without PR or localMerge still dispatches only a Task ID and authoritative SQLite lookup', async () => {
  const context = await resolveExecutionContext(resolve('.'), 'worker');
  const task = {id:'476',jobId:'537',title:'Production',state:'QUEUED',kind:'work',adapter:'chatgpt',
    agentName:'implementation',input:'PRIVATE EPISODE INSTRUCTIONS MUST NOT LEAK',output:{kind:'file',path:'runs/result.md'},
    executionId:'123e4567-e89b-12d3-a456-426614174000',attempt:1,maxAttempts:3,dependencies:[],comments:[{id:'c1',text:'PRIVATE TASK COMMENT MUST NOT LEAK',author:'owner',createdAt:'now'}]};
  const prompt = await managedWorkerInput({id:'537',repository:'lalalic/neo',prNumber:0,title:'Vlog',objective:'PRIVATE JOB OBJECTIVE MUST NOT LEAK',state:'ACTIVE',tasks:[task],plans:[]},task,context);
  assert.match(prompt,/Job: 537\nTask: 476\nExecution: 123e4567/);
  for (const forbidden of ['Job URL: null','GitHub is the source of truth','PRIVATE EPISODE','PRIVATE TASK COMMENT','PRIVATE JOB OBJECTIVE', 'Resolved execution context']) assert.ok(!prompt.includes(forbidden),forbidden);
  assert.ok(prompt.length < 4300, `Production prompt is ${prompt.length} chars`);
});

test('managed worker receives provider instructions only from Job Execution Context and uses actual owning Git root as cwd', async t => {
  const { mkdir, writeFile }=await import('node:fs/promises');
  const { execFileSync }=await import('node:child_process');
  const root=await mkdtemp(join(tmpdir(),'relay-repository-context-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const repository=join(root,'repo'); const project=join(repository,'nested-project');
  await mkdir(project,{recursive:true});
  execFileSync('git',['init','-q',repository]);
  await writeFile(join(project,'AGENTS.md'),'# Caller project instructions');
  const context=await resolveExecutionContext(project,'worker',{
    workspaceRoot:root,globalRoot:join(root,'global'),
    providerInstructions:{codex:['Use caller-provided Codex local executor.'],chatgpt:['Use caller-provided remote file tools.']},
  });
  assert.equal(context.project.gitRoot,await (await import('node:fs/promises')).realpath(repository));
  const job={id:'repo-context',repository:'local/repo',title:'Context',objective:'Contract',state:'ACTIVE',tasks:[],plans:[]};
  const task={id:'work',jobId:'repo-context',kind:'work',agentName:'implementation',state:'QUEUED',adapter:'codex',input:'untrusted',
    output:{kind:'task_pr'},executionId:'exec-1',attempt:1,maxAttempts:1,dependencies:[]};
  const codex=await managedWorkerInput(job,task,context);
  assert.match(codex,new RegExp(`Git repository working directory \\(cwd\\): ${context.project.gitRoot.replaceAll('/','\\/')}`));
  assert.match(codex,/Use caller-provided Codex local executor/);
  assert.doesNotMatch(codex,/Use caller-provided remote file tools|Neo MCP|neoy\.qili2\.com|The Z runtime/);
  const chatgpt=await managedWorkerInput(job,{...task,adapter:'chatgpt'},context);
  assert.match(chatgpt,/Use caller-provided remote file tools/);
  assert.doesNotMatch(chatgpt,/Use caller-provided Codex local executor/);
  assert.match(chatgpt,/\[project\].*AGENTS\.md/);
});
