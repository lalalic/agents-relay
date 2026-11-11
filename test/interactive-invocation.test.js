import test, { managedReconciler } from './test-runtime.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteRelayStore } from '../dist/relay-store.js';
import { InMemoryStore } from '../dist/store.js';
import { ProjectedDurableStore } from '../dist/projected-store.js';
import {
  interactiveDecisionFingerprint,
  normalizeInteractiveDecision,
} from '../dist/interactive-invocation.js';

const timestamp = () => new Date().toISOString();
const makeTask = () => ({
  jobId: 'job-interactive', id: 'task-interactive', parentTaskId: null, dependencies: [],
  capabilities: [], adapter: 'orchestrator', input: 'work', state: 'RUNNING',
  attempt: 1, maxAttempts: 3, leaseOwner: 'owner', leaseExpiresAt: timestamp(),
  executionId: 'exec-1', threadId: null, result: null, error: null,
  timeoutMs: 60_000, createdAt: timestamp(), updatedAt: timestamp(),
  continuation: null, continuationDeliveredAt: null,
});
const makeJob = (task = makeTask()) => ({
  id: task.jobId, title: 'Interactive contract', prNumber: 0,
  repository: 'local/job', state: 'ACTIVE', continuation: null,
  createdAt: timestamp(), updatedAt: timestamp(), tasks: [task],
});
const decisionEvent = (jobId, taskId, executionId, decision, feedback='', id='') => ({
  version: 1, event_id: id || `${executionId}-${decision}`,
  job_id: jobId, task_id: taskId, parent_task_id: null, type: 'task.interactive_decision',
  status: 'running', timestamp: timestamp(), visibility: 'user', level: 'info',
  message: `${decision} ${executionId}`,
  source: {id:`job/${jobId}/task/${taskId}/execution/${executionId}`},
  data:{interactive:{jobId,taskId,executionId,decision,feedback,comments:[]}},
});

async function temporaryStore() {
  const dir = await mkdtemp(join(tmpdir(), 'agents-relay-interactive-'));
  const store = new SQLiteRelayStore(join(dir, 'relay.db'));
  return { store, dbPath: join(dir, 'relay.db'), dispose: async () => { store.close(); await rm(dir, { recursive: true, force: true }); } };
}

test('execution-scoped review binds once, deduplicates, rejects stale decisions, and resumes',async()=>{
 const fixture=await temporaryStore();
 try{
  const job=makeJob();await fixture.store.saveJob(job);
  const reconciler=managedReconciler(new ProjectedDurableStore(fixture.store,new InMemoryStore(job)),{owner:'test',adapters:[]});
  const task=(await fixture.store.loadJob(job.id)).tasks[0];
  const bound=await reconciler.bindInteractiveInvocation(job.id,task,'exec-1');
  const first=decisionEvent(job.id,task.id,'exec-1','changes_requested','Shorten ending');
  assert.equal((await reconciler.applyEvent(first)).reason,'task.interactive_decision.accepted');
  assert.equal((await bound.decision).decision,'changes_requested');
  assert.match((await reconciler.applyEvent({...first,event_id:'duplicate-transport'})).reason,/duplicate/);
  assert.match((await reconciler.applyEvent(decisionEvent(job.id,task.id,'exec-1','approved','late'))).reason,/stale/);
  const sqlite=new DatabaseSync(fixture.dbPath);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM host_invocation_decision').get().n,1);
  sqlite.close();await reconciler.close();
 }finally{await fixture.dispose()}
});

test('execution-bound decision normalization does not require invocation or Git SHA',()=>{
 const event=decisionEvent('job','task','exec-1','approved','good');
 const delivery=normalizeInteractiveDecision(event);
 assert.ok(delivery);
 assert.equal(delivery.invocationId,'exec-1');
 assert.equal(delivery.revision,'exec-1');
 assert.equal(interactiveDecisionFingerprint(delivery),interactiveDecisionFingerprint({...delivery,eventId:'other',deliveredAt:'later'}));
 assert.notEqual(interactiveDecisionFingerprint(delivery),interactiveDecisionFingerprint({...delivery,feedback:'different'}));
 for(const key of ['invocationId','revision','commitSha','revisionId','contentHash']){
  const changed=structuredClone(event);changed.data.interactive[key]='unexpected';
  assert.equal(normalizeInteractiveDecision(changed),null,key+' must not be accepted');
 }
});

