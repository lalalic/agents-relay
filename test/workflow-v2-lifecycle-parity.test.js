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
  ['DRAFT','block',{},'BLOCKED'],
  ['DRAFT','cancel',{},'CANCELLED'],
  ['QUEUED','hold',{},'DRAFT'],
  ['QUEUED','reconcile',{dependenciesUnsatisfied:true},'DRAFT'],
  ['QUEUED','reconcile',{runnable:true},'QUEUED'],
  ['QUEUED','dispatch',{dispatchable:true},'QUEUED'],
  ['QUEUED','task.started',{},'RUNNING'],
  ['QUEUED','review.started',{},'RUNNING'],
  ['QUEUED','review.approved',{},'SUCCEEDED'],
  ['QUEUED','review.changes_required',{},'SUCCEEDED'],
  ['QUEUED','review.blocked',{},'BLOCKED'],
  ['QUEUED','block',{},'BLOCKED'],
  ['QUEUED','fail',{},'FAILED'],
  ['QUEUED','effect.launchTask.failed',{},'FAILED'],
  ['QUEUED','watchdog.failed',{},'FAILED'],
  ['QUEUED','worker.delivery_failed',{},'FAILED'],
  ['QUEUED','worker.start_ack_failed',{},'FAILED'],
  ['QUEUED','cancel',{},'CANCELLED'],
  ['RUNNING','task.blocked',{},'BLOCKED'],
  ['RUNNING','review.approved',{},'SUCCEEDED'],
  ['RUNNING','review.changes_required',{},'SUCCEEDED'],
  ['RUNNING','review.blocked',{},'BLOCKED'],
  ['RUNNING','task.completed',{},'SUCCEEDED'],
  ['RUNNING','task.failed',{},'FAILED'],
  ['RUNNING','watchdog.failed',{},'FAILED'],
  ['RUNNING','task.cancelled',{},'CANCELLED'],
  ['BLOCKED','task.unblocked',{},'UNBLOCKED'],
  ['BLOCKED','cancel',{},'CANCELLED'],
  ['UNBLOCKED','retry',{},'QUEUED'],
  ['FAILED','retry',{},'QUEUED'],
  ['FAILED','task.started',{recoverableExecution:true},'RUNNING'],
  ['FAILED','task.completed',{recoverableExecution:true},'SUCCEEDED'],
  ['FAILED','task.blocked',{recoverableExecution:true},'BLOCKED'],
  ['FAILED','task.failed',{recoverableExecution:true},'FAILED'],
  ['FAILED','task.cancelled',{recoverableExecution:true},'CANCELLED'],
  ['FAILED','cancel',{},'CANCELLED'],
];

const jobCases = [
  ['DRAFT','activate',{},'ACTIVE'],
  ['DRAFT','pr.merged',{},'COMPLETED'],
  ['DRAFT','cancel',{},'CANCELLED'],
  ['DRAFT','pr.closed',{notMerged:true},'CANCELLED'],
  ['ACTIVE','review.approved',{autoMerge:true},'ACTIVE'],
  ['ACTIVE','implementation.completed',{autoMerge:true},'ACTIVE'],
  ['ACTIVE','effect.mergePullRequest.failed',{},'ACTIVE'],
  ['ACTIVE','pr.merged',{},'COMPLETED'],
  ['ACTIVE','cancel',{},'CANCELLED'],
  ['ACTIVE','pr.closed',{notMerged:true},'CANCELLED'],
  ['CANCELLED','pr.merged',{},'COMPLETED'],
  ['CANCELLED','effect.cancelActiveTasks.failed',{},'CANCELLED'],
  ['COMPLETED','effect.cancelActiveTasks.failed',{},'COMPLETED'],
];

const taskSource = readFileSync(new URL('../workflow/task-lifecycle-v2.mmd', import.meta.url), 'utf8');
const jobSource = readFileSync(new URL('../workflow/job-lifecycle-v2.mmd', import.meta.url), 'utf8');

const taskRuntime = new GraphRuntime(taskSource, {
  states: new Set(['DRAFT','QUEUED','RUNNING','BLOCKED','UNBLOCKED','SUCCEEDED','FAILED','CANCELLED']),
  guards: {
    dependenciesSatisfied: boolGuard('dependenciesSatisfied'),
    dependenciesUnsatisfied: boolGuard('dependenciesUnsatisfied'),
    runnable: boolGuard('runnable'),
    dispatchable: boolGuard('dispatchable'),
    recoverableExecution: boolGuard('recoverableExecution'),
    retryAvailable: boolGuard('retryAvailable'),
  },
  events: eventRegistry([...taskCases.map(([,event]) => event), 'lease.expired', 'planner.failed', 'planner.unavailable', 'execution.orphaned', 'queue']),
  actions: actionRegistry(['mutation.clearError','mutation.clearFailureReason','mutation.clearLease','mutation.clearExecution','mutation.markLeaseExpired','mutation.markStartupOrphanedExhausted','mutation.markPlannerUnavailable','effect.launchTask']),
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
  },
  events: eventRegistry([...jobCases.map(([,event]) => event), 'reconcile']),
  actions: actionRegistry(['effect.cancelActiveTasks','effect.mergePullRequest']),
});

test('v2 Task lifecycle flowchart matches v1 transition targets across the canonical corpus', () => {
  for (const [from,event,facts,target] of taskCases) {
    const v1 = decideTaskLifecycle({ id: 't', state: from }, event, facts);
    const v2 = taskRuntime.evaluateSync({ currentState: from, input: { transport: 'event', id: event, payload: {} }, durableFacts: facts });
    assert.equal(v1.accepted, true, `v1 ${from} ${event}`);
    assert.equal(v2.accepted, true, `v2 ${from} ${event}`);
    assert.equal(v2.target, target, `v2 ${from} ${event}`);
    assert.equal(v2.target, v1.target, `parity ${from} ${event}`);
    assert.deepEqual(v2.actions.map(action => action.id), v1.actions, `actions ${from} ${event}`);
  }
});

test('v2 Job lifecycle flowchart matches v1 transition targets across the canonical corpus', () => {
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

test('v2 guarded rejection and ambiguity match v1 lifecycle semantics', () => {
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

  const jobV1=decideJobLifecycle({id:'j',state:'ACTIVE'},'review.approved',{autoMerge:false});
  const jobV2=jobRuntime.evaluateSync({ currentState:'ACTIVE', input:{transport:'event',id:'review.approved',payload:{}}, durableFacts:{autoMerge:false} });
  assert.equal(jobV1.accepted,false);
  assert.deepEqual(jobV2,{ accepted:false, source:'ACTIVE', reason:'no_transition' });
});
