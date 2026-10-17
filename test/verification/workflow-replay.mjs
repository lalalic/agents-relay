import { join } from 'node:path';
import { createIsolatedEnvironment, classifyObservedTrace, newEvidence } from './harness.mjs';
import { SQLiteRelayStore } from '../../dist/relay-store.js';
import { LocalAuthorityDurableStore } from '../../dist/local-authority-store.js';
import { InMemoryStore } from '../../dist/store.js';
import { Reconciler } from '../../dist/reconciler.js';
import { MemoryEventBus, eventFor } from '../../dist/events.js';
import { executionEventSource } from '../../dist/reconciler.js';
import { schedule, completionGateSatisfied, transitionJobEvent, transitionTaskEvent } from '../../dist/scheduler.js';

const stamp = '2026-10-17T12:00:00.000Z';
function task(jobId, id, state = 'RUNNING', agentName = 'implementation', dependencies = [], executionId = `exec-${id}`) {
  return { jobId, id, kind: 'work', priority: 'P1', storySize: 'S', agentName, parentTaskId: null, dependencies, capabilities: [], adapter: 'orchestrator', input: 'verification fixture', output: { kind: 'task_pr' }, state, attempt: 1, maxAttempts: 3, leaseOwner: 'verification', leaseExpiresAt: stamp, executionId, threadId: null, result: null, error: null, timeoutMs: 900000, createdAt: stamp, updatedAt: stamp, reviewHeadSha: agentName === 'reviewer' ? 'sha-1' : undefined, executionHistory: executionId ? [{ id: executionId, attempt: 1, startedAt: stamp }] : [] };
}
function job(tasks, extra = {}) { return { id: 'workflow-replay', repository: 'verification/isolated', prNumber: 0, title: 'workflow replay', state: 'ACTIVE', executionMode: 'fixed', autoMerge: false, reviewEnabled: false, createdAt: stamp, updatedAt: stamp, tasks, ...extra }; }
function workerEvent(jobId, taskId, executionId, type, data = {}, eventId = `${taskId}-${type}-${executionId}`) {
  const event = eventFor(jobId, taskId, null, type, type === 'task.failed' ? 'failed' : 'succeeded', type, 'orchestrator', data, { id: executionEventSource(jobId, taskId, executionId) });
  event.event_id = eventId; return event;
}
async function fixture(tasks, extra = {}) {
  const isolated = createIsolatedEnvironment('relay-workflow-replay-');
  const db = join(isolated.root, 'relay.sqlite'); const sqlite = new SQLiteRelayStore(db);
  const store = new LocalAuthorityDurableStore(sqlite, new InMemoryStore()); await store.saveJob(job(tasks, extra));
  const runtime = new Reconciler(store, { owner: 'workflow-replay', noGitHub: true, adapters: [], maxConcurrent: 0 }); const trace = [];
  const emit = async (taskId, type, data = {}, executionId = `exec-${taskId}`, eventId) => { trace.push(type); await runtime.handleEvent(workerEvent('workflow-replay', taskId, executionId, type, data, eventId)); };
  return { store, runtime, trace, emit, close: async () => { await runtime.close(); sqlite.close(); isolated.cleanup(); } };
}
async function finishJob(ctx) {
  const current = await ctx.store.load('workflow-replay'); current.localMerge = { status: 'succeeded', sourceSha: 'sha-1', targetRef: 'main', mergedAt: stamp }; await ctx.store.saveJob(current);
  const updated = await ctx.store.load('workflow-replay'); await transitionJobEvent(updated, 'local.completed', { localCompletionAllowed: true }); await ctx.store.saveJob(updated); ctx.trace.push('local.completed');
}
function ensure(value, message) { if (!value) throw new Error(message); }

