import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteRelayStore } from '../../dist/relay-store.js';
import { LocalAuthorityDurableStore } from '../../dist/local-authority-store.js';
import { InMemoryStore } from '../../dist/store.js';
import { MemoryEventBus, eventFor } from '../../dist/events.js';
import { Reconciler, executionEventSource } from '../../dist/reconciler.js';
import { beginProjectionRecovery } from '../../dist/projection-recovery.js';
import { localSourceHead, deliverLocalMerge } from '../../dist/local-git-merge.js';
import { projectAuthoritativeLocalMerge } from '../../dist/local-merge-projection.js';
import { reconcileProjectionRecovery } from '../../dist/projection-recovery-runtime.js';
import { RepositoryWorkerPool } from '../../dist/pool.js';

const at = '2026-10-20T12:00:00.000Z';
const route = { provider: 'test', model: 'deterministic', decidedBy: 'l3', decidedAt: at };
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const run = (cwd, ...args) => execFileSync(args[0], args.slice(1), { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function fakeAdapter(bus, repo) {
  const started = new Set();
  const adapter = {
    name: 'codex', id: 'l3-projection-worker', capabilities: ['model', 'codex'],
    launch(task, signal) {
      const source = { id: executionEventSource(task.jobId, task.id, task.executionId) };
      const promise = (async () => {
        await bus.publish(eventFor(task.jobId, task.id, task.parentTaskId, 'task.started', 'running', 'L3 deterministic worker started', 'orchestrator', {}, source));
        for (let n = 0; n < 100 && !started.has(source.id); n += 1) await new Promise(resolve => setTimeout(resolve, 2));
        if (signal.aborted) return { summary: 'cancelled' };
        if (task.agentName === 'reviewer') {
          await bus.publish(eventFor(task.jobId, task.id, task.parentTaskId, 'review.approved', 'succeeded', 'review approved', 'orchestrator', { verdict: 'approved', head_sha: task.reviewHeadSha, findings: [] }, source));
        } else {
          git(repo, 'merge', '--no-edit', 'refs/remotes/origin/main');
          await bus.publish(eventFor(task.jobId, task.id, task.parentTaskId, 'task.completed', 'succeeded', 'divergence merged locally', 'orchestrator', { phase: 'implementation' }, source));
        }
        return { summary: 'durable terminal event published' };
      })();
      return { id: task.executionId, promise, launched: Promise.resolve(), cancel: () => {} };
    },
  };
  return { adapter, started };
}

test('projection recovery runs through SQLite, Reconciler review, restart, duplicate wake and safe local-origin push', async () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-l3-projection-'));
  const repo = join(root, 'repo');
  const remote = join(root, 'origin.git');
  mkdirSync(repo);
  let db;
  let store;
  let runtime;
  let stop;
  try {
    run(root, 'git', 'init', '--bare', remote);
    run(root, 'git', 'init', '-b', 'main', repo);
    git(repo, 'config', 'user.email', 'l3@example.invalid'); git(repo, 'config', 'user.name', 'L3');
    writeFileSync(join(repo, 'base.txt'), 'base\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'base');
    git(repo, 'remote', 'add', 'origin', remote); git(repo, 'push', '-u', 'origin', 'main');
    const baseSha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'switch', '-c', 'job-l3'); writeFileSync(join(repo, 'job.txt'), 'job\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'job change');
    const sourceSha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'switch', 'main');
    const delivered = deliverLocalMerge(repo, { sourceRef: 'refs/heads/job-l3', targetRef: 'refs/heads/main', status: 'succeeded', sourceSha, correlationJobId: 'l3-projection-recovery' });
    const competing = join(root, 'competitor'); run(root, 'git', 'clone', remote, competing);
    run(competing, 'git', 'config', 'user.email', 'l3@example.invalid'); run(competing, 'git', 'config', 'user.name', 'L3');
    writeFileSync(join(competing, 'remote.txt'), 'remote\n'); run(competing, 'git', 'add', '.'); run(competing, 'git', 'commit', '-m', 'remote advance'); run(competing, 'git', 'push', 'origin', 'main');
    git(repo, 'fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main');
    const remoteSha = git(repo, 'rev-parse', 'refs/remotes/origin/main');
    assert.notEqual(remoteSha, delivered.mergedCommitSha);
    assert.notEqual(git(repo, 'merge-base', 'refs/heads/main', 'refs/remotes/origin/main'), remoteSha);

    db = new SQLiteRelayStore(join(root, 'relay.sqlite'), 'l3-projection-recovery');
    store = new LocalAuthorityDurableStore(db, new InMemoryStore(), undefined, true);
    const task = { jobId: 'l3-projection-recovery', id: 'original-work', kind: 'work', agentName: 'implementation', adapter: 'codex', input: 'completed implementation', output: { kind: 'task_pr' }, parentTaskId: null, dependencies: [], capabilities: ['model'], workerRequirements: { capabilities: ['model'] }, routing: route, state: 'SUCCEEDED', attempt: 1, maxAttempts: 3, leaseOwner: null, leaseExpiresAt: null, executionId: null, executionHistory: [], threadId: null, result: { summary: 'complete' }, error: null, timeoutMs: 900000, createdAt: at, updatedAt: at, continuation: null, continuationDeliveredAt: null };
    await db.saveJob({ id: 'l3-projection-recovery', title: 'L3 projection recovery', repository: 'local/l3', prNumber: 0, executionMode: 'fixed', state: 'COMPLETED', continuation: null, autoMerge: true, reviewEnabled: true, headSha: sourceSha, localMerge: { sourceRef: 'refs/heads/job-l3', targetRef: 'refs/heads/main', status: 'succeeded', sourceSha, mergedCommitSha: delivered.mergedCommitSha, projectionStrategy: 'target_ref_push' }, createdAt: at, updatedAt: at, tasks: [task] });
    await store.saveAgent({ id: 'l3-projection-worker', name: 'L3 projection worker', responsibility: 'deterministic L3 adapter', role: 'worker', capabilities: ['model', 'codex'], boundaries: [], endpoint: { kind: 'adapter', target: 'l3-projection-worker' }, runtime: { adapter: 'codex', provider: 'test', model: 'deterministic' }, availability: 'available', routing: {}, evidence: { evaluations: [], outcomes: { succeeded: 0, failed: 0, timedOut: 0 }, lastObservedAt: at }, registeredAt: at, updatedAt: at });
    assert.equal(await beginProjectionRecovery(db, 'l3-projection-recovery', remoteSha, 'non-fast-forward: origin/main diverged'), 'created');
    const bus = new MemoryEventBus();
    const observed = [];
    await bus.subscribeAll(async event => observed.push(`${event.type}:${event.task_id}`));
    let adapterState = fakeAdapter(bus, repo);
    const options = () => ({ owner: 'l3-projection-recovery', adapters: [adapterState.adapter], eventBus: bus, maxConcurrent: 1, reviewer: { adapter: 'codex', workerId: adapterState.adapter.id, routing: route, maxAttempts: 2 }, projectPathForJob: async () => repo, headShaProvider: () => sourceSha });
    runtime = new Reconciler(store, options());
    let daemonRuntime;
    const pool = new RepositoryWorkerPool(0, (_store, _capacity) => {
      daemonRuntime = new Reconciler(store, { ...options(), maxConcurrent: 0 });
      return daemonRuntime;
    }, async () => [], async jobId => ({ job: await db.loadJob(jobId), store }));
    await pool.reconcileLocalJob('l3-projection-recovery', 'projection.delivery_failed');
    await daemonRuntime?.close();
    const subscribeStarted = await bus.subscribeAll(async event => { if (event.type === 'task.started') adapterState.started.add(event.source?.id); });
    stop = await runtime.watch('l3-projection-recovery');
    const settle = async () => { let current; for (let i = 0; i < 80; i += 1) { await runtime.idle(); await runtime.reconcile('l3-projection-recovery'); current = await db.loadJob('l3-projection-recovery'); if (current.tasks.some(item => item.agentName === 'reviewer' && item.state === 'SUCCEEDED')) return current; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error(`Recovery/review did not settle: ${JSON.stringify({ state: current?.state, review: current?.review, recovery: current?.projectionRecovery, tasks: current?.tasks.map(({id,agentName,state,error,executionId}) => ({id,agentName,state,error,executionId})), observed })}`); };
    let current = await settle();
    assert.equal(current.state, 'COMPLETED');
    assert.equal(current.projectionRecovery.status, 'repairing');
    assert.equal(current.review.outcome, 'approved');
    assert.ok(current.tasks.some(item => item.id === current.projectionRecovery.taskId && item.state === 'SUCCEEDED'));
    assert.ok(git(repo, 'merge-base', '--is-ancestor', remoteSha, 'refs/heads/main') === '');

    // Simulate daemon restart: close and reopen only the SQLite-backed reconciler.
    await stop(); stop = undefined; await runtime.close(); runtime = undefined; db.close();
    db = new SQLiteRelayStore(join(root, 'relay.sqlite'), 'l3-projection-recovery');
    store = new LocalAuthorityDurableStore(db, new InMemoryStore(), undefined, true);
    adapterState = fakeAdapter(bus, repo);
    runtime = new Reconciler(store, options());
    stop = await runtime.watch('l3-projection-recovery');
    current = await runtime.reconcile('l3-projection-recovery');
    assert.equal(current.tasks.filter(item => item.id === current.projectionRecovery.taskId).length, 1);
    const beforeDuplicate = current.updatedAt;
    await beginProjectionRecovery(db, current.id, remoteSha, 'duplicate non-fast-forward wakeup');
    await bus.publish(eventFor(current.id, 'projection', null, 'job.wake', 'queued', 'duplicate daemon wake', 'orchestrator'));
    await runtime.idle();
    assert.equal((await db.loadJob(current.id)).tasks.filter(item => item.id === current.projectionRecovery.taskId).length, 1);
    assert.equal((await db.loadJob(current.id)).updatedAt, beforeDuplicate);

    const finalJob = await db.loadJob(current.id);
    const result = await reconcileProjectionRecovery(finalJob, db, {
      projectPath: repo,
      project: async job => projectAuthoritativeLocalMerge(repo, job),
      verifyObservedRemote: async sha => { git(repo, 'merge-base', '--is-ancestor', sha, 'refs/heads/main'); },
    });
    assert.equal(result?.state, 'projected');
    assert.equal(result?.projectedMerge?.status, 'projected');
    assert.equal((await db.loadJob(current.id)).projectionRecovery.status, 'projected');
    assert.equal(git(repo, 'rev-parse', 'refs/remotes/origin/main'), git(repo, 'rev-parse', 'refs/heads/main'));
    assert.equal(git(repo, 'merge-base', 'refs/remotes/origin/main', delivered.mergedCommitSha), delivered.mergedCommitSha);
    assert.equal(localSourceHead(repo, 'refs/heads/job-l3'), sourceSha);
    await subscribeStarted();
  } finally {
    await stop?.(); await runtime?.close(); db?.close(); rmSync(root, { recursive: true, force: true });
  }
});
