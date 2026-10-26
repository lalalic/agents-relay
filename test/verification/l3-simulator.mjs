// Full-path L3 simulator: real Reconciler/Graph/dependencies/SQLite, mocked workers and Git.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createIsolatedEnvironment } from './harness.mjs';
import { SQLiteRelayStore } from '../../dist/relay-store.js';
import { LocalAuthorityDurableStore } from '../../dist/local-authority-store.js';
import { InMemoryStore } from '../../dist/store.js';
import { MemoryEventBus, eventFor } from '../../dist/events.js';
import { Reconciler, executionEventSource } from '../../dist/reconciler.js';
import { localMergeFacts } from '../../dist/local-git-merge.js';

const stamp = '2026-10-18T00:00:00.000Z';
const route = { provider: 'simulator', model: 'mock-agent', decidedBy: 'l3-simulator', decidedAt: stamp };

function task(id, dependencies = [], agentName = 'implementation', jobId = 'l3-full-path') {
  return { jobId, id, kind: 'work', agentName, adapter: 'codex', input: 'mock external agent', output: { kind: 'task_pr' }, parentTaskId: null, dependencies, capabilities: ['model'], workerRequirements: { capabilities: ['model'] }, workerSelection: { workerId: 'l3-worker', selectedBy: 'test', selectedAt: stamp }, routing: route, state: dependencies.length ? 'DRAFT' : 'QUEUED', attempt: 0, maxAttempts: 3, leaseOwner: null, leaseExpiresAt: null, executionId: null, executionHistory: [], threadId: null, result: null, error: null, timeoutMs: 900000, createdAt: stamp, updatedAt: stamp };
}

function fakeAdapter(bus, outcomes, verdicts, heads, startedWaiters) {
  return {
    name: 'codex', id: 'l3-worker', capabilities: ['model', 'codex'],
    launch(currentTask, signal) {
      const executionId = currentTask.executionId;
      const source = { id: executionEventSource(currentTask.jobId, currentTask.id, executionId) };
      let cancelled = false;
      const publish = async () => {
        if (cancelled || signal.aborted) return;
        const started = new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Relay did not ingest task.started before the terminal event')), 1000);
          startedWaiters.set(source.id, () => { clearTimeout(timeout); resolve(); });
        });
        try {
          await bus.publish(eventFor(currentTask.jobId, currentTask.id, currentTask.parentTaskId, 'task.started', 'running', 'simulated worker started', 'orchestrator', { role: currentTask.agentName }, source));
          await started;
        } finally {
          startedWaiters.delete(source.id);
        }
        await new Promise(resolve => setTimeout(resolve, 0));
        const key = currentTask.agentName === 'reviewer' ? currentTask.id : currentTask.id;
        const queue = currentTask.agentName === 'reviewer' ? verdicts[key] ?? verdicts['*'] ?? ['approved'] : outcomes[key] ?? ['completed'];
        const result = queue.shift() ?? 'completed';
        if (result === 'failed') {
          await bus.publish(eventFor(currentTask.jobId, currentTask.id, currentTask.parentTaskId, 'task.failed', 'failed', 'simulated worker failure', 'orchestrator', { phase: currentTask.agentName, reason: 'fault injection' }, source));
        } else if (currentTask.agentName === 'reviewer') {
          const head = heads.current;
          await bus.publish(eventFor(currentTask.jobId, currentTask.id, currentTask.parentTaskId, 'task.completed', 'succeeded', `simulated review ${result}`, 'orchestrator', { verdict: result, head_sha: head, findings: result === 'changes-required' ? [{ summary: 'simulated blocking finding' }] : [] }, source));
        } else {
          await bus.publish(eventFor(currentTask.jobId, currentTask.id, currentTask.parentTaskId, 'task.completed', 'succeeded', 'simulated worker completed', 'orchestrator', { phase: currentTask.agentName }, source));
        }
      };
      const promise = Promise.resolve().then(publish).then(() => ({ summary: 'mock external agent delivery completed' }));
      return { id: executionId, promise, launched: Promise.resolve(), cancel: () => { cancelled = true; } };
    },
  };
}

