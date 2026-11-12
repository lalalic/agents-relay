import test from '../test-runtime.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { SQLiteRelayStore } from '../../dist/relay-store.js';
import { LocalAuthorityDurableStore } from '../../dist/local-authority-store.js';
import { InMemoryStore } from '../../dist/store.js';
import { createJobEntity, createTaskEntity } from '../../dist/workflow/entity-creation.js';
import { Reconciler, executionEventSource } from '../../dist/reconciler.js';
import { MemoryEventBus, eventFor } from '../../dist/events.js';
import { deliverLocalMerge, localSourceHead } from '../../dist/local-git-merge.js';
import { applyJobActivateAction } from '../../dist/job-actions.js';

function git(cwd, ...args) { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim(); }

test('L3 local Job completes through SQLite worker, final review and actual local Git merge', async t => {
  const root = await mkdtemp(join(tmpdir(), 'relay-local-jel-'));
  const projectRoot = join(root, 'neo');
  const storeDirectory = join(root, 'stores');
  await mkdir(projectRoot, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', projectRoot]);
  git(projectRoot, 'config', 'user.name', 'Relay L3');
  git(projectRoot, 'config', 'user.email', 'relay-l3@example.invalid');
  await writeFile(join(projectRoot, 'README.md'), 'base\n');
  git(projectRoot, 'add', 'README.md'); git(projectRoot, 'commit', '-qm', 'base');
  git(projectRoot, 'branch', 'relay-feature');
  git(projectRoot, 'checkout', '-q', 'relay-feature');
  await writeFile(join(projectRoot, 'feature.txt'), 'implemented\n');
  git(projectRoot, 'add', 'feature.txt'); git(projectRoot, 'commit', '-qm', 'implementation');
  const sourceSha = git(projectRoot, 'rev-parse', 'HEAD');
  git(projectRoot, 'checkout', '-q', 'main');
  const jobId = '711';
  const now = new Date().toISOString();
  const job = createJobEntity({ id: jobId, title: 'Local JEL', objective: 'Complete local source delivery', repository: basename(projectRoot), projectRoot, prNumber: 0, state: 'ACTIVE', continuation: null,
    reviewEnabled: true, autoMerge: true, localMerge: { sourceRef: 'refs/heads/relay-feature', targetRef: 'refs/heads/main', status: 'pending' },
    createdAt: now, updatedAt: now, tasks: [] });
  job.plans = [{ jobId, id: 'plan-1', round: 1, source: 'orchestrator', previousPlanId: null, trigger: { source: 'initial' }, status: 'SUCCEEDED', objectiveStatus: 'satisfied', assessment: 'Implementation task satisfies the durable objective.', generatedTaskIds: ['implement'], createdAt: now, updatedAt: now }];
  job.tasks.push(createTaskEntity(job, { jobId, id: 'implement', title: 'Implement feature', parentTaskId: null, dependencies: [], capabilities: [], adapter: 'codex', input: 'Verify the already committed local implementation.', output: { kind: 'task_pr' }, state: 'QUEUED', attempt: 0, maxAttempts: 1,
    leaseOwner: null, leaseExpiresAt: null, executionId: null, threadId: null, result: null, error: null, timeoutMs: 300000, createdAt: now, updatedAt: now }));
  await applyJobActivateAction(job);
  const relay = new SQLiteRelayStore(join(storeDirectory, 'relay.sqlite'), jobId);
  await relay.createJobIfAbsent(job);
  const store = new LocalAuthorityDurableStore(relay, new InMemoryStore(), undefined, true);
  await store.saveAgent({ id: 'local-l3-worker', name: 'Local L3 worker', responsibility: 'Execute local Job Tasks', role: 'worker', capabilities: ['model', 'codex'], boundaries: [],
    endpoint: { kind: 'adapter', target: 'local-l3-worker' }, runtime: { adapter: 'codex', provider: 'fixture', model: 'local' }, availability: 'available', routing: {},
    evidence: { evaluations: [], outcomes: { succeeded: 0, failed: 0, timedOut: 0 }, lastObservedAt: now }, registeredAt: now, updatedAt: now });
  const bus = new MemoryEventBus();
  const adapter = {
    name: 'codex', id: 'local-l3-worker', capabilities: ['model', 'codex'],
    launch(task) {
      const source = { id: executionEventSource(jobId, task.id, task.executionId) };
      const emit = (type, status, message, data = {}) => bus.publish(eventFor(jobId, task.id, task.parentTaskId, type, status, message, 'worker', data, source));
      const promise = (async () => {
        await emit('task.started', 'running', 'Started local task');
        const review = task.agentName === 'job-acceptance-reviewer';
        await emit('task.completed', 'succeeded', review ? 'Local head reviewed' : 'Implementation verified', review
          ? { verdict: 'approved', head_sha: task.reviewHeadSha ?? sourceSha, findings: [] }
          : { summary: 'Existing implementation verified' });
        return { summary: 'Worker execution completed' };
      })();
      return { id: task.executionId, promise, cancel: () => {} };
    },
  };
  const reconciler = new Reconciler(store, { owner: 'l3-local-jel', adapters: [adapter], eventBus: bus, noGitHub: true,
    projectPathForJob: async current => current.projectRoot,
    localMergeDelivery: (path, receipt) => deliverLocalMerge(path, receipt),
    reviewer: { adapter: 'codex', workerId: 'local-l3-worker', routing: { provider: 'fixture', model: 'local', decidedBy: 'fixture', decidedAt: now }, maxAttempts: 1 },
  });
  t.after(async () => { await reconciler.close(); relay.close(); await rm(root, { recursive: true, force: true }); });
  const stop = await reconciler.watch(jobId);
  t.after(stop);
  const deadline = Date.now() + 10000;
  let current;
  while (Date.now() < deadline) {
    await reconciler.reconcile(jobId);
    current = await relay.loadJob(jobId);
    if (current.state === 'COMPLETED') break;
    if (current.tasks.some(task => task.state === 'FAILED')) assert.fail(JSON.stringify(current.tasks.map(task => ({ id: task.id, state: task.state, error: task.error }))));
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  current = await relay.loadJob(jobId);
  assert.equal(current.state, 'COMPLETED', JSON.stringify({ tasks: current.tasks.map(task => ({ id: task.id, agent: task.agentName, state: task.state, error: task.error, result: task.result })), review: current.review, localMerge: current.localMerge }));
  assert.equal(current.repository, 'neo');
  assert.equal(current.projectRoot, projectRoot);
  assert.equal(current.review?.outcome, 'approved');
  assert.equal(current.review?.headSha, sourceSha);
  assert.equal(current.localMerge?.status, 'succeeded');
  assert.notEqual(current.localMerge?.mergedCommitSha, sourceSha);
  assert.equal(git(projectRoot, 'rev-parse', 'refs/heads/main'), current.localMerge.mergedCommitSha);
  assert.match(git(projectRoot, 'show', '-s', '--format=%B', 'refs/heads/main'), /Agents-Relay-Job: 711/);
  assert.equal(localSourceHead(projectRoot, current.localMerge.sourceRef), sourceSha);
  assert.equal(current.tasks.find(task => task.agentName === 'job-acceptance-reviewer')?.state, 'SUCCEEDED');
});