test('iPhone decision releases waiting Task and only resumes same Task',async()=>{
 const fixture=await temporaryStore();
 try{
  const job=makeJob();await fixture.store.saveJob(job);
  const reconciler=managedReconciler(new ProjectedDurableStore(fixture.store,new InMemoryStore(job)),{owner:'test',adapters:[]});
  const task=(await fixture.store.loadJob(job.id)).tasks[0];
  await reconciler.bindInteractiveInvocation(job.id,task,'exec-1');
  const wait={...decisionEvent(job.id,task.id,'exec-1','approved'),event_id:'waiting',type:'task.interactive_waiting',status:'waiting',data:{}};
  assert.equal((await reconciler.applyEvent(wait)).applied,true);
  assert.equal((await fixture.store.loadJob(job.id)).tasks[0].state,'AWAITING_DECISION');
  const delivered=decisionEvent(job.id,task.id,'exec-1','changes_requested','Revise narration');
  assert.equal((await reconciler.applyEvent(delivered)).reason,'task.interactive_decision.accepted');
  const current=(await fixture.store.loadJob(job.id)).tasks[0];
  assert.equal(current.state,'QUEUED');assert.equal(current.executionId,null);
  assert.equal(current.interactiveInvocation.status,'changes_requested');
  assert.equal(current.interactiveInvocation.feedback,'Revise narration');
  assert.equal((await fixture.store.loadJob(job.id)).tasks.length,1);
  assert.match((await reconciler.applyEvent(decisionEvent(job.id,task.id,'exec-1','approved'))).reason,/stale/);
  await reconciler.close();
 }finally{await fixture.dispose()}
});

test('SQLite durable decision recovers after event delivery loss',async()=>{
 const fixture=await temporaryStore();
 try{
  const job=makeJob();await fixture.store.saveJob(job);
  const reconciler=managedReconciler(new ProjectedDurableStore(fixture.store,new InMemoryStore(job)),{owner:'test',adapters:[]});
  const task=(await fixture.store.loadJob(job.id)).tasks[0];
  await reconciler.bindInteractiveInvocation(job.id,task,'exec-1');
  await reconciler.applyEvent({...decisionEvent(job.id,task.id,'exec-1','approved'),event_id:'wait',type:'task.interactive_waiting',status:'waiting',data:{}});
  const delivery=normalizeInteractiveDecision(decisionEvent(job.id,task.id,'exec-1','approved','ready'));
  const receipt=await fixture.store.recordHostInvocationDecision(delivery,interactiveDecisionFingerprint(delivery));
  assert.equal(receipt.outcome,'accepted');
  const {recoverInteractiveDecisions}=await import('../dist/interactive-resume.js');
  const projected=new ProjectedDurableStore(fixture.store,new InMemoryStore(job));
  assert.equal(await recoverInteractiveDecisions(projected,job.id),true);
  assert.equal(await recoverInteractiveDecisions(projected,job.id),false);
  assert.equal((await fixture.store.loadJob(job.id)).tasks[0].state,'QUEUED');
  await reconciler.close();
 }finally{await fixture.dispose()}
});

test('an unbound decision cannot bypass CLI request, even with valid execution identity',async()=>{
 const fixture=await temporaryStore();
 try{
  const job=makeJob();await fixture.store.saveJob(job);
  const reconciler=managedReconciler(new ProjectedDurableStore(fixture.store,new InMemoryStore(job)),{owner:'test',adapters:[]});
  const payload=decisionEvent(job.id,job.tasks[0].id,'exec-1','approved','');
  assert.match((await reconciler.applyEvent(payload)).reason,/stale/);
  const forged=structuredClone(payload);forged.event_id='forged';forged.source.id='job/other/task/task-interactive/execution/exec-1';
  assert.equal((await reconciler.applyEvent(forged)).applied,false);
  assert.equal((await fixture.store.loadJob(job.id)).tasks[0].interactiveInvocation,undefined);
  await reconciler.close();
 }finally{await fixture.dispose()}
});

test('host review event binds external context but not a separate invocation',async()=>{
 const {hostInteractiveDecisionEvent}=await import('../dist/interactive-invocation.js');
 const generic={eventId:'review-1',decision:'changes_requested',feedback:'shorten credits'};
 const event=hostInteractiveDecisionEvent({jobId:'job',taskId:'task',executionId:'exec-1'},generic);
 const delivery=normalizeInteractiveDecision(event);
 assert.equal(delivery.jobId,'job');assert.equal(delivery.taskId,'task');
 assert.equal(delivery.invocationId,'exec-1');assert.equal(delivery.feedback,'shorten credits');
 assert.equal(Object.hasOwn(event.data.interactive,'invocationId'),false);
});