export async function runFullPath(scenario) {
  if (!scenario || !/^[a-z0-9-]+$/.test(scenario.id ?? '')) throw new Error('invalid scenario');
  const env = createIsolatedEnvironment('relay-l3-full-');
  const jobId = `l3-${scenario.id}`;
  let sqlite = new SQLiteRelayStore(join(env.storeDir, 'relay.sqlite'), jobId);
  let store = new LocalAuthorityDurableStore(sqlite, new InMemoryStore(), undefined, true);
  const bus = new MemoryEventBus();
  const observedEvents = [];
  const startedWaiters = new Map();
  await bus.subscribeAll(async event => {
    observedEvents.push({ type: event.type, taskId: event.task_id, source: event.source?.id });
    if (event.type === 'task.started') startedWaiters.get(event.source?.id)?.();
  });
  const heads = { current: scenario.headSha ?? 'head-1' };
  const outcomes = Object.fromEntries(Object.entries(scenario.workerOutcomes ?? {}));
  const verdicts = Object.fromEntries(Object.entries(scenario.reviewVerdicts ?? {}));
  const mergeOutcomes = [...(scenario.mergeOutcomes ?? ['succeeded'])];
  const mergeReceipts = [];
  let runtime = new Reconciler(store, {
    owner: 'l3-simulator', adapters: [fakeAdapter(bus, outcomes, verdicts, heads, startedWaiters)], eventBus: bus,
    maxConcurrent: scenario.maxConcurrent ?? 4, noGitHub: true, projectPathForJob: async () => env.root,
    headShaProvider: () => heads.current,
    localMergeDelivery: (_path, receipt) => {
      if (mergeReceipts.length > 0 && mergeOutcomes.length === 0) return mergeReceipts.at(-1);
      const outcome = scenario.persistMergeFailure ? 'failed' : (mergeOutcomes.shift() ?? 'succeeded');
      if (outcome === 'failed') throw new Error(scenario.mergeFailureReason ?? 'simulated dirty target worktree');
      const mergedCommitSha = `merge-${mergeReceipts.length + 1}`;
      mergeReceipts.push({ sourceSha: receipt.sourceSha, mergedCommitSha });
      return { sourceSha: receipt.sourceSha ?? heads.current, mergedCommitSha };
    },
    reviewer: { adapter: 'codex', workerId: 'l3-worker', routing: route, maxAttempts: 3 },
    planner: { plan: async () => ({ objective_status: 'satisfied', assessment: 'Durable worker evidence verified.', next_tasks: [] }) },
  });
  const trace = [];
  let stop;
  const snapshot = async () => sqlite.loadJob(jobId);
  const tick = async () => { await new Promise(resolve => setTimeout(resolve, 10)); await runtime.idle(); await runtime.reconcile(jobId); await runtime.idle(); };
  try {
    const tasks = (scenario.tasks ?? [{ id: 'a' }, { id: 'b', dependencies: ['a'] }]).map(item => task(item.id, item.dependencies ?? [], item.agentName ?? 'implementation', jobId));
    await store.saveJob({ id: jobId, title: scenario.id, objective: scenario.objective ?? scenario.id, repository: 'local/isolated', prNumber: 0, state: 'ACTIVE', autoMerge: scenario.autoMerge ?? true, reviewEnabled: scenario.reviewEnabled ?? true, headSha: heads.current, localMerge: { sourceRef: 'refs/heads/sim-source', targetRef: 'refs/heads/main', status: 'pending' }, createdAt: stamp, updatedAt: stamp, tasks });
    await store.saveAgent({
      id: 'l3-worker', name: 'L3 mock worker', responsibility: 'simulated external agent', role: 'worker', capabilities: ['model', 'codex'], boundaries: [],
      endpoint: { kind: 'adapter', target: 'l3-worker' }, runtime: { adapter: 'codex', provider: 'simulator', model: 'mock-agent' }, availability: 'available', routing: {},
      evidence: { evaluations: [], outcomes: { succeeded: 0, failed: 0, timedOut: 0 }, lastObservedAt: stamp }, registeredAt: stamp, updatedAt: stamp,
    });
    stop = await runtime.watch(jobId);
    for (let attempt = 0; attempt < 6; attempt += 1) await tick();
    // A revision changes the immutable head only after the production fix task succeeds.
    // A fixed number of initial ticks races the asynchronous review/fix dispatcher.
    if (scenario.steps?.some(step => step.type === 'advance-head')) {
      let ready = false;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        await tick();
        const current = await snapshot();
        if (current.tasks.some(item => item.id.startsWith('review-fix-') && item.state === 'SUCCEEDED')) { ready = true; break; }
      }
      if (!ready) throw new Error('revision cannot advance head: review fix did not succeed');
    }
    for (const action of scenario.steps ?? []) {
      if (action.type === 'restart') {
        await stop?.(); await runtime.close(); sqlite.close();
        sqlite = new SQLiteRelayStore(join(env.storeDir, 'relay.sqlite'), jobId);
        store = new LocalAuthorityDurableStore(sqlite, new InMemoryStore(), undefined, true);
        runtime = new Reconciler(store, { owner: 'l3-simulator-restarted', adapters: [fakeAdapter(bus, outcomes, verdicts, heads, startedWaiters)], eventBus: bus, maxConcurrent: scenario.maxConcurrent ?? 4, noGitHub: true, projectPathForJob: async () => env.root, headShaProvider: () => heads.current, localMergeDelivery: (_path, receipt) => { if (mergeReceipts.length > 0 && mergeOutcomes.length === 0) return mergeReceipts.at(-1); const outcome = scenario.persistMergeFailure ? 'failed' : (mergeOutcomes.shift() ?? 'succeeded'); if (outcome === 'failed') throw new Error(scenario.mergeFailureReason ?? 'simulated dirty target worktree'); const mergedCommitSha = `merge-${mergeReceipts.length + 1}`; mergeReceipts.push({ sourceSha: receipt.sourceSha, mergedCommitSha }); return { sourceSha: receipt.sourceSha ?? heads.current, mergedCommitSha }; }, reviewer: { adapter: 'codex', workerId: 'l3-worker', routing: route, maxAttempts: 3 }, planner: { plan: async () => ({ objective_status: 'satisfied', assessment: 'Durable worker evidence verified.', next_tasks: [] }) } });
        stop = await runtime.watch(jobId);
        await runtime.reconcile(jobId);
      } else if (action.type === 'advance-head') {
        heads.current = action.headSha;
        await runtime.reconcile(jobId);
      } else if (action.type === 'reconcile') {
        await runtime.reconcile(jobId);
      }
      await runtime.idle();
      for (let attempt = 0; attempt < 50; attempt += 1) await tick();
      const current = await snapshot();
      trace.push({ event: action.type, jobState: current.state, headSha: heads.current, merge: current.localMerge ?? null, tasks: current.tasks.map(item => ({ id: item.id, agent: item.agentName, state: item.state, attempt: item.attempt, executionId: item.executionId, result: item.result, error: item.error })), progress: JSON.stringify(current) !== JSON.stringify(trace.at(-1)?.after) });
      trace.at(-1).after = current;
    }
    // A launched adapter and its terminal event may be delivered on separate turns.
    // Settle until durable SQLite reaches a stable post-ingress state; never trust the
    // adapter promise or the event bus receipt as proof of a terminal transition.
    // Full-suite load can delay the second SHA-bound review's terminal event.
    for (let settle = 0; settle < 300; settle += 1) {
      const before = await snapshot();
      await tick();
      const after = await snapshot();
      const unsettled = after.tasks.some(item => ['RUNNING', 'QUEUED'].includes(item.state));
      if (!unsettled && JSON.stringify(before) === JSON.stringify(after)) break;
    }
    const actual = await snapshot();
    const errors = [];
    for (const [id, state] of Object.entries(scenario.expected?.tasks ?? {})) if (actual.tasks.find(item => item.id === id)?.state !== state) errors.push(`${id} expected ${state}`);
    if (scenario.expected?.jobState && actual.state !== scenario.expected.jobState) errors.push(`job expected ${scenario.expected.jobState}, got ${actual.state}`);
    if (scenario.expected?.mergeStatus && actual.localMerge?.status !== scenario.expected.mergeStatus) errors.push(`merge expected ${scenario.expected.mergeStatus}, got ${actual.localMerge?.status ?? 'none'}`);
    const result = { schemaVersion: 3, scenarioId: scenario.id, outcome: errors.length ? 'FAIL' : 'PASS', actual: { jobState: actual.state, headSha: heads.current, review: actual.review ?? null, facts: localMergeFacts(actual, heads.current), tasks: Object.fromEntries(actual.tasks.map(item => [item.id, item.state])), localMerge: actual.localMerge ?? null }, trace, mergeReceipts, events: observedEvents, errors, authority: 'isolated SQLite via MemoryEventBus, Reconciler, Graph and dependency reconciliation' };
    if (scenario.outputDir) { mkdirSync(resolve(scenario.outputDir), { recursive: true }); writeFileSync(join(resolve(scenario.outputDir), 'report.json'), JSON.stringify(result, null, 2) + '\n'); writeFileSync(join(resolve(scenario.outputDir), 'report.md'), `# L3 production-path simulator\n\nScenario: ${scenario.id}\nResult: ${result.outcome}\n\n| Event | Job | Tasks |\n| --- | --- | --- |\n${trace.map(item => `| ${item.event} | ${item.jobState} | ${item.tasks.map(t => `${t.id}:${t.state}`).join(', ')} |`).join('\n')}\n${errors.map(error => `\n- ERROR: ${error}`).join('')}\n`); }
    return result;
  } finally { await stop?.(); await runtime.close(); sqlite.close(); env.cleanup(); }
}
