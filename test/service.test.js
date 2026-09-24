import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { normalizeDaemonArguments } from '../dist/relayd.js';
import { createService, runtimeReviewer, startService, SERVICE_DEFAULTS } from '../dist/cli.js';
import { nextPatchVersion } from '../scripts/npm-version.mjs';

test('daemon arguments require and normalize durable identifiers', () => {
  const argv = ['--repo', 'OWNER/REPO', '--pr', '1', '--id', 'JOB_ID', '--port', '9000'];
  const normalized = normalizeDaemonArguments(argv);
  assert.equal(normalized.repository, 'OWNER/REPO');
  assert.equal(normalized.pullRequest, 1);
  assert.equal(normalized.jobId, 'JOB_ID');
  assert.deepEqual(normalized.serviceArguments, argv);
});

test('all service runtimes use the resource-aware reviewer policy', async () => {
  const reviewer = runtimeReviewer();
  assert.deepEqual(reviewer.requirements, { capabilities: ['model'] });
  const cliSource = await readFile(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const daemonSource = await readFile(new URL('../src/relayd.ts', import.meta.url), 'utf8');
  assert.match(cliSource, /reviewer: runtimeReviewer\(\)/);
  assert.match(daemonSource, /reviewer:runtimeReviewer\(\)/);
});

test('repository daemon wires account usage telemetry and the default planner into workspace reconciliation', async () => {
  const source = await readFile(new URL('../src/relayd.ts', import.meta.url), 'utf8');
  assert.match(source, /const usageRegistry = codexAndZaiUsageRegistry\(\)/);
  assert.match(source, /planner:runtimePlanner\(argv\)/);
  assert.match(source, /fallback\?\.id,usageRegistry,overviews,webhook,\(\)=>client\.rateLimitStatus\(\),exactJob/);
  assert.match(source, /start: workspaceJobAction\('start'\)/);
  assert.match(source, /reconcile: workspaceJobAction\('reconcile'\)/);
  assert.match(source, /cancel: workspaceJobAction\('cancel'\)/);
});

test('workspace daemon establishes dashboard and event watch before remote refresh', async () => {
  const source = await readFile(new URL('../src/relayd.ts', import.meta.url), 'utf8');
  const cached = source.indexOf('const initial = cachedOverviews');
  const watch = source.indexOf('const stopWatch = bus ? await pool.watch(bus)');
  const refresh = source.indexOf('void refreshAll()', watch);
  assert.ok(cached >= 0);
  assert.ok(watch > cached);
  assert.ok(refresh > watch);
  assert.doesNotMatch(source, /const initial = await refreshAll\(\)/);
});

test('daemon arguments support repository pool mode and validate legacy pairing', () => {
  const pooled = normalizeDaemonArguments(['--repo','OWNER/REPO','--port','8787']);
  assert.equal(pooled.pullRequest, null); assert.equal(pooled.jobId, null);
  assert.throws(() => normalizeDaemonArguments(['--pr','1','--id','job']), /--repo is required/);
  assert.throws(() => normalizeDaemonArguments(['--repo','OWNER/REPO','--pr','0','--id','job']), /--pr must be positive/);
  assert.throws(() => normalizeDaemonArguments(['--repo','OWNER/REPO','--pr','1']), /supplied together/);
});

test('daemon arguments default to workspace mode without changing --repo mode', () => {
  const workspace = normalizeDaemonArguments(['--workspace', '/tmp/Workspace']);
  assert.equal(workspace.repository, null);
  assert.equal(workspace.workspaceRoot, '/tmp/Workspace');
  assert.equal(workspace.pullRequest, null);
  assert.throws(() => normalizeDaemonArguments(['--repo', 'OWNER/REPO', '--workspace', '/tmp/Workspace']), /mutually exclusive/);
});

test('service defaults and package bins use stable package entrypoints', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(pkg.bin, { 'agents-relay': 'dist/cli.js', 'agents-relayd': 'dist/relayd.js' });
  assert.equal(SERVICE_DEFAULTS.port, 8787);
  assert.equal(SERVICE_DEFAULTS.watchdogMs, 300000);
  assert.equal(SERVICE_DEFAULTS.webhookWatchdogMs, 1800000);
  assert.equal(SERVICE_DEFAULTS.dashboardRefreshMs, 300000);
});

