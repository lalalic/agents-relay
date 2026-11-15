import test, { managedReconciler } from './test-runtime.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { SQLiteRelayStore } from '../dist/relay-store.js';
import { InMemoryStore } from '../dist/store.js';
import { ProjectedDurableStore } from '../dist/projected-store.js';
import {
  eventOnlyReviewEligible,
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
  repository: 'job', state: 'ACTIVE', continuation: null,
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
  let activeStore = store;
  return { store, dbPath: join(dir, 'relay.db'), setStore: value => { activeStore = value; },
    dispose: async () => { activeStore.close(); await rm(dir, { recursive: true, force: true }); } };
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
 assert.equal(interactiveDecisionFingerprint(delivery),createHash('sha256').update(JSON.stringify({
  jobId:'job',taskId:'task',executionId:'exec-1',invocationId:'exec-1',revision:'exec-1',
  decision:'approved',feedback:'good',comments:[],
 })).digest('hex'),'legacy bound-decision fingerprints remain stable across deployment');
 assert.notEqual(interactiveDecisionFingerprint(delivery),interactiveDecisionFingerprint({...delivery,feedback:'different'}));
 for(const key of ['commitSha','revisionId','contentHash']){
  const changed=structuredClone(event);changed.data.interactive[key]='unexpected';
  assert.equal(normalizeInteractiveDecision(changed),null,key+' must not be accepted');
 }
 const explicitBound=structuredClone(event);
 explicitBound.data.interactive.invocationId='bound-invocation';
 explicitBound.data.interactive.revision='bound-revision';
 assert.equal(normalizeInteractiveDecision(explicitBound).invocationId,'bound-invocation',
  'explicit bound identity remains available for durable matching');
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

test('an event-only decision needs complete immutable identity and cannot finalize its running Task',async()=>{
 const fixture=await temporaryStore();
 try{
  const job=makeJob();await fixture.store.saveJob(job);
  const reconciler=managedReconciler(new ProjectedDurableStore(fixture.store,new InMemoryStore(job)),{owner:'test',adapters:[]});
  const payload=decisionEvent(job.id,job.tasks[0].id,'exec-1','changes_requested','revise');
  payload.data.interactive = { ...payload.data.interactive, invocationId:'inv-1', revision:'a'.repeat(64),
    contentHash:'a'.repeat(64), revisionId:'rev-1', requestId:'request-1', idempotencyKey:'decision-1' };
  const normalized=normalizeInteractiveDecision(payload);
  assert.ok(normalized);
  assert.equal(eventOnlyReviewEligible(normalized),true);
  assert.equal(eventOnlyReviewEligible({...normalized,feedback:undefined}),false,
   'the shared eligibility guard must reject missing feedback at the persistence boundary');
  const incomplete=structuredClone(payload);delete incomplete.data.interactive.requestId;
  assert.match((await reconciler.applyEvent(incomplete)).reason,/ignored/);
  const accepted=await reconciler.applyEvent(payload);
  assert.equal(accepted.reason,'task.interactive_decision.accepted');
  let current=await fixture.store.loadJob(job.id);
  assert.equal(current.tasks[0].state,'RUNNING');
  assert.equal(current.tasks[0].executionId,'exec-1');
  assert.equal(current.tasks[0].interactiveInvocation.status,'changes_requested');
  assert.equal(current.state,'ACTIVE','an accepted preview decision is not Job completion');
  await reconciler.close();
  fixture.store.close();
  const reopened=new SQLiteRelayStore(fixture.dbPath);
  fixture.setStore(reopened);
  fixture.store=reopened;
  const restarted=managedReconciler(new ProjectedDurableStore(reopened,new InMemoryStore(job)),{owner:'test-restart',adapters:[]});
  assert.match((await restarted.applyEvent({...payload,event_id:'duplicate-after-restart'})).reason,/duplicate/);
  const replay=structuredClone(payload);replay.event_id='replayed-revision';
  replay.data.interactive.invocationId='other-invocation';
  replay.data.interactive.idempotencyKey='other-idempotency-key';
  assert.match((await restarted.applyEvent(replay)).reason,/stale/);
  const nextRevision=structuredClone(payload);nextRevision.event_id='next-revision';
  nextRevision.data.interactive = { ...payload.data.interactive, invocationId:'inv-2', revision:'b'.repeat(64),
    contentHash:'b'.repeat(64), revisionId:'rev-2', requestId:'request-2', idempotencyKey:'decision-2',
    decision:'approved', feedback:'' };
  assert.equal((await restarted.applyEvent(nextRevision)).reason,'task.interactive_decision.accepted');
  const forged=structuredClone(nextRevision);forged.event_id='forged';forged.source.id='job/other/task/task-interactive/execution/exec-1';
  assert.equal((await restarted.applyEvent(forged)).applied,false);
  current=await reopened.loadJob(job.id);
  assert.equal(current.tasks[0].state,'RUNNING');
  assert.equal(current.tasks[0].interactiveInvocation.status,'approved');
  assert.equal(current.tasks[0].interactiveInvocation.contentHash,'b'.repeat(64));
  await restarted.close();
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
