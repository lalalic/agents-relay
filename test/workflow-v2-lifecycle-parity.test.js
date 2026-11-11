import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GraphRuntime } from '../dist/workflow/graph-v2.js';
import { decideJobLifecycle, decideTaskLifecycle } from '../dist/workflow/lifecycle.js';

const eventRegistry = ids => Object.fromEntries([...new Set(ids)].map(id => [id, { id }]));
const boolGuard = name => facts => facts.durableFacts[name] === true;
const actionRegistry = ids => Object.fromEntries([...new Set(ids)].map(id => [id, { id }]));

const taskCases = [
  ['DRAFT','release',{},'QUEUED'],
  ['DRAFT','reconcile',{dependenciesSatisfied:true},'QUEUED'],
  ['DRAFT','block',{},'FAILED'],
  ['DRAFT','cancel',{},'CANCELLED'],
  ['QUEUED','hold',{},'DRAFT'],
  ['QUEUED','reconcile',{dependenciesUnsatisfied:true},'DRAFT'],
  ['QUEUED','reconcile',{runnable:true},'QUEUED'],
  ['QUEUED','dispatch',{dispatchable:true},'QUEUED'],
  ['QUEUED','task.started',{},'RUNNING'],
  ['QUEUED','review.started',{},'RUNNING'],
  ['QUEUED','review.approved',{},'SUCCEEDED'],
  ['QUEUED','review.changes_required',{},'SUCCEEDED'],
  ['QUEUED','review.blocked',{},'FAILED'],
  ['QUEUED','block',{},'FAILED'],
  ['QUEUED','fail',{},'FAILED'],
  ['QUEUED','effect.launchTask.failed',{},'FAILED'],
  ['QUEUED','watchdog.failed',{},'FAILED'],
  ['QUEUED','worker.delivery_failed',{},'FAILED'],
  ['QUEUED','worker.start_ack_failed',{},'FAILED'],
  ['QUEUED','worker.no_start_failed',{},'FAILED'],
  ['QUEUED','worker.no_start_failed',{noStartFallbackAllowed:true},'QUEUED'],
  ['QUEUED','worker.platform_failure',{},'FAILED'],
  ['QUEUED','worker.platform_failure',{platformFallbackSafe:true},'QUEUED'],
  ['RUNNING','worker.platform_failure',{},'FAILED'],
  ['QUEUED','cancel',{},'CANCELLED'],
  ['RUNNING','task.blocked',{},'FAILED'],
  ['RUNNING','task.interactive_waiting',{awaitingInteractiveDecision:true},'AWAITING_DECISION'],
  ['AWAITING_DECISION','interactive.resume',{},'QUEUED'],
  ['AWAITING_DECISION','cancel',{},'CANCELLED'],
  ['RUNNING','task.progress',{},'RUNNING'],
  ['RUNNING','review.approved',{},'SUCCEEDED'],
  ['RUNNING','review.changes_required',{},'SUCCEEDED'],
  ['RUNNING','review.blocked',{},'FAILED'],
  ['RUNNING','task.completed',{},'SUCCEEDED'],
  ['RUNNING','task.failed',{},'FAILED'],
  ['RUNNING','watchdog.failed',{},'FAILED'],
  ['RUNNING','task.cancelled',{},'CANCELLED'],
  ['BLOCKED','task.unblocked',{troubleshooterTask:true},'QUEUED'],
  ['BLOCKED','cancel',{},'CANCELLED'],
  ['FAILED','retry',{},'QUEUED'],
  ['FAILED','task.started',{recoverableExecution:true},'RUNNING'],
  ['FAILED','task.completed',{recoverableExecution:true},'SUCCEEDED'],
  ['FAILED','task.blocked',{recoverableExecution:true},'FAILED'],
  ['FAILED','task.failed',{recoverableExecution:true},'FAILED'],
  ['FAILED','task.cancelled',{recoverableExecution:true},'CANCELLED'],
  ['FAILED','cancel',{},'CANCELLED'],
];

