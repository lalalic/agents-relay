import test from 'node:test';
import assert from 'node:assert/strict';
import { jobLifecycleWorkflow, taskLifecycleWorkflow } from '../dist/workflow/definitions.js';
import {
  decideJobLifecycle,
  decideTaskLifecycle,
  parseWorkflowRolloutMode,
  resetWorkflowRolloutDiagnostics,
  setWorkflowRolloutMode,
  setWorkflowShadowReporter,
  workflowRolloutSnapshot,
} from '../dist/workflow/rollout.js';
import { schedule, transitionJobEvent, transitionTaskEvent } from '../dist/scheduler.js';

const task = state => ({
  jobId: 'job-ab',
  id: 'task-ab',
  state,
  dependencies: [],
  error: null,
  updatedAt: '2026-09-23T00:00:00.000Z',
});
const job = state => ({
  id: 'job-ab',
  state,
  tasks: [],
  executionMode: 'fixed',
  title: 'A/B',
  prNumber: 73,
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
  ['QUEUED','block',{},'BLOCKED'],
  ['QUEUED','fail',{},'FAILED'],
  ['QUEUED','cancel',{},'CANCELLED'],
  ['RUNNING','task.blocked',{},'BLOCKED'],
  ['RUNNING','task.completed',{},'SUCCEEDED'],
  ['RUNNING','task.failed',{},'FAILED'],
  ['RUNNING','task.cancelled',{},'CANCELLED'],
  ['BLOCKED','retry',{},'QUEUED'],
  ['BLOCKED','cancel',{},'CANCELLED'],
  ['FAILED','retry',{},'QUEUED'],
  ['FAILED','reconcile.started',{},'RUNNING'],
  ['FAILED','reconcile.completed',{},'SUCCEEDED'],
  ['FAILED','reconcile.blocked',{},'BLOCKED'],
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

test.afterEach(() => {
  setWorkflowRolloutMode(null);
  setWorkflowShadowReporter(null);
  resetWorkflowRolloutDiagnostics();
});

test('workflow rollout mode defaults to legacy and validates explicit values', () => {
  assert.equal(parseWorkflowRolloutMode(undefined),'legacy');
  assert.equal(parseWorkflowRolloutMode('legacy'),'legacy');
  assert.equal(parseWorkflowRolloutMode('shadow'),'shadow');
  assert.equal(parseWorkflowRolloutMode('graph'),'graph');
  assert.throws(()=>parseWorkflowRolloutMode('replace'),/expected legacy, shadow, or graph/);
});

test('shadow parity corpus keeps legacy authoritative with zero mismatches', () => {
  const diagnostics=[];
  setWorkflowRolloutMode('shadow');
  setWorkflowShadowReporter(value=>diagnostics.push(value));
  for (const [from,event,facts,target] of taskCases) {
    const decision=decideTaskLifecycle(task(from),event,facts);
    assert.equal(decision.accepted,true,`${from} ${event}`);
    assert.equal(decision.target,target,`${from} ${event}`);
  }
  for (const [from,event,facts,target] of jobCases) {
    const decision=decideJobLifecycle(job(from),event,facts);
    assert.equal(decision.accepted,true,`${from} ${event}`);
    assert.equal(decision.target,target,`${from} ${event}`);
  }
  for (const [from,event,facts] of [
    ['RUNNING','hold',{}],
    ['SUCCEEDED','retry',{}],
    ['DRAFT','reconcile',{dependenciesSatisfied:false}],
  ]) assert.equal(decideTaskLifecycle(task(from),event,facts).accepted,false);
  const snapshot=workflowRolloutSnapshot();
  assert.equal(snapshot.mode,'shadow');
  assert.equal(snapshot.mismatches,0);
  assert.equal(snapshot.matches,taskCases.length+jobCases.length+3);
  assert.equal(diagnostics.every(item=>item.type==='workflow.shadow.match'),true);
});

test('graph mode runs the same deterministic lifecycle corpus', () => {
  setWorkflowRolloutMode('graph');
  for (const [from,event,facts,target] of taskCases) assert.equal(decideTaskLifecycle(task(from),event,facts).target,target);
  for (const [from,event,facts,target] of jobCases) assert.equal(decideJobLifecycle(job(from),event,facts).target,target);
});

test('shadow evaluation never executes graph actions or transition mutation', async () => {
  setWorkflowRolloutMode('shadow');
  const original=taskLifecycleWorkflow.transitionSync;
  taskLifecycleWorkflow.transitionSync=()=>{ throw new Error('graph side effect executed'); };
  try {
    const current=task('QUEUED');
    await transitionTaskEvent(current,'task.started');
    assert.equal(current.state,'RUNNING');
  } finally {
    taskLifecycleWorkflow.transitionSync=original;
  }
});

test('injected graph divergence is detected while legacy remains authoritative', () => {
  const diagnostics=[];
  setWorkflowRolloutMode('shadow');
  setWorkflowShadowReporter(value=>diagnostics.push(value));
  const original=taskLifecycleWorkflow.enabledSync;
  taskLifecycleWorkflow.enabledSync=()=>[];
  try {
    const decision=decideTaskLifecycle(task('QUEUED'),'task.started');
    assert.equal(decision.target,'RUNNING');
    assert.deepEqual(workflowRolloutSnapshot(),{mode:'shadow',matches:0,mismatches:1});
    assert.equal(diagnostics.length,1);
    assert.equal(diagnostics[0].type,'workflow.shadow.mismatch');
    assert.equal(diagnostics[0].legacy.target,'RUNNING');
    assert.equal(diagnostics[0].graph.accepted,false);
  } finally {
    taskLifecycleWorkflow.enabledSync=original;
  }
});

test('legacy and shadow persistence results remain identical for transition and reconcile paths', async () => {
  const legacyTask=task('QUEUED');
  legacyTask.error='stale';
  setWorkflowRolloutMode('legacy');
  await transitionTaskEvent(legacyTask,'task.started');
  const legacyJob=job('DRAFT');
  await transitionJobEvent(legacyJob,'activate');

  const shadowTask=task('QUEUED');
  shadowTask.error='stale';
  setWorkflowRolloutMode('shadow');
  await transitionTaskEvent(shadowTask,'task.started');
  const shadowJob=job('DRAFT');
  await transitionJobEvent(shadowJob,'activate');

  assert.equal(shadowTask.state,legacyTask.state);
  assert.equal(shadowTask.error,legacyTask.error);
  assert.equal(shadowJob.state,legacyJob.state);

  const dep={...task('SUCCEEDED'),id:'dep'};
  const legacyChild={...task('DRAFT'),id:'child',dependencies:['dep']};
  setWorkflowRolloutMode('legacy');
  const legacyScheduled=schedule({...job('ACTIVE'),tasks:[dep,legacyChild]});

  const shadowDep={...task('SUCCEEDED'),id:'dep'};
  const shadowChild={...task('DRAFT'),id:'child',dependencies:['dep']};
  setWorkflowRolloutMode('shadow');
  const shadowScheduled=schedule({...job('ACTIVE'),tasks:[shadowDep,shadowChild]});
  assert.equal(legacyScheduled.tasks[1].state,'QUEUED');
  assert.equal(shadowScheduled.tasks[1].state,'QUEUED');
});
