import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { AgentRegistration, Job, Plan, Task } from './types.js';
import type { PullRequestState } from './store.js';

export type PullRequestFacts = {
  state: PullRequestState;
  head: { ref: string; sha: string } | null;
  observedAt: string;
};

export type ProjectionOperation =
  | 'save_job'
  | 'append_plan'
  | 'save_plan'
  | 'append_task'
  | 'save_task'
  | 'save_agent'
  | 'update_pr_body'
  | 'merge_pull_request'
  | 'close_pull_request';

export type ProjectionRequest = {
  idempotencyKey: string;
  coalesceKey?: string;
  operation: ProjectionOperation;
  payload: unknown;
  priority?: number;
};

export type ProjectionOutboxItem = {
  id: number;
  idempotencyKey: string;
  coalesceKey: string | null;
  operation: ProjectionOperation;
  payload: unknown;
  priority: number;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export interface RelayStore {
  loadJob(jobId: string): Promise<Job | null>;
  saveJob(job: Job): Promise<void>;
  ingestJobSnapshot(job: Job): Promise<Job>;
  saveJobWithProjection(job: Job, request: ProjectionRequest): Promise<void>;
  loadAgents(): Promise<AgentRegistration[] | null>;
  saveAgents(agents: readonly AgentRegistration[]): Promise<void>;
  saveAgentWithProjection(agent: AgentRegistration, request: ProjectionRequest): Promise<void>;
  loadPullRequestFacts(): Promise<PullRequestFacts | null>;
  savePullRequestFacts(facts: PullRequestFacts): Promise<void>;
  markEventProcessed(eventId: string, stream?: string | null, sequence?: number | null): Promise<boolean>;
  enqueueProjection(request: ProjectionRequest): Promise<void>;
  claimDueProjections(limit?: number, now?: Date): Promise<ProjectionOutboxItem[]>;
  completeProjection(id: number): Promise<void>;
  retryProjection(id: number, error: string, nextAttemptAt: Date): Promise<void>;
  pendingProjectionCount(): Promise<number>;
  close(): void;
}

type OutboxRow = {
  id: number;
  idempotency_key: string;
  coalesce_key: string | null;
  operation: string;
  payload_json: string;
  priority: number;
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

const SCHEMA_VERSION = 3;

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

function rowToProjection(row: OutboxRow): ProjectionOutboxItem {
  return {
    id: Number(row.id),
    idempotencyKey: row.idempotency_key,
    coalesceKey: row.coalesce_key,
    operation: row.operation as ProjectionOperation,
    payload: JSON.parse(row.payload_json) as unknown,
    priority: Number(row.priority),
    attempts: Number(row.attempts),
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SQLiteRelayStore implements RelayStore {
  private readonly db: DatabaseSync;

  constructor(readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    this.migrate();
    this.db.prepare("UPDATE projection_outbox SET status='pending', updated_at=? WHERE status='processing'")
      .run(new Date().toISOString());
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
      CREATE TABLE IF NOT EXISTS projection_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT NOT NULL UNIQUE,
        coalesce_key TEXT,
        operation TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS projection_due_idx
        ON projection_outbox(status, next_attempt_at, priority DESC, id);
      CREATE INDEX IF NOT EXISTS projection_coalesce_idx
        ON projection_outbox(coalesce_key, status);
    `);
    const current = this.db.prepare("SELECT value FROM relay_meta WHERE key='schema_version'").get() as { value?: string } | undefined;
    const version = current?.value ? Number(current.value) : 0;
    if (version > SCHEMA_VERSION) throw new Error(`Relay store schema ${version} is newer than supported ${SCHEMA_VERSION}`);
    this.db.prepare("INSERT INTO relay_meta(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(String(SCHEMA_VERSION));
  }

  async loadJob(jobId: string): Promise<Job | null> {
    const row = this.db.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get(jobId) as { json?: string } | undefined;
    return row?.json ? JSON.parse(row.json) as Job : null;
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
      this.enqueueProjectionInTransaction(request, now);
      this.db.exec('COMMIT');
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

  async markEventProcessed(eventId: string, stream: string | null = null, sequence: number | null = null): Promise<boolean> {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO event_receipt(event_id,stream,sequence,received_at) VALUES(?,?,?,?)
    `).run(eventId, stream, sequence, new Date().toISOString());
    return Number(result.changes) === 1;
  }

  async enqueueProjection(request: ProjectionRequest): Promise<void> {
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.enqueueProjectionInTransaction(request, now);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private enqueueProjectionInTransaction(request: ProjectionRequest, now: string): void {
    if (request.coalesceKey) {
      this.db.prepare(`
        DELETE FROM projection_outbox
        WHERE coalesce_key=? AND status='pending' AND idempotency_key<>?
      `).run(request.coalesceKey, request.idempotencyKey);
    }
    const existing = this.db.prepare('SELECT status FROM projection_outbox WHERE idempotency_key=?').get(request.idempotencyKey) as { status?: string } | undefined;
    // A writer may be applying this key outside the transaction. Never rewrite its
    // payload: its completion must only remove its own row, not a newer mutation.
    const nextId = Number((this.db.prepare('SELECT COALESCE(MAX(id),0)+1 AS next_id FROM projection_outbox').get() as { next_id?: number | bigint }).next_id ?? 1);
    const idempotencyKey = existing?.status === 'processing'
      ? `${request.idempotencyKey}:queued:${nextId}`
      : request.idempotencyKey;
    this.db.prepare(`
      INSERT INTO projection_outbox(
        idempotency_key,coalesce_key,operation,payload_json,priority,status,
        attempts,next_attempt_at,last_error,created_at,updated_at
      ) VALUES(?,?,?,?,?,'pending',0,NULL,NULL,?,?)
      ON CONFLICT(idempotency_key) DO UPDATE SET
        coalesce_key=excluded.coalesce_key,
        operation=excluded.operation,
        payload_json=excluded.payload_json,
        priority=MAX(projection_outbox.priority,excluded.priority),
        status='pending',
        next_attempt_at=NULL,
        last_error=NULL,
        updated_at=excluded.updated_at
    `).run(
      idempotencyKey,
      request.coalesceKey ?? null,
      request.operation,
      JSON.stringify(request.payload),
      request.priority ?? 0,
      now,
      now,
    );
  }

  async claimDueProjections(limit = 50, now = new Date()): Promise<ProjectionOutboxItem[]> {
    const observedAt = now.toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.db.prepare(`
        SELECT id,idempotency_key,coalesce_key,operation,payload_json,priority,
               attempts,next_attempt_at,last_error,created_at,updated_at
        FROM projection_outbox
        WHERE status='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?)
        ORDER BY priority DESC, id ASC
        LIMIT ?
      `).all(observedAt, Math.max(1, Math.floor(limit))) as unknown as OutboxRow[];
      const mark = this.db.prepare("UPDATE projection_outbox SET status='processing', updated_at=? WHERE id=? AND status='pending'");
      const claimed: OutboxRow[] = [];
      for (const row of rows) {
        const result = mark.run(observedAt, row.id);
        if (Number(result.changes) === 1) claimed.push({ ...row, updated_at: observedAt });
      }
      this.db.exec('COMMIT');
      return claimed.map(rowToProjection);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async completeProjection(id: number): Promise<void> {
    this.db.prepare('DELETE FROM projection_outbox WHERE id=?').run(id);
  }

  async retryProjection(id: number, error: string, nextAttemptAt: Date): Promise<void> {
    this.db.prepare(`
      UPDATE projection_outbox
      SET status='pending', attempts=attempts+1, next_attempt_at=?, last_error=?, updated_at=?
      WHERE id=?
    `).run(nextAttemptAt.toISOString(), error, new Date().toISOString(), id);
  }

  async pendingProjectionCount(): Promise<number> {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM projection_outbox').get() as { count?: number | bigint } | undefined;
    return Number(row?.count ?? 0);
  }

  close(): void { this.db.close(); }
}