const jobCases = [
  ['DRAFT','activate',{},'ACTIVE'],
  ['DRAFT','cancel',{},'CANCELLED'],
  ['ACTIVE','reconcile',{},'ACTIVE'],
  ['ACTIVE','review.approved',{},'ACTIVE'],
  ['ACTIVE','implementation.completed',{},'ACTIVE'],
  ['ACTIVE','shortcut.completed',{shortcutCompletionAllowed:true},'COMPLETED'],
  ['ACTIVE','content.completed',{contentCompletionAllowed:true},'COMPLETED'],
  ['ACTIVE','cancel',{},'CANCELLED'],
  ['ACTIVE','local.completed',{jobActive:true,autoMergeEnabled:true,implementationComplete:true,completionGateSatisfied:true,reviewSatisfied:true},'COMPLETED'],
  ['ACTIVE','local.merge.requested',{jobActive:true,autoMergeEnabled:true,implementationComplete:true,completionGateSatisfied:true,reviewSatisfied:true,localMergePresent:true,reviewHeadCurrent:true,mergeAttemptReady:true},'ACTIVE'],
  ['ACTIVE','effect.deliverLocalMerge.failed',{},'ACTIVE'],
  ['COMPLETED','effect.cleanupJobWorktree.failed',{},'COMPLETED'],
  ['CANCELLED','effect.cancelActiveTasks.failed',{},'CANCELLED'],
];

const taskSource = readFileSync(new URL('../workflow/task-lifecycle.mmd', import.meta.url), 'utf8');
const jobSource = readFileSync(new URL('../workflow/job-lifecycle.mmd', import.meta.url), 'utf8');

const taskRuntime = new GraphRuntime(taskSource, {
  states: new Set(['DRAFT','QUEUED','RUNNING','AWAITING_DECISION','BLOCKED','SUCCEEDED','FAILED','CANCELLED']),
  guards: {
    dependenciesSatisfied: boolGuard('dependenciesSatisfied'),
    dependenciesUnsatisfied: boolGuard('dependenciesUnsatisfied'),
    runnable: boolGuard('runnable'),
    dispatchable: boolGuard('dispatchable'),
    shortcutExecution: facts => facts.durableFacts.shortcutExecution === true,
    shortcutFallback: facts => facts.durableFacts.shortcutFallback === true,
    shortcutHasGraph: facts => facts.durableFacts.shortcutHasGraph === true,
    shortcutDirectInvocation: facts => facts.durableFacts.shortcutDirectInvocation === true,
    shortcutEffectsSafe: facts => facts.durableFacts.shortcutEffectsSafe === true,
    shortcutResultCorrelated: facts => facts.durableFacts.shortcutResultCorrelated === true,
    recoverableExecution: boolGuard('recoverableExecution'),
    troubleshooterRecovery: boolGuard('troubleshooterRecovery'),
    troubleshooterTask: boolGuard('troubleshooterTask'),
    awaitingInteractiveDecision: boolGuard('awaitingInteractiveDecision'),
    retryAvailable: boolGuard('retryAvailable'),
    platformFallbackSafe: boolGuard('platformFallbackSafe'),
    noStartFallbackAllowed: boolGuard('noStartFallbackAllowed'),
  },
  events: eventRegistry([...taskCases.map(([,event]) => event), 'task.interactive_waiting', 'shortcut.waiting', 'shortcut.failed', 'shortcut.result', 'effect.launchShortcut.failed', 'effect.resumeShortcut.failed', 'task.progress', 'lease.expired', 'planner.failed', 'planner.unavailable', 'execution.orphaned', 'queue', 'recovery.reopen', 'pause']),
  actions: actionRegistry(['mutation.clearError','mutation.clearFailureReason','mutation.clearLease','mutation.clearExecution','mutation.markLeaseExpired','mutation.markStartupOrphanedExhausted','mutation.markUnknownOutcome','mutation.markPlannerUnavailable','mutation.markShortcutWorkerFallback','mutation.markShortcutRecoveryRequired','mutation.preparePlatformFallback','mutation.quarantinePlatformFailure','mutation.prepareNoStartFallback','effect.launchTask','effect.launchShortcut','effect.resumeShortcut']),
});

