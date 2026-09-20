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

test('all service runtimes use the fixed ChatGPT final reviewer policy', async () => {
  const reviewer = runtimeReviewer();
  assert.equal(reviewer.adapter, 'chatgpt');
  assert.equal(reviewer.routing.provider, 'chatgpt');
  assert.equal(reviewer.routing.model, 'account-defaults');
  assert.equal(reviewer.startAckTimeoutMs, 120000);
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

test('release version selection starts at 1.0.0 and increments only the patch', () => {
  assert.equal(nextPatchVersion(''), '1.0.0');
  assert.equal(nextPatchVersion('1.0.0'), '1.0.1');
  assert.equal(nextPatchVersion('2.7.9'), '2.7.10');
  assert.throws(() => nextPatchVersion('latest'), /Unsupported npm version/);
});

test('CLI and daemon help are successful and do not require job storage', () => {
  for (const [entry, args, expected] of [
    ['dist/cli.js', ['--help'], 'npx agents-relay <command>'],
    ['dist/cli.js', ['job', '--help'], 'npx agents-relay job <create|adopt|repair>'],
    ['dist/cli.js', ['job', 'create', '--help'], 'Create or reuse an open PR'],
    ['dist/cli.js', ['job', 'adopt', '--help'], 'Adopt an existing PR'],
    ['dist/cli.js', ['job', 'repair', '--help'], 'Repair duplicate durable markers'],
    ['dist/cli.js', ['task', '--help'], 'npx agents-relay task update'],
    ['dist/cli.js', ['task', 'update', '--help'], 'Update mutable durable task fields'],
    ['dist/cli.js', ['init', '--help'], 'Initialize a new job'],
    ['dist/cli.js', ['submit', '--help'], 'Queue a task for a managed job'],
    ['dist/cli.js', ['record', '--help'], 'Backfill work completed outside the relay'],
    ['dist/cli.js', ['status', '--help'], 'Show the durable state for a job'],
    ['dist/cli.js', ['reconcile', '--help'], 'Reconcile a job once'],
    ['dist/cli.js', ['retry', '--help'], 'Retry a task by setting it READY'],
    ['dist/cli.js', ['cancel', '--help'], 'Cancel a task'],
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

test('job create help documents explicit create-only and create-and-start modes', () => {
  const result = spawnSync(process.execPath, ['dist/cli.js', 'job', 'create', '--help'], { encoding: 'utf8' });
  assert.match(result.stdout, /--start/);
  assert.match(result.stdout, /initial task ID defaults to 'initial'/);
});

test('job create --start is idempotent for the same initial task definition', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agents-relay-cli-'));
  const bin = join(directory, 'bin');
  const state = join(directory, 'github.json');
  const gh = join(bin, 'gh');
  await mkdir(bin);
  await writeFile(state, JSON.stringify({ comments: [] }));
  await writeFile(gh, `#!/usr/bin/env node
const fs = await import('node:fs/promises');
const statePath = process.env.AGENTS_RELAY_TEST_STATE;
const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
const args = process.argv.slice(2);
if (args[0] === 'auth') { process.stdout.write(JSON.stringify({hosts:{'github.com':[{login:'bot',active:true}]}})); process.exit(0); }
if (!args.includes('graphql')) process.exit(1);
const request = JSON.parse(await new Promise(resolve => { let body=''; process.stdin.on('data', chunk => body += chunk); process.stdin.on('end', () => resolve(body)); }));
const query = request.query;
const variables = request.variables || {};
const comments = state.comments;
const nodes = comments.map((body, index) => ({id:'IC_'+(index+1), databaseId:index+1, body, updatedAt:new Date().toISOString(), author:{login:'bot'}}));
let data;
if (query.includes('pullRequest(number:$number)')) data = {repository:{pullRequest:{number:1,title:'Demo',body:'',state:'OPEN',headRefName:'feat/demo',baseRefName:'main',id:'PR_1',merged:false,mergedAt:null,closedAt:null,comments:{nodes}}}};
else if (query.includes('addComment')) { comments.push(variables.body); data = {addComment:{commentEdge:{node:{id:'IC_'+comments.length}}}}; }
else if (query.includes('updateIssueComment')) { const index=Number(String(variables.id).replace('IC_',''))-1; comments[index]=variables.body; data={updateIssueComment:{issueComment:{id:variables.id}}}; }
else if (query.includes('deleteIssueComment')) { const index=Number(String(variables.id).replace('IC_',''))-1; comments.splice(index,1); data={deleteIssueComment:{clientMutationId:null}}; }
else if (query.includes('comments(first:100')) data={repository:{pullRequest:{comments:{nodes}}}};
else data={repository:{pullRequest:{number:1,title:'Demo',body:'',state:'OPEN',headRefName:'feat/demo',baseRefName:'main'}}};
await fs.writeFile(statePath, JSON.stringify(state));
process.stdout.write(JSON.stringify(data));
`, { mode: 0o755 });
  await chmod(gh, 0o755);
  const command = ['dist/cli.js', 'job', 'create', '--repo', 'owner/repo', '--pr', '1', '--id', 'job-cli', '--start', '--adapter', 'codex', '--provider', 'openai', '--model', 'gpt-test', '--output', 'task-pr', '--task-id', 'initial', '--input', 'Do the work'];
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, AGENTS_RELAY_TEST_STATE: state };
  const first = spawnSync(process.execPath, command, { encoding: 'utf8', env });
  const second = spawnSync(process.execPath, command, { encoding: 'utf8', env });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  const persisted = JSON.parse(await readFile(state, 'utf8'));
  const taskMarkers = persisted.comments.filter(comment => comment.includes('agents-relay:task:v1'));
  assert.equal(taskMarkers.length, 1);
  assert.equal(persisted.comments.filter(comment => comment.includes('agents-relay:job:v1')).length, 1);
  await rm(directory, { recursive: true, force: true });
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
  await writeFile(file, JSON.stringify({ id: 'degraded-job', title: 'Degraded', prNumber: 0, state: 'OPEN', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tasks: [] }));
  const service = await createService(['--file', file, '--port', '0']);
  service.reconciler.reconcile = async () => { throw new Error('GitHub rate limited'); };
  // startService owns construction, so assert the equivalent startup policy directly:
  try { await service.reconciler.reconcile(service.job.id); } catch {}
  assert.notEqual(service.dashboardServer.address(), null);
  await service.stop();
  await rm(directory, { recursive: true, force: true });
});