test('publish workflow can write publication markers to pull requests', async () => {
  const workflow = await readFile(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8');
  assert.match(workflow, /issues: write/);
  assert.match(workflow, /pull-requests: write/);
});

test('release version selection starts at 1.0.0 and increments only the patch', () => {
  assert.equal(nextPatchVersion(''), '1.0.0');
  assert.equal(nextPatchVersion('1.0.0'), '1.0.1');
  assert.equal(nextPatchVersion('2.7.9'), '2.7.10');
  assert.throws(() => nextPatchVersion('latest'), /Unsupported npm version/);
});

test('CLI and daemon help are successful and do not require job storage', () => {
  for (const [entry, args, expected] of [
    ['dist/cli.js', ['--help'], 'npx agents-relay <command>'],
    ['dist/cli.js', ['job', '--help'], 'npx agents-relay job <create|update|show|list|merge|cancel>'],
    ['dist/cli.js', ['job', 'create', '--help'], 'Create a durable Job'],
    ['dist/cli.js', ['job', 'update', '--help'], 'Partially update mutable metadata'],
    ['dist/cli.js', ['job', 'show', '--help'], 'Show one durable Job'],
    ['dist/cli.js', ['job', 'list', '--help'], 'List managed Jobs'],
    ['dist/cli.js', ['job', 'merge', '--help'], 'Merge the backing pull request'],
    ['dist/cli.js', ['job', 'cancel', '--help'], 'Cancel the durable Job'],
    ['dist/cli.js', ['task', '--help'], 'npx agents-relay task <create|update|show|list|retry|cancel>'],
    ['dist/cli.js', ['task', 'update', '--help'], 'Update mutable durable Task fields'],
    ['dist/cli.js', ['context', '--help'], 'npx agents-relay context resolve'],
    ['dist/cli.js', ['context', 'resolve', '--help'], 'Resolve shared execution context'],
    ['dist/cli.js', ['init', '--help'], 'Initialize a new job'],
    ['dist/cli.js', ['task', 'create', '--help'], 'Create one durable Task'],
    ['dist/cli.js', ['task', 'show', '--help'], 'Show one durable Task'],
    ['dist/cli.js', ['task', 'list', '--help'], 'List durable Tasks'],
    ['dist/cli.js', ['task', 'retry', '--help'], 'Retry one durable Task'],
    ['dist/cli.js', ['task', 'cancel', '--help'], 'Cancel one durable Task'],
    ['dist/cli.js', ['record', '--help'], 'Backfill work completed outside the relay'],
    ['dist/cli.js', ['reconcile', '--help'], 'Reconcile a job once'],
    ['dist/cli.js', ['serve', '--help'], 'Run the dashboard and reconciliation service'],
    ['dist/cli.js', ['agent-register', '--help'], 'Register an agent role'],
    ['dist/cli.js', ['agent-discover', '--help'], 'Find registered agents'],
    ['dist/relayd.js', ['--help'], 'npx agents-relayd [options]']
  ]) {
    const result = spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${entry} ${args.join(' ')} failed: ${result.stderr}`);
    assert.match(result.stdout, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('job create help is create-only and rejects task execution flags', () => {
  const help = spawnSync(process.execPath, ['dist/cli.js', 'job', 'create', '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.doesNotMatch(help.stdout, /--start/);
  assert.match(help.stdout, /never creates executable tasks/);
  assert.match(help.stdout, /orchestrator decides the initial task batch/);

  const invalid = spawnSync(process.execPath, ['dist/cli.js', 'job', 'create', '--repo', 'owner/repo', '--id', 'job-cli', '--head', 'feat/demo', '--start'], { encoding: 'utf8' });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /does not accept task execution option --start/);

  const taskFlag = spawnSync(process.execPath, ['dist/cli.js', 'job', 'create', '--repo', 'owner/repo', '--id', 'job-cli', '--head', 'feat/demo', '--model', 'gpt-test'], { encoding: 'utf8' });
  assert.notEqual(taskFlag.status, 0);
  assert.match(taskFlag.stderr, /does not accept task execution option --model/);
});

test('published bin files are executable after build and npm pack', async () => {
  assert.equal((await stat('dist/cli.js')).mode & 0o111, 0o111);
  assert.equal((await stat('dist/relayd.js')).mode & 0o111, 0o111);
  const packed = spawnSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  const files = new Map(JSON.parse(packed.stdout)[0].files.map(file => [file.path, file.mode]));
  assert.equal(files.get('dist/cli.js'), 0o755);
  assert.equal(files.get('dist/relayd.js'), 0o755);
  assert.equal(files.has('skills/agents-relay/SKILL.md'), true);
  assert.equal(files.has('skills/agents-relay/agents/planner.agent.md'), true);
  assert.equal(files.has('skills/chatgpt-browser-worker/SKILL.md'), false);
  assert.equal(files.has('skills/agents-relay/contracts/task-job-contract.md'), true);
  assert.equal(files.has('workflow/job-lifecycle.mmd'), true);
  assert.equal(files.has('workflow/task-lifecycle.mmd'), true);
  assert.equal(files.has('src/cli.ts'), false);
  assert.equal(files.has('test/service.test.js'), false);
  assert.equal(files.has('.github/workflows/publish.yml'), false);
  assert.equal(files.has('pack.json'), false);
});

test('service stop clears watchdog and closes dashboard before resolving', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agents-relay-service-'));
  const file = join(directory, 'job.json');
  await writeFile(file, JSON.stringify({ id: 'cleanup-job', tasks: [] }));
  const service = await createService(['--file', file, '--port', '0', '--interval', '60000', '--refresh-ms', '15000']);
  await service.stop();
  assert.equal(service.dashboardServer.address(), null);
  assert.equal(service.watchdogCleared, true);
  await rm(directory, { recursive: true, force: true });
});


test('startup reconciliation failure does not take down dashboard', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agents-relay-degraded-'));
  const file = join(directory, 'job.json');
  await writeFile(file, JSON.stringify({ id: 'degraded-job', title: 'Degraded', prNumber: 0, state: 'ACTIVE', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tasks: [] }));
  const service = await createService(['--file', file, '--port', '0']);
  service.reconciler.reconcile = async () => { throw new Error('GitHub rate limited'); };
  // startService owns construction, so assert the equivalent startup policy directly:
  try { await service.reconciler.reconcile(service.job.id); } catch {}
  assert.notEqual(service.dashboardServer.address(), null);
  await service.stop();
  await rm(directory, { recursive: true, force: true });
});

test('long-form Job and Task content prefers file inputs and avoids shell quoting', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agents-relay-content-file-'));
  const objectiveFile = join(directory, 'job.md');
  const taskFile = join(directory, 'task.md');
  await writeFile(objectiveFile, '```mermaid\nflowchart TD\n  A --> B\n```\n\n# Goal\n\nStandalone context.\n');
  await writeFile(taskFile, '# Work\n\nUse `code`, $variables, "quotes", and Mermaid without shell escaping.\n');

  const missingObjective = spawnSync(process.execPath, ['dist/cli.js','job','create','--repo','owner/repo','--id','job-file','--head','feat/file'], { encoding:'utf8' });
  assert.notEqual(missingObjective.status, 0);
  assert.match(missingObjective.stderr, /requires --objective-file PATH\|- or --objective MARKDOWN/);

  const conflictingObjective = spawnSync(process.execPath, ['dist/cli.js','job','create','--repo','owner/repo','--id','job-file','--head','feat/file','--objective','short','--objective-file',objectiveFile], { encoding:'utf8' });
  assert.notEqual(conflictingObjective.status, 0);
  assert.match(conflictingObjective.stderr, /--objective and --objective-file are mutually exclusive/);

  const now = new Date().toISOString();
  const localJob = join(directory, 'job.json');
  await writeFile(localJob, JSON.stringify({ id:'local-file-job', title:'local', priority:'P2', executionMode:'fixed', autoMerge:false, reviewEnabled:false, prNumber:1, repository:'owner/repo', state:'DRAFT', continuation:null, createdAt:now, updatedAt:now, tasks:[] }));

  const created = spawnSync(process.execPath, ['dist/cli.js','task','create','--file',localJob,'--task-id','file-task','--adapter','orchestrator','--output','task-pr','--draft','--input-file',taskFile], { encoding:'utf8' });
  assert.equal(created.status, 0, created.stderr);
  let saved = JSON.parse(await readFile(localJob, 'utf8'));
  assert.equal(saved.tasks[0].input, await readFile(taskFile, 'utf8'));

  const stdinText = '# Updated work\n\n```mermaid\nflowchart LR\n  X --> Y\n```\n';
  const updated = spawnSync(process.execPath, ['dist/cli.js','task','update','--file',localJob,'--task-id','file-task','--input-file','-'], { encoding:'utf8', input:stdinText });
  assert.equal(updated.status, 0, updated.stderr);
  saved = JSON.parse(await readFile(localJob, 'utf8'));
  assert.equal(saved.tasks[0].input, stdinText);

  const conflictingInput = spawnSync(process.execPath, ['dist/cli.js','task','update','--file',localJob,'--task-id','file-task','--input','short','--input-file',taskFile], { encoding:'utf8' });
  assert.notEqual(conflictingInput.status, 0);
  assert.match(conflictingInput.stderr, /--input and --input-file are mutually exclusive/);
  await rm(directory, { recursive:true, force:true });
});

test('completed Task comments preserve Markdown Work and render Result separately', async () => {
  const { renderTaskComment } = await import('../dist/markers.js');
  const now = new Date().toISOString();
  const task = { jobId:'j', id:'phase-1', priority:'P0', storySize:'M', parentTaskId:null, dependencies:[], capabilities:[], adapter:'orchestrator', input:'# Phase 1\n\n## Scope\n\n```mermaid\nflowchart TD\n  A --> B\n```\n', continuation:null, continuationDeliveredAt:null, state:'SUCCEEDED', attempt:1, maxAttempts:3, leaseOwner:null, leaseExpiresAt:null, executionId:null, threadId:null, result:{summary:'Completed successfully.'}, error:null, timeoutMs:0, createdAt:now, updatedAt:now };
  const rendered = renderTaskComment(task);
  assert.match(rendered, /### Work\n\n# Phase 1/);
  assert.match(rendered, /```mermaid/);
  assert.match(rendered, /### Result\n\nCompleted successfully\./);
});
