import { loadRelayJob, listRelayJobs } from './relay-job-snapshot-reads.js';
import { SQLiteWorkflowOperations } from './relay-workflow-operations.js';
import { taskLifecycleV2 } from './workflow/definitions-v2.js';
import { dispatchWorkflowGraphSync } from './workflow/dispatcher.js';
import { WorkflowActionLedger } from './workflow/action-ledger.js';
import { ConditionRegistry, booleanCondition } from './workflow/conditions.js';
import { DurableWorkflowPublication } from './workflow/durable-publication.js';
import type { EventRecord } from './types.js';
import { preserveTaskComments } from './task-comments.js'; import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path'; import { mkdirSync } from 'node:fs'; import { normalizeLegacyTaskLifecycle, type AgentRegistration, type Job, type Plan, type Task } from './types.js';
import type { PullRequestState } from './store.js';
import type { PackagePublication, PackagePublishFailure } from './github-webhook.js';
import { recordPublicationInDatabase, loadPublicationFromDatabase, type PublicationState, type PublicationEvent, listPublicationEventsFromDatabase } from './publication-store.js';
import type { ExecutionProcessRecord } from './process-identity.js';
import type { InteractiveDecisionDelivery, InteractiveDecisionOutcome, InteractiveInvocation } from './interactive-invocation.js';
import { observability } from './observability.js';
import { createJobIfAbsent } from './relay-create.js'; import { ensureUnifiedJobRegistry, createUnifiedJobIfAbsent } from './unified-job-registry.js'; import { migrateUnifiedRelaySchema } from './unified-relay-schema.js';
import { saveUnifiedPullRequestFacts } from './unified-pr-facts.js';
import { migrateLegacyJobPrNumbers, normalizeLegacyJobPrNumber } from './job-pr-number-migration.js';
import { hostInvocationTablesSql, recordHostInvocationEvent, hasHostInvocationDecision, recordHostInvocationDecision, type HostInvocationReceipt } from './host-invocation-store.js';
import {
  ProjectionOutbox,
  SCHEMA_VERSION,
  logicalOperationKey,
  type ProjectionConflictDiagnostic,
  type ProjectionConflictRecord,
  type ProjectionConflictResolutionRequest,
  type ProjectionOperation,
  type ProjectionOutboxItem,
  type ProjectionRequest,
} from './projection-outbox.js';
export type {
  ProjectionConflictDiagnostic,
  ProjectionConflictRecord,
  ProjectionConflictResolution,
  ProjectionConflictResolutionRequest,
  ProjectionOperation,
  ProjectionOutboxItem,
  ProjectionRequest,
  ProjectionStatus,
} from './projection-outbox.js';
export type PullRequestFacts = {
  state: PullRequestState;
  head: { ref: string; sha: string } | null;
  observedAt: string;
};
export interface RelayStore {
  reserveWorkflowLaunch?(identity: {jobId: string; taskId: string; executionId: string; attempt: number; leaseOwner: string}): Promise<boolean>;
  verifyWorkflowLaunch?(jobId: string, taskId: string, executionId: string): Promise<'Verified'|'Failed'|'Unknown'>;
  commitWorkflowMutationAndEvents?(jobId: string, mutation: (job: Job) => Job, events: readonly {key: string; event: EventRecord}[]): Promise<Job>;
  commitWorkflowMutationWithEvents?(jobId: string, mutation: (job:Job)=>{next:Job;events:readonly {key:string;event:EventRecord}[]}):Promise<Job>;
  drainWorkflowEvents?(publish: (event: EventRecord) => Promise<void>): Promise<number>;
  loadJob(jobId: string): Promise<Job | null>;
  listJobs(): Promise<Job[]>;
  saveJob(job: Job): Promise<void>;
  createJobIfAbsent?(job: Job): Promise<Job>;
  mutateJob?(jobId: string, mutation: (current: Job) => Job): Promise<Job>;
  ingestJobSnapshot(job: Job): Promise<Job>;
  saveJobWithProjection(job: Job, request: ProjectionRequest): Promise<void>;
  loadAgents(): Promise<AgentRegistration[] | null>;
  saveAgents(agents: readonly AgentRegistration[]): Promise<void>;
  upsertAgent?(agent: AgentRegistration): Promise<void>;
  saveAgentWithProjection(agent: AgentRegistration, request: ProjectionRequest): Promise<void>;
  loadPullRequestFacts(): Promise<PullRequestFacts | null>;
  recordPublication?(jobId: string, deliveryId: string, publication: PackagePublication | null, failure: PackagePublishFailure | null, observedAt?: string): Promise<boolean>;
  loadPublication?(jobId: string): Promise<PublicationState | null>;
  listPublicationEvents?(jobId: string): Promise<PublicationEvent[]>;
  savePullRequestFacts(facts: PullRequestFacts): Promise<void>;
  markEventProcessed(eventId: string, stream?: string | null, sequence?: number | null): Promise<boolean>;
  recordExecutionProcess(record: ExecutionProcessRecord): Promise<void>;
  loadExecutionProcess(jobId: string, taskId: string, executionId: string): Promise<ExecutionProcessRecord | null>;
  finishExecutionProcess(jobId: string, taskId: string, executionId: string, at?: string): Promise<void>;
  recordHostInvocationEvent?(delivery: InteractiveDecisionDelivery, outcome: InteractiveDecisionOutcome, fingerprint: string): Promise<void>;
  hasHostInvocationDecision?(jobId: string, taskId: string, invocationId: string, fingerprint?: string): Promise<boolean>;
  recordHostInvocationDecision?(delivery: InteractiveDecisionDelivery, fingerprint: string): Promise<{ outcome: InteractiveDecisionOutcome; reason: string; invocation?: InteractiveInvocation }>;
  enqueueProjection(request: ProjectionRequest): Promise<void>;
  enqueueExternalActionOnce?(request: ProjectionRequest): Promise<boolean>;
  claimDueProjections(limit?: number, now?: Date): Promise<ProjectionOutboxItem[]>;
  completeProjection(id: number): Promise<void>;
  completeProjectionWithReceipt(id: number, operationKey: string, status: 'succeeded' | 'failed', attempts: number, detail: unknown): Promise<void>;
  retryProjectionWithReceipt(id: number, operationKey: string, error: string, nextAttemptAt: Date, attempts: number, detail: unknown): Promise<void>;
  retryProjection(id: number, error: string, nextAttemptAt: Date): Promise<void>;
  deadLetterProjection(id: number, error: string): Promise<void>;
  recordProjectionConflict(id: number, diagnostic: ProjectionConflictDiagnostic): Promise<void>;
  listProjectionConflicts(): Promise<ProjectionConflictRecord[]>;
  resolveProjectionConflict(id: number, resolution: ProjectionConflictResolutionRequest): Promise<boolean>;
  conflictProjectionCount(): Promise<number>;
  pendingProjectionCount(): Promise<number>;
  terminalProjectionCount(): Promise<number>;
  recordProjectionReceipt?(operationKey: string, status: 'succeeded' | 'failed', attempts: number, detail: unknown): Promise<void>;
  close(): void;
}
function newerRecord<T extends { updatedAt: string }>(local: T | undefined, remote: T): T {
  if (!local) return structuredClone(remote);
  return remote.updatedAt > local.updatedAt ? structuredClone(remote) : structuredClone(local);
}
function mergeRecords<T extends { id: string; updatedAt: string }>(local: readonly T[], remote: readonly T[]): T[] {
  const remoteById = new Map(remote.map(item => [item.id, item]));
  const merged = local.map(item => newerRecord(item, remoteById.get(item.id) ?? item));
  const localIds = new Set(local.map(item => item.id));
  for (const item of remote) if (!localIds.has(item.id)) merged.push(structuredClone(item));
  return merged;
}
export function mergeInboundJobSnapshot(local: Job, remote: Job): Job {
  const base = remote.updatedAt > local.updatedAt ? structuredClone(remote) : structuredClone(local);
  base.tasks = preserveTaskComments(local.tasks, mergeRecords<Task>(local.tasks, remote.tasks));
  const localPlans = local.plans ?? [];
  const remotePlans = remote.plans ?? [];
  if (localPlans.length > 0 || remotePlans.length > 0) {
    base.plans = mergeRecords<Plan>(localPlans, remotePlans).sort((a, b) => a.round - b.round);
  } else {
    delete base.plans;
  }
  return base;
}
function monotonicJobTimestamp(previous: string, candidate = new Date().toISOString()): string {
  const prior = Date.parse(previous), next = Date.parse(candidate);
  if (!Number.isFinite(prior)) return candidate;
  return new Date(Math.max(Number.isFinite(next) ? next : Date.now(), prior + 1)).toISOString();
}
export class SQLiteRelayStore implements RelayStore {
  private readonly db: DatabaseSync;
  private readonly outbox: ProjectionOutbox;
  constructor(readonly path: string, readonly scopeJobId?: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    if (scopeJobId) {
      const hasUnifiedSchema = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='migration_metadata'").get();
      if (!hasUnifiedSchema) migrateUnifiedRelaySchema(this.db);
      else {
        const schema = this.db.prepare("SELECT value FROM migration_metadata WHERE key='schema'").get() as { value?: string } | undefined;
        if (schema?.value !== 'single-sqlite-staging-v1') throw new Error('Unified Relay schema is missing or unsupported');
      }
    } else this.migrate();
    this.outbox = new ProjectionOutbox(this.db, scopeJobId);
    this.outbox.resetProcessing(new Date().toISOString());
  }
  private assertScope(jobId: string): void {
    if (this.scopeJobId && jobId !== this.scopeJobId) throw new Error(`Wrong scoped Job ID ${jobId}; expected ${this.scopeJobId}`);
  }
  private migrate(): void { this.db.exec(`
      CREATE TABLE IF NOT EXISTS relay_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS job_snapshot (
        job_id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pull_request_facts (
        id INTEGER PRIMARY KEY CHECK(id=1),
        state TEXT NOT NULL CHECK(state IN ('OPEN','MERGED','CLOSED')),
        head_ref TEXT,
        head_sha TEXT,
        observed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS publication_state (job_id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS publication_delivery (job_id TEXT NOT NULL, delivery_id TEXT NOT NULL, type TEXT NOT NULL, json TEXT NOT NULL, observed_at TEXT NOT NULL, PRIMARY KEY(job_id,delivery_id));
      CREATE TABLE IF NOT EXISTS agent_snapshot (
        agent_id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS event_receipt (
        event_id TEXT PRIMARY KEY,
        stream TEXT,
        sequence INTEGER,
        received_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS execution_process (
        job_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        lease_owner TEXT NOT NULL,
        host TEXT NOT NULL,
        pid INTEGER NOT NULL,
        pgid INTEGER NOT NULL,
        start_token TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        ended_at TEXT,
        PRIMARY KEY(job_id,task_id,execution_id)
      );
      ${hostInvocationTablesSql}
      ${ProjectionOutbox.createTableSql()}
      ${ProjectionOutbox.createReceiptTableSql()}
      ${ProjectionOutbox.createIndexSql()}
    `);
    migrateLegacyJobPrNumbers(this.db);
    const current = this.db.prepare("SELECT value FROM relay_meta WHERE key='schema_version'").get() as { value?: string } | undefined;
    const version = current?.value ? Number(current.value) : 0;
    if (version > SCHEMA_VERSION) throw new Error(`Relay store schema ${version} is newer than supported ${SCHEMA_VERSION}`);
    if (version < SCHEMA_VERSION) ProjectionOutbox.upgrade(this.db, version);
    this.db.prepare("INSERT INTO relay_meta(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(String(SCHEMA_VERSION));
  }
  async recordPublication(jobId: string, deliveryId: string, publication: PackagePublication | null, failure: PackagePublishFailure | null, observedAt?: string): Promise<boolean> {
    return recordPublicationInDatabase(this.db, jobId, deliveryId, publication, failure, observedAt);
  }
  async loadPublication(jobId: string): Promise<PublicationState | null> {
    return loadPublicationFromDatabase(this.db, jobId);
  }
  async listPublicationEvents(jobId: string): Promise<PublicationEvent[]> {
    return listPublicationEventsFromDatabase(this.db, jobId);
  }
  async loadJob(jobId:string):Promise<Job|null>{ this.assertScope(jobId); return loadRelayJob(this.db,jobId); }
  async listJobs():Promise<Job[]>{ return listRelayJobs(this.db,this.scopeJobId); }
  async saveJob(job: Job): Promise<void> {
    if (!this.scopeJobId) { this.writeJobSnapshot(job, new Date().toISOString()); return; }
    this.db.exec('BEGIN IMMEDIATE');
    try { this.writeJobSnapshot(job, new Date().toISOString()); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private workflowOperations(): SQLiteWorkflowOperations {
    return new SQLiteWorkflowOperations(this.db, (job,at)=>this.writeJobSnapshot(job,at), (request,now)=>{ this.enqueueProjectionInTransaction(request,now); });
  }
  async commitWorkflowMutationAndEvents(jobId:string,mutation:(job:Job)=>Job,events:readonly {key:string;event:EventRecord}[]):Promise<Job> {
    this.assertScope(jobId);
    return this.workflowOperations().commitWorkflowMutationAndEvents(jobId,mutation,events);
  }
  async commitWorkflowMutationWithEvents(jobId:string,mutation:(job:Job)=>{next:Job;events:readonly {key:string;event:EventRecord}[]}):Promise<Job>{
    this.assertScope(jobId);return this.workflowOperations().commitWorkflowMutationWithEvents(jobId,mutation);
  }
  async reserveWorkflowLaunch(identity:{jobId:string;taskId:string;executionId:string;attempt:number;leaseOwner:string}):Promise<boolean>{
    this.assertScope(identity.jobId);
    return this.workflowOperations().reserveWorkflowLaunch(identity);
  }
  async verifyWorkflowLaunch(jobId:string,taskId:string,executionId:string):Promise<'Verified'|'Failed'|'Unknown'>{
    this.assertScope(jobId);
    return this.workflowOperations().verifyWorkflowLaunch(jobId,taskId,executionId);
  }
  async drainWorkflowEvents(publish:(event:EventRecord)=>Promise<void>):Promise<number>{
    return this.workflowOperations().drainWorkflowEvents(publish);
  }
  async createJobIfAbsent(job: Job): Promise<Job> {
    this.assertScope(job.id);
    return this.scopeJobId
      ? createUnifiedJobIfAbsent(this.db, job, now => this.writeJobSnapshot(job, now))
      : createJobIfAbsent(this.db, job);
  }
  /** Atomic read/modify/write for local authoritative Task and Plan updates. */
  async mutateJob(jobId: string, mutation: (current: Job) => Job): Promise<Job> {
    this.assertScope(jobId);
    return this.workflowOperations().mutateJob(jobId, mutation);
  }
  async ingestJobSnapshot(job: Job): Promise<Job> {
    this.assertScope(job.id);
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get(job.id) as { json?: string } | undefined;
      const local = row?.json ? JSON.parse(row.json) as Job : null;
      const merged = local ? mergeInboundJobSnapshot(local, job) : structuredClone(job);
      this.writeJobSnapshot(merged, now);
      this.db.exec('COMMIT');
      return structuredClone(merged);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  async saveJobWithProjection(job: Job, request: ProjectionRequest): Promise<void> {
    this.assertScope(job.id);
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.writeJobSnapshot(job, now);
      const coalesced = this.enqueueProjectionInTransaction(request, now);
      this.db.exec('COMMIT');
      observability().record({
        stage: 'projection', event: 'projection.enqueued', outcome: coalesced ? 'deduplicated' : 'succeeded',
        message: coalesced
          ? `Projection ${request.operation} coalesced`
          : `Projection ${request.operation} enqueued`,
        correlation: { repository: job.repository, prNumber: job.prNumber, jobId: job.id },
        data: { operation: request.operation, idempotencyKey: request.idempotencyKey, coalesceKey: request.coalesceKey, priority: request.priority ?? 0, coalesced },
      });
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private writeJobSnapshot(job: Job, now: string): void {
    if (this.scopeJobId) ensureUnifiedJobRegistry(this.db, job, this.scopeJobId);
    this.db.prepare(`
      INSERT INTO job_snapshot(job_id,json,updated_at) VALUES(?,?,?)
      ON CONFLICT(job_id) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at
    `).run(job.id, JSON.stringify(job), now);
  }
  async loadAgents(): Promise<AgentRegistration[] | null> {
    const observed = this.scopeJobId
      ? this.db.prepare("SELECT value FROM relay_meta WHERE scope_job_id=? AND key='agent_registry_observed_at'").get(this.scopeJobId) as {value?:string}|undefined
      : this.db.prepare("SELECT value FROM relay_meta WHERE key='agent_registry_observed_at'").get() as { value?: string } | undefined;
    if (!observed?.value) return null;
    const rows = this.db.prepare(this.scopeJobId ? 'SELECT json FROM agent_snapshot WHERE scope_job_id=? ORDER BY agent_id' : 'SELECT json FROM agent_snapshot ORDER BY agent_id').all(...(this.scopeJobId ? [this.scopeJobId] : [])) as unknown as Array<{ json: string }>;
    return rows.map(row => JSON.parse(row.json) as AgentRegistration);
  }
  async saveAgents(agents: readonly AgentRegistration[]): Promise<void> {
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.scopeJobId) {
        this.db.prepare('DELETE FROM agent_snapshot WHERE scope_job_id=?').run(this.scopeJobId);
        const insert = this.db.prepare('INSERT INTO agent_snapshot(scope_job_id,agent_id,json,updated_at) VALUES(?,?,?,?)');
        for (const agent of agents) insert.run(this.scopeJobId, agent.id, JSON.stringify(agent), now);
      } else {
        this.db.prepare('DELETE FROM agent_snapshot').run();
        const insert = this.db.prepare('INSERT INTO agent_snapshot(agent_id,json,updated_at) VALUES(?,?,?)');
        for (const agent of agents) insert.run(agent.id, JSON.stringify(agent), now);
      }
      this.markAgentRegistryObserved(now);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  async upsertAgent(agent: AgentRegistration): Promise<void> {
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.writeAgentSnapshot(agent, now);
      this.markAgentRegistryObserved(now);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  async saveAgentWithProjection(agent: AgentRegistration, request: ProjectionRequest): Promise<void> {
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.writeAgentSnapshot(agent, now);
      this.markAgentRegistryObserved(now);
      this.enqueueProjectionInTransaction(request, now);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private writeAgentSnapshot(agent: AgentRegistration, now: string): void {
    if (this.scopeJobId) {
      this.db.prepare(`INSERT INTO agent_snapshot(scope_job_id,agent_id,json,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(scope_job_id,agent_id) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at`)
        .run(this.scopeJobId, agent.id, JSON.stringify(agent), now);
    } else {
      this.db.prepare(`INSERT INTO agent_snapshot(agent_id,json,updated_at) VALUES(?,?,?)
        ON CONFLICT(agent_id) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at`)
        .run(agent.id, JSON.stringify(agent), now);
    }
  }
  private markAgentRegistryObserved(now: string): void {
    if (this.scopeJobId) {
      this.db.prepare(`INSERT INTO relay_meta(scope_job_id,key,value) VALUES(?,'agent_registry_observed_at',?)
        ON CONFLICT(scope_job_id,key) DO UPDATE SET value=excluded.value`).run(this.scopeJobId, now);
    } else {
      this.db.prepare(`INSERT INTO relay_meta(key,value) VALUES('agent_registry_observed_at',?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(now);
    }
  }
  async loadPullRequestFacts(): Promise<PullRequestFacts | null> {
    const row = this.db.prepare(this.scopeJobId ? 'SELECT state,head_ref,head_sha,observed_at FROM pull_request_facts WHERE scope_job_id=? AND id=1' : 'SELECT state,head_ref,head_sha,observed_at FROM pull_request_facts WHERE id=1').get(...(this.scopeJobId ? [this.scopeJobId] : [])) as { state?: PullRequestState; head_ref?: string | null; head_sha?: string | null; observed_at?: string } | undefined;
    if (!row?.state || !row.observed_at) return null;
    return { state: row.state, head: row.head_ref && row.head_sha ? { ref: row.head_ref, sha: row.head_sha } : null, observedAt: row.observed_at };
  }
  async savePullRequestFacts(facts: PullRequestFacts): Promise<void> {
    // UNKNOWN means absence of confirmed external evidence; never persist it as a fact.
    if (facts.state === 'UNKNOWN') return;
    if (this.scopeJobId) {
      saveUnifiedPullRequestFacts(this.db, this.scopeJobId, facts);
    } else {
    this.db.prepare(`
      INSERT INTO pull_request_facts(id,state,head_ref,head_sha,observed_at) VALUES(1,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET state=excluded.state,head_ref=excluded.head_ref,head_sha=excluded.head_sha,observed_at=excluded.observed_at
      WHERE excluded.observed_at >= pull_request_facts.observed_at
        AND (pull_request_facts.state='OPEN'
          OR (pull_request_facts.state='CLOSED' AND excluded.state IN ('CLOSED','MERGED'))
          OR (pull_request_facts.state='MERGED' AND excluded.state='MERGED'))
    `).run(facts.state, facts.head?.ref ?? null, facts.head?.sha ?? null, facts.observedAt);
    }
  }
  async recordExecutionProcess(record: ExecutionProcessRecord): Promise<void> {
    const existing = await this.loadExecutionProcess(record.jobId, record.taskId, record.executionId);
    if (existing && (existing.pid !== record.pid || existing.pgid !== record.pgid || existing.host !== record.host || existing.startToken !== record.startToken)) {
      throw new Error(`Conflicting process identity for ${record.jobId}/${record.taskId}/${record.executionId}`);
    }
    this.db.prepare(`INSERT OR IGNORE INTO execution_process
      (job_id,task_id,execution_id,lease_owner,host,pid,pgid,start_token,observed_at,ended_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      record.jobId, record.taskId, record.executionId, record.leaseOwner, record.host,
      record.pid, record.pgid, record.startToken, record.observedAt, record.endedAt ?? null,
    );
  }
  async loadExecutionProcess(jobId: string, taskId: string, executionId: string): Promise<ExecutionProcessRecord | null> {
    const row = this.db.prepare(`SELECT lease_owner,host,pid,pgid,start_token,observed_at,ended_at
      FROM execution_process WHERE job_id=? AND task_id=? AND execution_id=?`).get(jobId, taskId, executionId) as
      { lease_owner: string; host: string; pid: number; pgid: number; start_token: string; observed_at: string; ended_at: string | null } | undefined;
    return row ? { jobId, taskId, executionId, leaseOwner: row.lease_owner,
      host: row.host, pid: row.pid, pgid: row.pgid, startToken: row.start_token,
      observedAt: row.observed_at, endedAt: row.ended_at } : null;
  }
  async finishExecutionProcess(jobId: string, taskId: string, executionId: string, at = new Date().toISOString()): Promise<void> {
    this.db.prepare('UPDATE execution_process SET ended_at=COALESCE(ended_at,?) WHERE job_id=? AND task_id=? AND execution_id=?')
      .run(at, jobId, taskId, executionId);
  }
  async recordHostInvocationEvent(delivery: InteractiveDecisionDelivery, outcome: InteractiveDecisionOutcome, fingerprint: string): Promise<void> {
    recordHostInvocationEvent(this.db, delivery, outcome, fingerprint);
  }
  async hasHostInvocationDecision(jobId: string, taskId: string, invocationId: string, fingerprint?: string): Promise<boolean> {
    return hasHostInvocationDecision(this.db, jobId, taskId, invocationId, fingerprint);
  }
  async recordHostInvocationDecision(delivery: InteractiveDecisionDelivery, fingerprint: string): Promise<HostInvocationReceipt> {
    return recordHostInvocationDecision(this.db, delivery, fingerprint, (job, at) => this.writeJobSnapshot(job, at));
  }
  async markEventProcessed(eventId: string, stream: string | null = null, sequence: number | null = null): Promise<boolean> {
    const result = this.scopeJobId
      ? this.db.prepare('INSERT OR IGNORE INTO event_receipt(scope_job_id,event_id,stream,sequence,received_at) VALUES(?,?,?,?,?)')
        .run(this.scopeJobId, eventId, stream, sequence, new Date().toISOString())
      : this.db.prepare('INSERT OR IGNORE INTO event_receipt(event_id,stream,sequence,received_at) VALUES(?,?,?,?)')
        .run(eventId, stream, sequence, new Date().toISOString());
    return Number(result.changes) === 1;
  }
  private enqueueProjectionInTransaction(request: ProjectionRequest, now: string): boolean {
    return this.outbox.enqueue(request, now);
  }
  async enqueueProjection(request: ProjectionRequest): Promise<void> {
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const coalesced = this.enqueueProjectionInTransaction(request, now);
      this.db.exec('COMMIT');
      observability().record({
        stage: 'projection', event: 'projection.enqueued', outcome: coalesced ? 'deduplicated' : 'succeeded',
        message: coalesced
          ? `Projection ${request.operation} coalesced`
          : `Projection ${request.operation} enqueued`,
        data: { operation: request.operation, idempotencyKey: request.idempotencyKey, coalesceKey: request.coalesceKey, priority: request.priority ?? 0, coalesced },
      });
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  /**
   * Idempotent external-effect reservation. Repeated Graph reconciliation
   * must never reset backoff or queue a second merge while a first one runs.
   */
  async enqueueExternalActionOnce(request: ProjectionRequest): Promise<boolean> {
    if (!['merge_pull_request', 'close_pull_request', 'update_pr_body', 'create_pull_request'].includes(request.operation)) {
      throw new Error('Lifecycle projection is forbidden in external-only outbox');
    }
    const key = logicalOperationKey(request.idempotencyKey);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.scopeJobId
        ? (this.db.prepare('SELECT id FROM projection_outbox WHERE scope_job_id=? AND operation_key=? LIMIT 1').get(this.scopeJobId,key)
          ?? this.db.prepare('SELECT operation_key FROM projection_receipt WHERE scope_job_id=? AND operation_key=?').get(this.scopeJobId,key))
        : (this.db.prepare('SELECT id FROM projection_outbox WHERE operation_key=? LIMIT 1').get(key)
          ?? this.db.prepare('SELECT operation_key FROM projection_receipt WHERE operation_key=?').get(key));
      if (existing) {
        this.db.exec('COMMIT');
        return false;
      }
      this.outbox.enqueue(request, new Date().toISOString());
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  async claimDueProjections(limit = 50, now = new Date()): Promise<ProjectionOutboxItem[]> {
    return this.outbox.claimDue(limit, now);
  }
  async completeProjection(id: number): Promise<void> { this.outbox.complete(id); }
  async completeProjectionWithReceipt(id: number, operationKey: string, status: 'succeeded' | 'failed', attempts: number, detail: unknown): Promise<void> {
    this.outbox.completeWithReceipt(id, operationKey, status, attempts, detail, new Date().toISOString());
  }
  async retryProjection(id: number, error: string, nextAttemptAt: Date): Promise<void> { this.outbox.retry(id, error, nextAttemptAt); }
  async retryProjectionWithReceipt(id: number, operationKey: string, error: string, nextAttemptAt: Date, attempts: number, detail: unknown): Promise<void> {
    this.outbox.retryWithReceipt(id, operationKey, error, nextAttemptAt, attempts, detail, new Date().toISOString());
  }
  async deadLetterProjection(id: number, error: string): Promise<void> { this.outbox.deadLetter(id, error); }
  async recordProjectionConflict(id: number, diagnostic: ProjectionConflictDiagnostic): Promise<void> { this.outbox.recordConflict(id, diagnostic); }
  async listProjectionConflicts(): Promise<ProjectionConflictRecord[]> { return this.outbox.listConflicts(); }
  async resolveProjectionConflict(id: number, resolution: ProjectionConflictResolutionRequest): Promise<boolean> { return this.outbox.resolveConflict(id, resolution); }
  async conflictProjectionCount(): Promise<number> { return this.outbox.conflictCount(); }
  async pendingProjectionCount(): Promise<number> { return this.outbox.pendingCount(); }
  async terminalProjectionCount(): Promise<number> { return this.outbox.terminalCount(); }
  async recordProjectionReceipt(operationKey: string, status: 'succeeded' | 'failed', attempts: number, detail: unknown): Promise<void> { this.outbox.recordReceipt(operationKey, status, attempts, detail, new Date().toISOString()); }
  close(): void { this.db.close(); }
}
export { relayStoreDirectory } from './local-job-path.js';
export { relayUnifiedStorePath, resolveUnifiedJobScope, discoverLocalRelayStoreSnapshots } from './relay-store-discovery.js';
export type { LocalRelayStoreSnapshot } from './relay-store-discovery.js';