test('an awaiting decision is a durable Task state, not an active execution or dependency draft', async () => {
  const fixture = await temporaryStore();
  const job = makeJob();
  await fixture.store.saveJob(job);
  const reconciler = managedReconciler(new ProjectedDurableStore(fixture.store, new InMemoryStore(job)), {
    owner: 'awaiting-lifecycle', adapters: [],
  });
  const task = (await fixture.store.loadJob(job.id)).tasks[0];
  await reconciler.bindInteractiveInvocation(job.id, task, 'exec-1');
  const badBlock = {
    ...decisionEvent(job.id, task.id, 'exec-1', 'approved'),
    event_id: 'invalid-task-blocked', type: 'task.blocked', status: 'blocked', data: {},
  };
  assert.equal((await reconciler.applyEvent(badBlock)).applied, false,
    'ordinary worker cannot disguise an interactive handoff as a Troubleshooter block');
  assert.equal((await fixture.store.loadJob(job.id)).tasks[0].state, 'RUNNING');
  assert.equal((await reconciler.applyEvent({ ...badBlock,
    event_id: 'valid-interactive-wait', type: 'task.interactive_waiting',
  })).applied, true);
  const waiting = await fixture.store.loadJob(job.id);
  assert.equal(waiting.state, 'ACTIVE');
  assert.equal(waiting.tasks[0].state, 'AWAITING_DECISION');
  assert.equal(waiting.tasks[0].executionId, null);
  assert.equal(waiting.tasks[0].leaseOwner, null);
  const { jobHasActiveExecution } = await import('../dist/job-execution-slot.js');
  const { deriveJobRuntimeStatus } = await import('../dist/runtime-status.js');
  const { reconcileTaskDependencies } = await import('../dist/workflow/task-reconcile.js');
  assert.equal(jobHasActiveExecution(waiting), false);
  assert.equal(deriveJobRuntimeStatus(waiting), 'WAITING');
  reconcileTaskDependencies(waiting);
  assert.equal(waiting.tasks[0].state, 'AWAITING_DECISION', 'reconcile must never queue a waiting Task');
  const { tryApplyTaskCancelAction } = await import('../dist/task-actions.js');
  assert.equal(tryApplyTaskCancelAction(waiting.tasks[0], 'Cancelled while awaiting user'), true);
  await fixture.store.saveJob(waiting);
  const delayed = await reconciler.applyEvent(decisionEvent(job.id, task.id, 'exec-1', 'approved', 'too late'));
  assert.match(delayed.reason, /stale|ignored/);
  assert.equal((await fixture.store.loadJob(job.id)).tasks[0].state, 'CANCELLED');
  await reconciler.close();
  await fixture.dispose();
});

test('SQLite startup migrates only legacy DRAFT interactive waits and preserves ordinary drafts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-wait-migration-'));
  const dbPath = join(dir, 'relay.db');
  const store = new SQLiteRelayStore(dbPath);
  const waiting = { ...makeTask(), state: 'DRAFT', executionId: null,
    leaseOwner: null, leaseExpiresAt: null,
    interactiveInvocation: { invocationId: 'old-inv', revision: 'v1', executionId: 'exec-1',
      status: 'awaiting_decision', boundAt: timestamp() } };
  const ordinary = { ...makeTask(), id: 'draft-unstarted', state: 'DRAFT',
    executionId: null, leaseOwner: null, leaseExpiresAt: null };
  const heldAfterReview = { ...makeTask(), id: 'draft-held-after-review', state: 'DRAFT', attempt: 0,
    executionId: null, leaseOwner: null, leaseExpiresAt: null,
    interactiveInvocation: { invocationId: 'already-decided', revision: 'v1', executionId: 'exec-1',
      status: 'approved', boundAt: timestamp(), decidedAt: timestamp() } };
  await store.saveJob({ ...makeJob(waiting), tasks: [waiting, ordinary, heldAfterReview] });
  store.close();
  const reopened = new SQLiteRelayStore(dbPath);
  const migrated = await reopened.loadJob('job-interactive');
  assert.equal(migrated.tasks[0].state, 'AWAITING_DECISION');
  assert.equal(migrated.tasks[1].state, 'DRAFT');
  assert.equal(migrated.tasks[2].state, 'DRAFT');
  assert.equal(migrated.tasks[0].interactiveInvocation.invocationId, 'old-inv');
  const sql = new DatabaseSync(dbPath);
  const durable = JSON.parse(sql.prepare('SELECT json FROM job_snapshot WHERE job_id=?')
    .get('job-interactive').json);
  assert.equal(durable.tasks[0].state, 'AWAITING_DECISION', 'migration must persist, not just decorate reads');
  assert.equal(durable.tasks[1].state, 'DRAFT');
  assert.equal(durable.tasks[2].state, 'DRAFT');
  sql.close();
  reopened.close();
  await rm(dir, { recursive: true, force: true });
});
