import test from './test-runtime.js';
import assert from 'node:assert/strict';
import {
  decideJobLifecycle,
  decideTaskLifecycle,
} from '../dist/workflow/lifecycle.js';
import { schedule, transitionJobEvent, transitionTaskEvent } from '../dist/scheduler.js';

const task = state => ({
  jobId: 'job-graph',
  id: 'task-graph',
  state,
  dependencies: [],
  error: null,
  updatedAt: '2026-09-23T00:00:00.000Z',
});

const job = state => ({
  id: 'job-graph',
  state,
  tasks: [],
  executionMode: 'fixed',
  title: 'Graph lifecycle',
  prNumber: 74,
  repository: 'lalalic/agents-relay',
  continuation: null,
  createdAt: '2026-09-23T00:00:00.000Z',
  updatedAt: '2026-09-23T00:00:00.000Z',
});

const taskCases = [
  ['DRAFT','release',{},'QUEUED'],
  ['DRAFT','reconcile',{dependenciesSatisfied:true},'QUEUED'],
  ['DRAFT','block',{},'BLOCKED'],
  ['DRAFT','cancel',{},'CANCELLED'],
  ['QUEUED','hold',{},'DRAFT'],
  ['QUEUED','reconcile',{dependenciesUnsatisfied:true},'DRAFT'],
  ['QUEUED','reconcile',{runnable:true},'QUEUED'],
  ['QUEUED','task.started',{},'RUNNING'],
  ['QUEUED','review.started',{},'RUNNING'],
  ['QUEUED','review.approved',{},'SUCCEEDED'],
  ['QUEUED','review.changes_required',{},'SUCCEEDED'],
  ['QUEUED','review.blocked',{},'BLOCKED'],
  ['QUEUED','block',{},'BLOCKED'],
  ['QUEUED','fail',{},'FAILED'],
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
  ['CANCELLED','recover',{explicitRecovery:true},'QUEUED'],
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
  ['ACTIVE','pr.merged',{},'COMPLETED'],
  ['ACTIVE','cancel',{},'CANCELLED'],
  ['ACTIVE','pr.closed',{notMerged:true},'CANCELLED'],
  ['CANCELLED','pr.merged',{},'COMPLETED'],
];

test('Graph Engine is authoritative for the lifecycle transition corpus', () => {
  for (const [from,event,facts,target] of taskCases) {
    const decision=decideTaskLifecycle(task(from),event,facts);
    assert.equal(decision.accepted,true,String(from)+' '+String(event));
    assert.equal(decision.target,target,String(from)+' '+String(event));
  }
  for (const [from,event,facts,target] of jobCases) {
    const decision=decideJobLifecycle(job(from),event,facts);
    assert.equal(decision.accepted,true,String(from)+' '+String(event));
    assert.equal(decision.target,target,String(from)+' '+String(event));
  }
  for (const [from,event,facts] of [
    ['RUNNING','hold',{}],
    ['SUCCEEDED','retry',{}],
    ['SUCCEEDED','watchdog.failed',{}],
    ['FAILED','task.completed',{recoverableExecution:false}],
    ['RUNNING','worker.delivery_failed',{}],
    ['DRAFT','reconcile',{dependenciesSatisfied:false}],
    ['CANCELLED','recover',{}],
  ]) assert.equal(decideTaskLifecycle(task(from),event,facts).accepted,false);
});

test('graph decisions drive durable transition mutations', async () => {
  const current=task('QUEUED');
  current.error='stale';
  await transitionTaskEvent(current,'task.started');
  assert.equal(current.state,'RUNNING');
  assert.equal(current.error,null);

  const currentJob=job('DRAFT');
  await transitionJobEvent(currentJob,'activate');
  assert.equal(currentJob.state,'ACTIVE');
});

test('graph reconcile releases satisfied dependencies', () => {
  const dep={...task('SUCCEEDED'),id:'dep'};
  const child={...task('DRAFT'),id:'child',dependencies:['dep']};
  const scheduled=schedule({...job('ACTIVE'),tasks:[dep,child]});
  assert.equal(scheduled.tasks[1].state,'QUEUED');
});