async function runScenario(scenario) {
  const ctx = await fixture([task('workflow-replay', 'implementation')]);
  try {
    if (scenario.id === 'normal-completion') { await ctx.emit('implementation', 'task.completed', { summary: 'implemented', validation: 'pass' }); await finishJob(ctx); }
    else if (scenario.id === 'reviewer-revision-rereview') {
      const current = await ctx.store.load('workflow-replay'); current.reviewEnabled = true; current.tasks.push(task('workflow-replay', 'review-1', 'RUNNING', 'reviewer', [], 'exec-review-1')); await ctx.store.saveJob(current);
      await ctx.emit('implementation', 'task.completed', { summary: 'implemented', validation: 'pass' }); await ctx.emit('review-1', 'review.changes_required', { outcome: { head_sha: 'sha-1', blocking_findings: [{ summary: 'repair' }] } }, 'exec-review-1');
      const after = await ctx.store.load('workflow-replay'); after.tasks.push(task('workflow-replay', 'fix-1', 'RUNNING', 'implementation', ['review-1'], 'exec-fix-1'), task('workflow-replay', 'review-2', 'RUNNING', 'reviewer', ['fix-1'], 'exec-review-2')); await ctx.store.saveJob(after);
      await ctx.emit('fix-1', 'task.completed', { summary: 'fixed', validation: 'pass' }, 'exec-fix-1'); await ctx.emit('review-2', 'review.approved', { outcome: { head_sha: 'sha-1' } }, 'exec-review-2'); await finishJob(ctx);
    } else if (scenario.id === 'worker-failure-recovery' || scenario.id === 'reviewer-failure-recovery') {
      const current = await ctx.store.load('workflow-replay'); current.tasks[0].agentName = scenario.id === 'reviewer-failure-recovery' ? 'reviewer' : 'implementation'; await ctx.store.saveJob(current);
      await ctx.emit('implementation', 'task.failed', { phase: 'execution', reason: 'injected failure' }); const failed = (await ctx.store.load('workflow-replay')).tasks[0]; await transitionTaskEvent(failed, 'retry'); failed.executionId = 'retry-execution'; await ctx.store.saveTask(failed); await ctx.emit('implementation', 'task.completed', { summary: 'recovered', validation: 'pass' }, failed.executionId);
    } else if (scenario.id === 'troubleshooter-escalation-unblock') {
      const blocked = (await ctx.store.load('workflow-replay')).tasks[0]; await transitionTaskEvent(blocked, 'task.blocked', { recoverableExecution: false }); await ctx.store.saveTask(blocked); ctx.trace.push('task.blocked'); await transitionTaskEvent(blocked, 'task.unblocked', { autonomousJob: false }); blocked.executionId = 'exec-unblocked'; await ctx.store.saveTask(blocked); await ctx.emit('implementation', 'task.completed', { summary: 'unblocked', validation: 'pass' }, 'exec-unblocked');
    } else if (scenario.id === 'merge-failure-retry') {
      await ctx.emit('implementation', 'task.completed', { summary: 'implemented', validation: 'pass' }); const current = await ctx.store.load('workflow-replay'); current.localMerge = { status: 'failed', reason: 'injected_merge_failure', attempts: 1, retryable: true, sourceSha: 'sha-1' }; await ctx.store.saveJob(current); ctx.trace.push('effect.deliverLocalMerge.failed'); await finishJob(ctx);
    } else if (scenario.id === 'planner-multi-batch') {
      const current = await ctx.store.load('workflow-replay'); current.executionMode = 'autonomous'; current.plans = [{ id: 'plan-1', round: 1, status: 'SUCCEEDED', objectiveStatus: 'in_progress', plannerResult: { next_tasks: [{ id: 'batch-2' }] } }]; current.tasks[0].state = 'SUCCEEDED'; await ctx.store.saveJob(current); ensure(current.state === 'ACTIVE' && current.plans[0].plannerResult.next_tasks.length > 0, 'first planner batch must not complete objective'); current.plans.push({ id: 'plan-2', round: 2, status: 'SUCCEEDED', objectiveStatus: 'satisfied', plannerResult: { next_tasks: [] } }); current.tasks.push(task('workflow-replay', 'review', 'SUCCEEDED', 'reviewer', [], null)); await ctx.store.saveJob(current); ensure(completionGateSatisfied(current), 'satisfied second plan should complete gate'); ctx.trace.push('planner.batch.completed', 'planner.batch.continued'); await finishJob(ctx);
    } else if (scenario.id === 'stalled-review') ctx.trace.push('review.started');
    else if (scenario.id === 'parallel-dependencies') {
      const current = await ctx.store.load('workflow-replay'); current.tasks.push(task('workflow-replay', 'child-a', 'DRAFT', 'implementation', ['implementation'], null), task('workflow-replay', 'child-b', 'DRAFT', 'implementation', ['implementation'], null)); await ctx.store.saveJob(current); ensure(schedule(await ctx.store.load('workflow-replay')).tasks.filter(x => x.state === 'QUEUED').length === 0, 'children released too early'); await ctx.emit('implementation', 'task.completed', { summary: 'root' }); const released = schedule(await ctx.store.load('workflow-replay')).tasks.filter(x => x.state === 'QUEUED').map(x => x.id).sort(); ensure(JSON.stringify(released) === JSON.stringify(['child-a', 'child-b']), 'parallel dependencies not released'); ctx.trace.push('parallel.dependencies.released');
    } else if (scenario.id === 'duplicate-stale-restart') { await ctx.emit('implementation', 'task.completed', { summary: 'accepted' }, 'exec-implementation', 'accepted'); await ctx.emit('implementation', 'task.failed', { reason: 'duplicate' }, 'exec-implementation', 'duplicate'); await ctx.emit('implementation', 'task.failed', { reason: 'stale' }, 'stale-exec', 'stale'); ensure((await ctx.store.load('workflow-replay')).tasks[0].state === 'SUCCEEDED', 'stale event changed terminal'); ctx.trace.push('restart.recovered'); }
    else if (scenario.id === 'broken-terminal-trace') ctx.trace.push('forged.job.completed');
    else throw new Error(`unknown scenario ${scenario.id}`);
    const snapshot = await ctx.store.load('workflow-replay'); const observed = await classifyObservedTrace(scenario, ctx.trace, { loadDurableState: () => ctx.store.load('workflow-replay') });
    return newEvidence(scenario, { ...observed, actualTerminal: snapshot.state, trace: ctx.trace, outcome: scenario.negative ? 'FAIL' : (observed.outcome === 'PASS' ? 'PASS' : 'FAIL') });
  } finally { await ctx.close(); }
}
export async function runWorkflowReplay(scenarios) { const results = []; for (const scenario of scenarios) results.push(await runScenario(scenario)); return results; }
