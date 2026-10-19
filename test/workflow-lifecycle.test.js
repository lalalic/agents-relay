import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import {
  decideJobLifecycle,
  decideTaskLifecycle,
} from '../dist/workflow/lifecycle.js';
import { schedule, transitionJobEvent, transitionTaskEvent } from '../dist/scheduler.js';
import { decideJobReconcile } from '../dist/workflow/job-reconcile-v2.js';

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
  ['QUEUED','worker.platform_failure',{platformFallbackSafe:true},'QUEUED'],
  ['QUEUED','worker.platform_failure',{platformFallbackSafe:false},'BLOCKED'],
  ['QUEUED','cancel',{},'CANCELLED'],
  ['RUNNING','task.blocked',{},'BLOCKED'],
  ['RUNNING','review.approved',{},'SUCCEEDED'],
  ['RUNNING','review.changes_required',{},'SUCCEEDED'],
  ['RUNNING','review.blocked',{},'BLOCKED'],
  ['RUNNING','task.completed',{},'SUCCEEDED'],
  ['RUNNING','task.failed',{},'FAILED'],
  ['RUNNING','watchdog.failed',{},'FAILED'],
  ['RUNNING','task.cancelled',{},'CANCELLED'],
  ['RUNNING','cancel',{},'CANCELLED'],
  ['BLOCKED','task.unblocked',{},'QUEUED'],
  ['BLOCKED','cancel',{},'CANCELLED'],
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
  ['DRAFT','cancel',{},'CANCELLED'],
  ['ACTIVE','reconcile',{},'ACTIVE'],
  ['ACTIVE','review.approved',{},'ACTIVE'],
  ['ACTIVE','implementation.completed',{},'ACTIVE'],
  ['ACTIVE','cancel',{},'CANCELLED'],
  ['ACTIVE','local.merge.requested',{localMergeReady:true},'ACTIVE'],
  ['ACTIVE','local.completed',{localCompletionAllowed:true},'COMPLETED'],
  ['ACTIVE','effect.deliverLocalMerge.failed',{},'ACTIVE'],
  ['COMPLETED','effect.cleanupJobWorktree.failed',{},'COMPLETED'],
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

test('planner unavailable is a canonical Task graph failure without attempt manipulation', async () => {
  const current={...task('QUEUED'),attempt:0,maxAttempts:3,leaseOwner:null,leaseExpiresAt:null,executionId:null};
  const decision=await transitionTaskEvent(current,'planner.unavailable');
  assert.equal(decision.target,'FAILED');
  assert.equal(current.state,'FAILED');
  assert.equal(current.attempt,0);
  assert.equal(current.error,'No objective planner configured');
});

test('platform fallback graph clears routing while preserving identity and execution history', async () => {
  const current={...task('QUEUED'),attempt:1,maxAttempts:3,leaseOwner:'relay',leaseExpiresAt:'2099-01-01T00:00:00.000Z',executionId:'exec-chat',executionHistory:[{id:'exec-chat',attempt:1,startedAt:'2026-09-23T00:00:00.000Z'}],routing:{provider:'chatgpt',model:'account-defaults',decidedBy:'test',decidedAt:'2026-09-23T00:00:00.000Z'},workerSelection:{workerId:'chatgpt/browser-worker',adapter:'chatgpt',capabilities:['model'],selectedBy:'test',selectedAt:'2026-09-23T00:00:00.000Z'},error:'platform rejected'};
  const decision=await transitionTaskEvent(current,'worker.platform_failure',{platformFallbackSafe:true});
  assert.equal(decision.target,'QUEUED');
  assert.equal(current.id,'task-graph');
  assert.equal(current.executionId,null);
  assert.equal(current.routing,undefined);
  assert.equal(current.workerSelection,undefined);
  assert.equal(current.executionHistory[0].id,'exec-chat');
  assert.equal(current.error,null);

  const unknown={...current,state:'QUEUED',attempt:1,maxAttempts:3,executionId:'exec-unknown',routing:{provider:'chatgpt',model:'account-defaults',decidedBy:'test',decidedAt:'2026-09-23T00:00:00.000Z'},workerSelection:{workerId:'chatgpt/browser-worker',adapter:'chatgpt',capabilities:['model'],selectedBy:'test',selectedAt:'2026-09-23T00:00:00.000Z'},platformFailure:{classification:'start_ack_timeout',executionId:'exec-unknown',route:{workerId:'chatgpt/browser-worker',adapter:'chatgpt',provider:'chatgpt',model:'account-defaults'},evidence:'start ack expired',safeToReroute:false,at:'2026-09-23T00:00:00.000Z'}};
  const quarantined=await transitionTaskEvent(unknown,'worker.platform_failure',{platformFallbackSafe:false});
  assert.equal(quarantined.target,'BLOCKED');
  assert.equal(unknown.failureReason,'worker_outcome_unknown');
  assert.equal(unknown.executionId,null);
  assert.equal(unknown.routing,undefined);
  assert.equal(unknown.platformFailure.classification,'start_ack_timeout');
});

test('Job reconcile never invokes GitHub actions; local completion owns the terminal gate', () => {
  const active=job('ACTIVE');
  for (const prState of ['OPEN','MERGED','CLOSED','UNKNOWN']) {
    const result=decideJobReconcile(active,{jobActive:true,implementationComplete:false,headAvailable:false,deliveryReady:false});
    assert.equal(result.accepted,true);
    assert.equal(result.target,'ACTIVE');
    assert.deepEqual(result.effects,[]);
  }
  const local=decideJobLifecycle(active,'local.completed',{localCompletionAllowed:true});
  assert.equal(local.target,'COMPLETED');
});

