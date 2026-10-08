import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import type { AgentRegistration, Job, Plan, Task } from './types.js';
import type { PullRequestState } from './store.js';
import type { ExecutionProcessRecord } from './process-identity.js';
import { observability } from './observability.js';
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
  loadJob(jobId: string): Promise<Job | null>;
  listJobs(): Promise<Job[]>;
  saveJob(job: Job): Promise<void>;
  ingestJobSnapshot(job: Job): Promise<Job>;
  saveJobWithProjection(job: Job, request: ProjectionRequest): Promise<void>;
  loadAgents(): Promise<AgentRegistration[] | null>;
  saveAgents(agents: readonly AgentRegistration[]): Promise<void>;
  saveAgentWithProjection(agent: AgentRegistration, request: ProjectionRequest): Promise<void>;
  loadPullRequestFacts(): Promise<PullRequestFacts | null>;
  savePullRequestFacts(facts: PullRequestFacts): Promise<void>;
  markEventProcessed(eventId: string, stream?: string | null, sequence?: number | null): Promise<boolean>;
  recordExecutionProcess(record: ExecutionProcessRecord): Promise<void>;
  loadExecutionProcess(jobId: string, taskId: string, executionId: string): Promise<ExecutionProcessRecord | null>;
  finishExecutionProcess(jobId: string, taskId: string, executionId: string, at?: string): Promise<void>;
  enqueueProjection(request: ProjectionRequest): Promise<void>;
  claimDueProjections(limit?: number, now?: Date): Promise<ProjectionOutboxItem[]>;
  completeProjection(id: number): Promise<void>;
  retryProjection(id: number, error: string, nextAttemptAt: Date): Promise<void>;
  deadLetterProjection(id: number, error: string): Promise<void>;
  recordProjectionConflict(id: number, diagnostic: ProjectionConflictDiagnostic): Promise<void>;
  listProjectionConflicts(): Promise<ProjectionConflictRecord[]>;
  resolveProjectionConflict(id: number, resolution: ProjectionConflictResolutionRequest): Promise<boolean>;
  conflictProjectionCount(): Promise<number>;
  pendingProjectionCount(): Promise<number>;
  terminalProjectionCount(): Promise<number>;
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
  base.tasks = mergeRecords<Task>(local.tasks, remote.tasks);
  const localPlans = local.plans ?? [];
  const remotePlans = remote.plans ?? [];
  if (localPlans.length > 0 || remotePlans.length > 0) {
    base.plans = mergeRecords<Plan>(localPlans, remotePlans).sort((a, b) => a.round - b.round);
  } else {
    delete base.plans;
  }
  return base;
}

export class SQLiteRelayStore implements RelayStore {
  private readonly db: DatabaseSync;
  private readonly outbox: ProjectionOutbox;

  constructor(readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    this.migrate();
    this.outbox = new ProjectionOutbox(this.db);
    this.outbox.resetProcessing(new Date().toISOString());
  }

