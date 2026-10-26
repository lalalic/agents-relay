import { DatabaseSync } from 'node:sqlite';
import type { Job, EventRecord, TaskResolution, TaskEscalation } from './types.js';
import { normalizeLegacyTaskLifecycle } from './types.js';
import { normalizeRelayJob } from './relay-job-snapshot-reads.js';
import { taskLifecycleV2 } from './workflow/definitions-v2.js';
import { dispatchWorkflowGraphSync } from './workflow/dispatcher.js';
import { WorkflowActionLedger } from './workflow/action-ledger.js';
import { ConditionRegistry, booleanCondition } from './workflow/conditions.js';
import { DurableWorkflowPublication } from './workflow/durable-publication.js';
import { randomUUID } from 'node:crypto';
import { appendTaskComment } from './task-comments.js';
import type { TaskComment } from './task-comments.js';
import type { ProjectionRequest } from './projection-outbox.js';
function monotonicJobTimestamp(previous:string,candidate=new Date().toISOString()):string {const a=Date.parse(previous),b=Date.parse(candidate);return new Date(Math.max(Number.isFinite(a)?a+1:Date.now(),Number.isFinite(b)?b:Date.now())).toISOString();}
function recordTaskStateHistory(current: Job, next: Job): TaskComment[] {
  const appended: TaskComment[] = [];
  for (const task of next.tasks) {
    const before = current.tasks.find(item => item.id === task.id);
    if (!before) continue;
    for (const field of ['resolution', 'escalation'] as const) {
      const prior = before[field] ?? null, value = task[field] ?? null;
      if (JSON.stringify(prior) === JSON.stringify(value) || value === null) continue;
      const resolution = field === 'resolution' ? value as TaskResolution : null;
      const escalation = field === 'escalation' ? value as TaskEscalation : null;
      const kind = resolution ? 'resolution.changed'
        : escalation?.status === 'responded' ? 'escalation.responded' : 'escalation.requested';
      const action = resolution ? `Authoritative resolution changed: ${JSON.stringify(resolution)}`
        : escalation?.status === 'responded'
          ? `Human response to escalation ${escalation.id}: ${escalation.response ?? ''}. Re-evaluate the historical resolution condition against original execution evidence.`
          : `Authoritative escalation changed: ${JSON.stringify(escalation)}`;
      appended.push(appendTaskComment(next, task.id, action, {
        author: escalation?.status === 'responded' ? 'human' : 'relay', kind,
        executionId: resolution ? before.executionId ?? task.executionId ?? undefined : escalation?.originalExecutionId ?? before.executionId ?? undefined,
        transition: resolution ? `resolution.${resolution.state}` : `escalation.${escalation?.status}`,
        idempotencyKey: `task-state/${next.id}/${task.id}/${field}/${randomUUID()}`,
      }));
    }
  }
  return appended;
}
export class SQLiteWorkflowOperations {
  constructor(private readonly db: DatabaseSync, private readonly write: (job:Job,at:string)=>void, private readonly enqueue?: (request: ProjectionRequest, now: string)=>void) {}
  async commitWorkflowMutationAndEvents(
    jobId: string, mutation: (job: Job) => Job,
    events: readonly {key: string; event: EventRecord}[],
  ): Promise<Job> {
    let committed: Job | undefined;
    new DurableWorkflowPublication(this.db).commitTransitionAndEvents(() => {
      const row = this.db.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get(jobId) as {json?:string}|undefined;
      if (!row?.json) throw new Error(`Unknown Job ${jobId}`);
      const current = normalizeRelayJob(row.json);
      current.tasks = current.tasks.map(task => normalizeLegacyTaskLifecycle(task));
      const previous = structuredClone(current);
      const next = mutation(current);
      if (next.id !== jobId) throw new Error('Cannot change authoritative Job identity');
      if (next.state !== current.state && ['COMPLETED','CANCELLED'].includes(current.state))
        throw new Error('Cannot overwrite terminal authoritative state');
      const history = recordTaskStateHistory(previous, next);
      const beforeTime=Date.parse(current.updatedAt);
      if (Number.isFinite(beforeTime) && !(Date.parse(next.updatedAt)>beforeTime))
        next.updatedAt=new Date(beforeTime+1).toISOString();
      this.write(next,new Date().toISOString());
      if (next.prNumber > 0) for (const comment of history) this.enqueue?.({ idempotencyKey: `append_task_comment:${comment.idempotencyKey ?? comment.id}`, operation: 'append_task_comment', payload: { operation: 'append_task_comment', value: comment }, priority: 20 }, new Date().toISOString());
      committed=structuredClone(next);
    }, ()=>events.map(item=>({key:item.key,eventId:item.event.type,payload:item.event})));
    return committed!;
  }
  async commitWorkflowMutationWithEvents(jobId:string,mutation:(job:Job)=>{next:Job;events:readonly {key:string;event:EventRecord}[]}):Promise<Job>{
    const emitted:{key:string;event:EventRecord}[]=[];
    return this.commitWorkflowMutationAndEvents(jobId,current=>{
      const result=mutation(current);emitted.push(...result.events);return result.next;
    },emitted);
  }
  async reserveWorkflowLaunch(identity: {jobId:string;taskId:string;executionId:string;attempt:number;leaseOwner:string}): Promise<boolean> {
    const decision=dispatchWorkflowGraphSync(taskLifecycleV2,{initialState:'QUEUED',input:{transport:'event',id:'dispatch',payload:{}},durableFacts:{dispatchable:true}});
    if (!decision.accepted || !decision.actions.some(action=>action.id==='effect.launchTask'))
      throw new Error('canonical Task Graph did not authorize launch');
    return new WorkflowActionLedger(this.db).reserveForClaimedDispatch({
      ...identity,generation:identity.attempt,graph:'task-lifecycle.mmd',actionId:'effect.launchTask',
      attemptKey:`${identity.jobId}/${identity.taskId}/${identity.executionId}/launch`,
    },decision,'worker.started');
  }
  async verifyWorkflowLaunch(jobId:string,taskId:string,executionId:string): Promise<'Verified'|'Failed'|'Unknown'> {
    const ledger=new WorkflowActionLedger(this.db);
    const key=`${jobId}/${taskId}/${executionId}/launch`;
    if (!ledger.trace(key)) return 'Unknown';
    const row=this.db.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get(jobId) as {json?:string}|undefined;
    if (!row?.json) return 'Unknown';
    const job=JSON.parse(row.json) as Job;
    const task=job.tasks.find(t=>t.id===taskId);
    // Only the canonical task.started transition persists RUNNING. The action
    // did not set RUNNING at claim-time; therefore this state is a durable
    // postcondition correlated to the exact execution generation.
    const started=task?.state==='RUNNING' && task.executionId===executionId
      && !!task.leaseOwner && task.executionHistory?.some(e=>e.id===executionId && e.attempt===task.attempt);
    const registry=new ConditionRegistry([booleanCondition('worker.started')]);
    return ledger.verify(key,registry,{'worker.started':started ? true : undefined}).outcome;
  }
  async drainWorkflowEvents(publish: (event: EventRecord) => Promise<void>): Promise<number> {
    return new DurableWorkflowPublication(this.db).replay(async item => {
      const event = item.payload as EventRecord;
      if (!event || event.event_id !== item.key || event.type !== item.eventId)
        throw new Error('Outbox event identity mismatch');
      await publish(event);
    });
  }
  async mutateJob(jobId: string, mutation: (current: Job) => Job): Promise<Job> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get(jobId) as { json?: string } | undefined;
      if (!row?.json) throw new Error(`Local authoritative Job ${jobId} not found`);
      const current = normalizeRelayJob(row.json);
      current.tasks = current.tasks.map(task => normalizeLegacyTaskLifecycle(task));
      const previous = structuredClone(current);
      const before = JSON.stringify(current);
      const next = mutation(current);
      const history = recordTaskStateHistory(previous, next);
      if (next.id !== jobId) throw new Error('Cannot change authoritative Job identity');
      if (JSON.stringify(next) !== before && next.updatedAt <= JSON.parse(before).updatedAt) {
        next.updatedAt = monotonicJobTimestamp(JSON.parse(before).updatedAt);
      }
      this.write(next, new Date().toISOString());
      if (next.prNumber > 0) for (const comment of history) this.enqueue?.({ idempotencyKey: `append_task_comment:${comment.idempotencyKey ?? comment.id}`, operation: 'append_task_comment', payload: { operation: 'append_task_comment', value: comment }, priority: 20 }, new Date().toISOString());
      this.db.exec('COMMIT');
      return structuredClone(next);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