const jobRuntime = new GraphRuntime(jobSource, {
  states: new Set(['DRAFT','ACTIVE','COMPLETED','CANCELLED']),
  guards: {
    notMerged: boolGuard('notMerged'),
    autoMerge: boolGuard('autoMerge'),
    prOpen: boolGuard('prOpen'),
    reviewDisabled: boolGuard('reviewDisabled'),
    implementationComplete: boolGuard('implementationComplete'),
    headAvailable: boolGuard('headAvailable'),
    mergeCapable: boolGuard('mergeCapable'),
    localCompletionAllowed: facts => facts.durableFacts.jobActive === true && facts.durableFacts.autoMergeEnabled === true
      && facts.durableFacts.implementationComplete === true
      && facts.durableFacts.completionGateSatisfied === true && facts.durableFacts.reviewSatisfied === true
      && (facts.durableFacts.localMergeRequired !== true || facts.durableFacts.localMergeSucceeded === true),
    localMergeReady: facts => facts.durableFacts.jobActive === true && facts.durableFacts.autoMergeEnabled === true
      && facts.durableFacts.implementationComplete === true
      && facts.durableFacts.completionGateSatisfied === true && facts.durableFacts.reviewSatisfied === true
      && facts.durableFacts.localMergePresent === true && facts.durableFacts.reviewHeadCurrent === true
      && facts.durableFacts.mergeAttemptReady === true,
    shortcutCompletionAllowed: facts => facts.durableFacts.shortcutCompletionAllowed === true,
    contentCompletionAllowed: facts => facts.durableFacts.contentCompletionAllowed === true,
  },
  events: eventRegistry([...jobCases.map(([,event]) => event), 'reconcile', 'local.completed', 'shortcut.completed', 'content.completed', 'local.merge.requested', 'effect.deliverLocalMerge.failed']),
  actions: actionRegistry(['effect.cancelActiveTasks','effect.mergePullRequest','effect.deliverLocalMerge','effect.cleanupJobWorktree']),
});

test('canonical Task lifecycle flowchart matches lifecycle API targets across the canonical corpus', () => {
  for (const [from,event,facts,target] of taskCases) {
    const v1 = decideTaskLifecycle({ id: 't', state: from, agentName: from === 'BLOCKED' ? 'troubleshooter' : 'implementation' }, event, facts);
    const v2 = taskRuntime.evaluateSync({ currentState: from, input: { transport: 'event', id: event, payload: {} }, durableFacts: facts });
    assert.equal(v1.accepted, true, `v1 ${from} ${event}`);
    assert.equal(v2.accepted, true, `v2 ${from} ${event}`);
    assert.equal(v2.target, target, `v2 ${from} ${event}`);
    assert.equal(v2.target, v1.target, `parity ${from} ${event}`);
    assert.deepEqual(v2.actions.map(action => action.id), v1.actions, `actions ${from} ${event}`);
  }
});

test('canonical Job lifecycle flowchart matches lifecycle API targets across the canonical corpus', () => {
  for (const [from,event,facts,target] of jobCases) {
    const v1 = decideJobLifecycle({ id: 'j', state: from }, event, facts);
    const v2 = jobRuntime.evaluateSync({ currentState: from, input: { transport: 'event', id: event, payload: {} }, durableFacts: facts });
    assert.equal(v1.accepted, true, `v1 ${from} ${event}`);
    assert.equal(v2.accepted, true, `v2 ${from} ${event}`);
    assert.equal(v2.target, target, `v2 ${from} ${event}`);
    assert.equal(v2.target, v1.target, `parity ${from} ${event}`);
    assert.deepEqual(v2.actions.map(action => action.id), v1.actions, `actions ${from} ${event}`);
  }
});

test('canonical guarded rejection and ambiguity match lifecycle API semantics', () => {
  for (const [from,event,facts] of [
    ['DRAFT','reconcile',{dependenciesSatisfied:false}],
    ['FAILED','task.completed',{recoverableExecution:false}],
  ]) {
    const v1 = decideTaskLifecycle({ id: 't', state: from }, event, facts);
    const v2 = taskRuntime.evaluateSync({ currentState: from, input: { transport: 'event', id: event, payload: {} }, durableFacts: facts });
    assert.equal(v1.accepted,false);
    assert.deepEqual(v2,{ accepted:false, source:from, reason:'no_transition' });
  }
  const ambiguousFacts={dependenciesUnsatisfied:true,runnable:true};
  const v1=decideTaskLifecycle({ id:'t', state:'QUEUED' },'reconcile',ambiguousFacts);
  const v2=taskRuntime.evaluateSync({ currentState:'QUEUED', input:{transport:'event',id:'reconcile',payload:{}}, durableFacts:ambiguousFacts });
  assert.equal(v1.accepted,false);
  assert.equal(v1.reason,'ambiguous');
  assert.deepEqual(v2,{ accepted:false, source:'QUEUED', reason:'ambiguous' });

  const jobV1=decideJobLifecycle({id:'j',state:'ACTIVE'},'pr.merged',{});
  assert.equal(jobV1.accepted,false);
  assert.throws(() => jobRuntime.evaluateSync({ currentState:'ACTIVE', input:{transport:'event',id:'pr.merged',payload:{}}, durableFacts:{} }),/unknown event/);
});