  private migrate(): void {
    this.db.exec(`
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
      ${ProjectionOutbox.createTableSql()}
      ${ProjectionOutbox.createIndexSql()}
    `);
    const current = this.db.prepare("SELECT value FROM relay_meta WHERE key='schema_version'").get() as { value?: string } | undefined;
    const version = current?.value ? Number(current.value) : 0;
    if (version > SCHEMA_VERSION) throw new Error(`Relay store schema ${version} is newer than supported ${SCHEMA_VERSION}`);
    if (version < SCHEMA_VERSION) ProjectionOutbox.upgrade(this.db, version);
    this.db.prepare("INSERT INTO relay_meta(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(String(SCHEMA_VERSION));
  }

  async loadJob(jobId: string): Promise<Job | null> {
    const row = this.db.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get(jobId) as { json?: string } | undefined;
    return row?.json ? JSON.parse(row.json) as Job : null;
  }

  async listJobs(): Promise<Job[]> {
    const rows = this.db.prepare('SELECT json FROM job_snapshot ORDER BY job_id').all() as unknown as Array<{ json: string }>;
    return rows.map(row => JSON.parse(row.json) as Job);
  }

  async saveJob(job: Job): Promise<void> {
    this.writeJobSnapshot(job, new Date().toISOString());
  }

  async ingestJobSnapshot(job: Job): Promise<Job> {
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
    this.db.prepare(`
      INSERT INTO job_snapshot(job_id,json,updated_at) VALUES(?,?,?)
      ON CONFLICT(job_id) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at
    `).run(job.id, JSON.stringify(job), now);
  }

  async loadAgents(): Promise<AgentRegistration[] | null> {
    const observed = this.db.prepare("SELECT value FROM relay_meta WHERE key='agent_registry_observed_at'").get() as { value?: string } | undefined;
    if (!observed?.value) return null;
    const rows = this.db.prepare('SELECT json FROM agent_snapshot ORDER BY agent_id').all() as unknown as Array<{ json: string }>;
    return rows.map(row => JSON.parse(row.json) as AgentRegistration);
  }

  async saveAgents(agents: readonly AgentRegistration[]): Promise<void> {
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM agent_snapshot').run();
      const insert = this.db.prepare('INSERT INTO agent_snapshot(agent_id,json,updated_at) VALUES(?,?,?)');
      for (const agent of agents) insert.run(agent.id, JSON.stringify(agent), now);
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
    this.db.prepare(`
      INSERT INTO agent_snapshot(agent_id,json,updated_at) VALUES(?,?,?)
      ON CONFLICT(agent_id) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at
    `).run(agent.id, JSON.stringify(agent), now);
  }

  private markAgentRegistryObserved(now: string): void {
    this.db.prepare(`
      INSERT INTO relay_meta(key,value) VALUES('agent_registry_observed_at',?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `).run(now);
  }

  async loadPullRequestFacts(): Promise<PullRequestFacts | null> {
    const row = this.db.prepare('SELECT state,head_ref,head_sha,observed_at FROM pull_request_facts WHERE id=1').get() as { state?: PullRequestState; head_ref?: string | null; head_sha?: string | null; observed_at?: string } | undefined;
    if (!row?.state || !row.observed_at) return null;
    return { state: row.state, head: row.head_ref && row.head_sha ? { ref: row.head_ref, sha: row.head_sha } : null, observedAt: row.observed_at };
  }

  async savePullRequestFacts(facts: PullRequestFacts): Promise<void> {
    this.db.prepare(`
      INSERT INTO pull_request_facts(id,state,head_ref,head_sha,observed_at) VALUES(1,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET state=excluded.state,head_ref=excluded.head_ref,head_sha=excluded.head_sha,observed_at=excluded.observed_at
    `).run(facts.state, facts.head?.ref ?? null, facts.head?.sha ?? null, facts.observedAt);
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

  async markEventProcessed(eventId: string, stream: string | null = null, sequence: number | null = null): Promise<boolean> {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO event_receipt(event_id,stream,sequence,received_at) VALUES(?,?,?,?)
    `).run(eventId, stream, sequence, new Date().toISOString());
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


  async claimDueProjections(limit = 50, now = new Date()): Promise<ProjectionOutboxItem[]> {
    return this.outbox.claimDue(limit, now);
  }

  async completeProjection(id: number): Promise<void> { this.outbox.complete(id); }

  async retryProjection(id: number, error: string, nextAttemptAt: Date): Promise<void> { this.outbox.retry(id, error, nextAttemptAt); }

  async deadLetterProjection(id: number, error: string): Promise<void> { this.outbox.deadLetter(id, error); }

  async recordProjectionConflict(id: number, diagnostic: ProjectionConflictDiagnostic): Promise<void> { this.outbox.recordConflict(id, diagnostic); }

  async listProjectionConflicts(): Promise<ProjectionConflictRecord[]> { return this.outbox.listConflicts(); }

  async resolveProjectionConflict(id: number, resolution: ProjectionConflictResolutionRequest): Promise<boolean> { return this.outbox.resolveConflict(id, resolution); }

  async conflictProjectionCount(): Promise<number> { return this.outbox.conflictCount(); }

  async pendingProjectionCount(): Promise<number> { return this.outbox.pendingCount(); }

  async terminalProjectionCount(): Promise<number> { return this.outbox.terminalCount(); }

  close(): void { this.db.close(); }
}

/** Canonical on-disk Relay Store location for one managed GitHub pull request. */
export function relayStorePath(directory: string, repository: string, prNumber: number): string {
  return directory + '/' + `${repository.replace('/', '_')}-${prNumber}.db`;
}

export type LocalRelayStoreSnapshot = { path: string; jobs: Job[]; facts: PullRequestFacts | null };

export async function discoverLocalRelayStoreSnapshots(directory: string): Promise<LocalRelayStoreSnapshot[]> {
  let names: string[];
  try { names = await readdir(directory); } catch { return []; }
  const snapshots: LocalRelayStoreSnapshot[] = [];
  for (const name of names.filter(item => item.endsWith('.db')).sort()) {
    const path = directory + '/' + name;
    let store: SQLiteRelayStore | undefined;
    try {
      store = new SQLiteRelayStore(path);
      snapshots.push({ path, jobs: await store.listJobs(), facts: await store.loadPullRequestFacts() });
    } catch {
      // Ignore unrelated/corrupt files so one bad file cannot block daemon startup.
    } finally {
      store?.close();
    }
  }
  return snapshots;
}