test('terminal GitHub PR facts cannot complete, cancel, or clean a local Job', () => {
  for (const status of ['MERGED','CLOSED']) {
    for (const state of ['ACTIVE','COMPLETED','CANCELLED']) {
      const result=decideJobReconcile(job(state),{jobActive:state==='ACTIVE',implementationComplete:false,headAvailable:false,deliveryReady:false});
      assert.equal(result.target,state==='ACTIVE' ? 'ACTIVE' : null,status+'/'+state);
      assert.deepEqual(result.effects,[],status+'/'+state);
    }
  }
  assert.equal(decideJobLifecycle(job('ACTIVE'),'pr.merged',{}).accepted,false);
  assert.equal(decideJobLifecycle(job('ACTIVE'),'pr.closed',{}).accepted,false);
});

test('job cancel graph owns active-work cancellation effect', () => {
  for (const state of ['DRAFT','ACTIVE']) {
    const decision=decideJobLifecycle(job(state),'cancel');
    assert.equal(decision.accepted,true);
    assert.equal(decision.target,'CANCELLED');
    assert.deepEqual(decision.effects,['effect.cancelActiveTasks']);
  }
});

test('graph reconcile releases satisfied dependencies', () => {
  const dep={...task('SUCCEEDED'),id:'dep'};
  const child={...task('DRAFT'),id:'child',dependencies:['dep']};
  const scheduled=schedule({...job('ACTIVE'),tasks:[dep,child]});
  assert.equal(scheduled.tasks[1].state,'QUEUED');
});


test('production lifecycle source does not import the legacy stateDiagram definitions', () => {
  for (const name of ['types.ts','workflow/lifecycle.ts','scheduler.ts']) {
    const source=readFileSync(new URL('../src/'+name,import.meta.url),'utf8');
    assert.doesNotMatch(source,/workflow\/definitions(?:\.js)?['"]/ ,name+' must use v2 lifecycle definitions');
    assert.doesNotMatch(source,/from ['"]\.\/definitions\.js['"]/ ,name+' must not load the legacy lifecycle runtime');
  }
});

test('command and adapter mutation surfaces do not bypass shared Action boundaries', () => {
  for (const name of ['cli.ts','dashboard-actions.ts','blockers.ts','manual-plan.ts']) {
    const source=readFileSync(new URL('../src/'+name,import.meta.url),'utf8');
    assert.doesNotMatch(source,/transitionTaskEvent\s*\(/,name+' must route task command mutations through task-actions');
    assert.doesNotMatch(source,/transitionJobEvent\s*\([^\n]*['"](?:activate|cancel)['"]/,name+' must route job command mutations through job-actions');
  }
  const cli=readFileSync(new URL('../src/cli.ts',import.meta.url),'utf8');
  assert.doesNotMatch(cli,/applyTaskCancelAction\s*\(/,'CLI task cancel must use shared task action dispatcher');
  const dashboard=readFileSync(new URL('../src/dashboard-actions.ts',import.meta.url),'utf8');
  assert.match(dashboard,/dispatchWorkflowTargetOverride\s*\(/,'dashboard state overrides must enter the shared workflow dispatcher');
  assert.doesNotMatch(dashboard,/assertJobLifecycleTransition\s*\(|assertTaskTransition\s*\(/,'dashboard must not perform graph topology decisions outside the dispatcher');
  assert.doesNotMatch(dashboard,/applyTaskCancelAction\s*\(/,'dashboard task cancel must use shared task action dispatcher');
});

test('related task scope is graph-driven while TypeScript only supplies facts', async () => {
  const actions = await readFile(new URL('../src/task-actions.ts', import.meta.url), 'utf8');
  const policy = await readFile(new URL('../src/workflow/task-action-policy.ts', import.meta.url), 'utf8');
  const facts = await readFile(new URL('../src/workflow/task-related-action-v2.ts', import.meta.url), 'utf8');
  const graph = await readFile(new URL('../workflow/task-related-action.mmd', import.meta.url), 'utf8');
  assert.match(actions, /selectRelatedTaskMutations\s*\(/);
  assert.doesNotMatch(actions, /agentName\s*===\s*['"]troubleshooter['"]/);
  assert.doesNotMatch(actions, /startsWith\(`troubleshoot-/);
  assert.doesNotMatch(policy, /agentName|parentTaskId|startsWith\(`troubleshoot-/);
  assert.match(policy, /decideRelatedTaskAction\s*\(/);
  assert.match(facts, /recoveryForTask:/);
  assert.match(facts, /candidateCancellable:\s*decideTaskLifecycle\(candidate, 'cancel'\)\.accepted/);
  assert.match(graph, /request: task\.retry/);
  assert.match(graph, /guard: recoveryForTask/);
  assert.match(graph, /guard: candidateCancellable/);
  assert.match(graph, /action: related\.cancel/);
});

test('action helpers do not duplicate lifecycle state allow-lists', async () => {
  const tasks = await readFile(new URL('../src/task-actions.ts', import.meta.url), 'utf8');
  const jobs = await readFile(new URL('../src/job-actions.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(tasks, /task\.state\s*!==\s*['"]FAILED['"]/);
  assert.doesNotMatch(tasks, /\['DRAFT', 'QUEUED', 'RUNNING', 'BLOCKED', 'FAILED'\]/);
  assert.doesNotMatch(tasks, /task\.state\s*!==\s*['"]DRAFT['"]/);
  assert.doesNotMatch(tasks, /task\.state\s*!==\s*['"]QUEUED['"]/);
  assert.doesNotMatch(jobs, /job\.state\s*===\s*['"]COMPLETED['"]|job\.state\s*===\s*['"]CANCELLED['"]/);
});
