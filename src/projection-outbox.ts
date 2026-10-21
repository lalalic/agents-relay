import type { DatabaseSync } from 'node:sqlite';

export type ProjectionOperation =
  | 'save_job'
  | 'append_plan'
  | 'save_plan'
  | 'append_task'
  | 'save_task'
  | 'append_task_comment'
  | 'save_agent'
  | 'update_pr_body'
  | 'create_pull_request'
  | 'merge_pull_request'
  | 'close_pull_request';

export type ProjectionStatus = 'pending' | 'processing' | 'conflict' | 'dead';

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
  operationKey: string;
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

/** Structured, durable diagnostic proving one same-id/different-definition projection conflict. */
export type ProjectionConflictDiagnostic = {
  kind: 'task' | 'plan';
  jobId: string;
  subjectId: string;
  operation: ProjectionOperation;
  operationKey: string;
  localDefinition: unknown;
  remoteDefinition: unknown;
  divergingFields: string[];
  detectedAt: string;
  message: string;
};

export type ProjectionConflictResolution = {
  action: 'requeue' | 'discard_local';
  resolvedAt: string;
  note?: string;
};

export type ProjectionConflictResolutionRequest = {
  action: 'requeue' | 'discard_local';
  note?: string;
};

export type ProjectionConflictRecord = {
  id: number;
  status: ProjectionStatus;
  operation: ProjectionOperation;
  operationKey: string;
  attempts: number;
  diagnostic: ProjectionConflictDiagnostic;
  resolution: ProjectionConflictResolution | null;
};

export type OutboxRow = {
  id: number;
  idempotency_key: string;
  operation_key: string | null;
  coalesce_key: string | null;
  operation: string;
  payload_json: string;
  priority: number;
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  status?: string;
  created_at: string;
  updated_at: string;
  conflict_definition_json: string | null;
  conflict_evidence_json: string | null;
  conflict_detected_at: string | null;
  conflict_disposition: string | null;
  conflict_resolution_json: string | null;
};

export type ProjectionOutboxPort = {
  enqueue(request: ProjectionRequest, now: string): boolean;
  claimDue(limit: number, now: Date): ProjectionOutboxItem[];
  complete(id: number): void;
  completeWithReceipt(id: number, operationKey: string, status: 'succeeded' | 'failed', attempts: number, detail: unknown, now: string): void;
  retryWithReceipt(id: number, operationKey: string, error: string, nextAttemptAt: Date, attempts: number, detail: unknown, now: string): void;
  retry(id: number, error: string, nextAttemptAt: Date): void;
  deadLetter(id: number, error: string): void;
  recordConflict(id: number, diagnostic: ProjectionConflictDiagnostic): void;
  listConflicts(): ProjectionConflictRecord[];
  resolveConflict(id: number, resolution: ProjectionConflictResolutionRequest): boolean;
  conflictCount(): number;
  pendingCount(): number;
  terminalCount(): number;
  recordReceipt(operationKey: string, status: 'succeeded' | 'failed', attempts: number, detail: unknown, now: string): void;
};

export const SCHEMA_VERSION = 6;
const UNSAFE_QUEUED_KEY_SUFFIX = /:(?:queued|lost):\d+$/;

/** Logical operation key recovered from a possibly queued/lost idempotency key. */
export function logicalOperationKey(idempotencyKey: string): string {
  return idempotencyKey.replace(UNSAFE_QUEUED_KEY_SUFFIX, '');
}

export function rowToProjection(row: OutboxRow): ProjectionOutboxItem {
  return {
    id: Number(row.id),
    idempotencyKey: row.idempotency_key,
    operationKey: row.operation_key ?? logicalOperationKey(row.idempotency_key),
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

export function rowToConflict(row: OutboxRow): ProjectionConflictRecord {
  const evidence = row.conflict_evidence_json ? JSON.parse(row.conflict_evidence_json) as Record<string, unknown> : {};
  const resolution = row.conflict_resolution_json ? JSON.parse(row.conflict_resolution_json) as ProjectionConflictResolution : null;
  const operationKey = row.operation_key ?? logicalOperationKey(row.idempotency_key);
  return {
    id: Number(row.id),
    status: (row.status ?? 'conflict') as ProjectionStatus,
    operation: row.operation as ProjectionOperation,
    operationKey,
    attempts: Number(row.attempts),
    diagnostic: {
      kind: (evidence.kind as 'task' | 'plan' | undefined) ?? 'task',
      jobId: String(evidence.jobId ?? ''),
      subjectId: String(evidence.subjectId ?? ''),
      operation: row.operation as ProjectionOperation,
      operationKey,
      localDefinition: row.conflict_definition_json ? JSON.parse(row.conflict_definition_json) as unknown : null,
      remoteDefinition: evidence.remoteDefinition ?? null,
      divergingFields: Array.isArray(evidence.divergingFields) ? evidence.divergingFields.map(String) : [],
      detectedAt: row.conflict_detected_at ?? row.updated_at,
      message: String(evidence.message ?? row.last_error ?? 'projection definition conflict'),
    },
    resolution,
  };
}

const OUTBOX_COLUMNS = 'id,idempotency_key,operation_key,coalesce_key,operation,payload_json,priority,status,attempts,next_attempt_at,last_error,created_at,updated_at,conflict_definition_json,conflict_evidence_json,conflict_detected_at,conflict_disposition,conflict_resolution_json';

/**
 * Durable projection outbox persistence.
 *
 * Owns the schema, pending/processing/conflict/dead state machine storage, coalescing,
 * claiming, retry/backoff bookkeeping, deterministic-conflict diagnostics, and explicit repair.
 * It is deliberately independent of Job/Task/Plan semantics: callers persist domain state
 * separately and enqueue one projection request.
 */
export class ProjectionOutbox implements ProjectionOutboxPort {
  constructor(private readonly db: DatabaseSync, private readonly scopeJobId?: string) {}
  private get scopeAnd(): string { return this.scopeJobId ? ' AND scope_job_id=?' : ''; }
  private bind(...params: (string | number | null)[]): (string | number | null)[] {
    return this.scopeJobId ? [...params,this.scopeJobId] : params;
  }

  static createTableSql(table = 'projection_outbox'): string {
    return `CREATE TABLE IF NOT EXISTS ${table} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT NOT NULL UNIQUE,
        operation_key TEXT,
        coalesce_key TEXT,
        operation TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','conflict','dead')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        conflict_definition_json TEXT,
        conflict_evidence_json TEXT,
        conflict_detected_at TEXT,
        conflict_disposition TEXT,
        conflict_resolution_json TEXT
      );`;
  }

  static createIndexSql(): string {
    return `
      CREATE INDEX IF NOT EXISTS projection_due_idx ON projection_outbox(status, next_attempt_at, priority DESC, id);
      CREATE INDEX IF NOT EXISTS projection_coalesce_idx ON projection_outbox(coalesce_key, status);
    `;
  }

  static createReceiptTableSql(): string {
    return `CREATE TABLE IF NOT EXISTS projection_receipt (
      operation_key TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK(status IN ('succeeded','failed')),
      attempts INTEGER NOT NULL,
      detail_json TEXT,
      recorded_at TEXT NOT NULL
    );`;
  }

  /** Rebuild a pre-v5 outbox, backfill logical operation keys, and classify legacy dead conflicts. */
  static upgrade(db: DatabaseSync, previousVersion: number): void {
    const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='projection_outbox'").get() as { sql?: string } | undefined;
    const sql = schema?.sql ?? '';
    const needsRebuild = sql.length > 0 && (!sql.includes("'conflict'") || !sql.includes('operation_key'));
    db.exec('BEGIN IMMEDIATE');
    try {
      if (needsRebuild) {
        db.exec(`
          DROP INDEX IF EXISTS projection_due_idx;
          DROP INDEX IF EXISTS projection_coalesce_idx;
          ALTER TABLE projection_outbox RENAME TO projection_outbox_legacy;
          ${ProjectionOutbox.createTableSql()}
          INSERT INTO projection_outbox(id,idempotency_key,coalesce_key,operation,payload_json,priority,status,attempts,next_attempt_at,last_error,created_at,updated_at)
          SELECT id,idempotency_key,coalesce_key,operation,payload_json,priority,status,attempts,next_attempt_at,last_error,created_at,updated_at FROM projection_outbox_legacy;
          DROP TABLE projection_outbox_legacy;
        `);
      }
      db.exec(ProjectionOutbox.createIndexSql());
      db.prepare(`
        UPDATE projection_outbox
        SET operation_key = CASE
          WHEN operation_key IS NOT NULL AND operation_key<>'' THEN operation_key
          WHEN idempotency_key GLOB '*:queued:*' THEN substr(idempotency_key, 1, instr(idempotency_key, ':queued:') - 1)
          ELSE idempotency_key END
        WHERE operation_key IS NULL OR operation_key=''
      `).run();
      const diagnostics = db.prepare(`
        SELECT id,operation,idempotency_key,last_error,attempts,updated_at FROM projection_outbox
        WHERE status='dead' AND last_error LIKE '%already exists with a different definition%'
      `).all() as unknown as Array<{ id: number; operation: string; last_error: string | null; attempts: number; updated_at: string }>;
      const promote = db.prepare(`
        UPDATE projection_outbox
        SET status='conflict', conflict_detected_at=?, conflict_disposition='classified_on_migration',
            conflict_evidence_json=?, conflict_definition_json=COALESCE(conflict_definition_json, payload_json)
        WHERE id=?
      `);
      for (const row of diagnostics) {
        const evidence = JSON.stringify({ kind: row.operation === 'append_plan' ? 'plan' : 'task', subjectId: '', jobId: '', divergingFields: [], message: row.last_error ?? 'legacy deterministic projection conflict', migratedFromAttempts: Number(row.attempts), recoveredFromSchema: previousVersion });
        promote.run(row.updated_at, evidence, row.id);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  resetProcessing(now: string): void {
    const cutoff = new Date(Date.parse(now) - 120_000).toISOString();
    this.db.prepare(`UPDATE projection_outbox SET status='pending', updated_at=? WHERE status='processing' AND updated_at<=?${this.scopeAnd}`).run(...this.bind(now, cutoff));
  }

  enqueue(request: ProjectionRequest, now: string): boolean {
    const operationKey = logicalOperationKey(request.idempotencyKey);
    let coalesced = false;
    if (request.coalesceKey) {
      const removed = this.db.prepare(`
        DELETE FROM projection_outbox
        WHERE coalesce_key=? AND status='pending' AND operation_key<>?${this.scopeAnd}
      `).run(...this.bind(request.coalesceKey, operationKey));
      coalesced = Number(removed.changes) > 0;
    }
    const existing = this.db.prepare(`SELECT status FROM projection_outbox WHERE operation_key=?${this.scopeAnd} ORDER BY id DESC LIMIT 1`)
      .get(...this.bind(operationKey)) as { status?: string } | undefined;
    // A writer may be applying this key outside the transaction, or a deterministic
    // conflict may already be recorded for it. Never rewrite that row's payload: its
    // completion must only remove its own row, and a recorded conflict must stay the
    // classification evidence until explicitly repaired. New mutations queue beside it.
    const nextId = Number((this.db.prepare(`SELECT COALESCE(MAX(id),0)+1 AS next_id FROM projection_outbox${this.scopeJobId ? ' WHERE scope_job_id=?' : ''}`).get(...(this.scopeJobId ? [this.scopeJobId] : [])) as { next_id?: number | bigint }).next_id ?? 1);
    const collides = existing?.status === 'processing' || existing?.status === 'conflict' || existing?.status === 'dead';
    const idempotencyKey = collides ? `${operationKey}:queued:${nextId}` : operationKey;
    const insertSql = this.scopeJobId ? `
      INSERT INTO projection_outbox(
        scope_job_id,id,idempotency_key,operation_key,coalesce_key,operation,payload_json,priority,status,
        attempts,next_attempt_at,last_error,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,'pending',0,NULL,NULL,?,?)
      ON CONFLICT(scope_job_id,idempotency_key) DO UPDATE SET
        operation_key=excluded.operation_key,
        coalesce_key=excluded.coalesce_key,
        operation=excluded.operation,
        payload_json=excluded.payload_json,
        priority=MAX(projection_outbox.priority,excluded.priority),
        status='pending', next_attempt_at=NULL, last_error=NULL, updated_at=excluded.updated_at
    ` : `
      INSERT INTO projection_outbox(
        idempotency_key,operation_key,coalesce_key,operation,payload_json,priority,status,
        attempts,next_attempt_at,last_error,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,'pending',0,NULL,NULL,?,?)
      ON CONFLICT(idempotency_key) DO UPDATE SET
        operation_key=excluded.operation_key,
        coalesce_key=excluded.coalesce_key,
        operation=excluded.operation,
        payload_json=excluded.payload_json,
        priority=MAX(projection_outbox.priority,excluded.priority),
        status='pending', next_attempt_at=NULL, last_error=NULL, updated_at=excluded.updated_at
    `;
    const params = [idempotencyKey, operationKey, request.coalesceKey ?? null,
      request.operation, JSON.stringify(request.payload), request.priority ?? 0,now,now];
    this.db.prepare(insertSql).run(...(this.scopeJobId ? [this.scopeJobId,nextId,...params] : params));
    return coalesced;
  }

  claimDue(limit: number, now: Date): ProjectionOutboxItem[] {
    const observedAt = now.toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.resetProcessing(observedAt); // Reclaim only stale claims; recover on each retry tick, not only on process restart.
      const rows = this.db.prepare(`
        SELECT ${OUTBOX_COLUMNS}
        FROM projection_outbox
        WHERE status='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?)${this.scopeAnd}
        ORDER BY priority DESC, id ASC
        LIMIT ?
      `).all(observedAt, ...(this.scopeJobId ? [this.scopeJobId] : []), Math.max(1, Math.floor(limit))) as unknown as OutboxRow[];
      const mark = this.db.prepare(`UPDATE projection_outbox SET status='processing', updated_at=? WHERE id=? AND status='pending'${this.scopeAnd}`);
      const claimed: OutboxRow[] = [];
      for (const row of rows) {
        const result = mark.run(...this.bind(observedAt, row.id));
        if (Number(result.changes) === 1) claimed.push({ ...row, updated_at: observedAt });
      }
      this.db.exec('COMMIT');
      return claimed.map(rowToProjection);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  complete(id: number): void {
    this.db.prepare(`DELETE FROM projection_outbox WHERE id=?${this.scopeAnd}`).run(...this.bind(id));
  }

  completeWithReceipt(id: number, operationKey: string, status: 'succeeded' | 'failed', attempts: number, detail: unknown, now: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.recordReceipt(operationKey, status, attempts, detail, now);
      this.db.prepare(`DELETE FROM projection_outbox WHERE id=?${this.scopeAnd}`).run(...this.bind(id));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  retryWithReceipt(id: number, operationKey: string, error: string, nextAttemptAt: Date, attempts: number, detail: unknown, now: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`UPDATE projection_outbox
        SET status='pending', attempts=?, next_attempt_at=?, last_error=?, updated_at=? WHERE id=?${this.scopeAnd}`)
        .run(...this.bind(attempts, nextAttemptAt.toISOString(), error, now, id));
      this.recordReceipt(operationKey, 'failed', attempts, detail, now);
      this.db.exec('COMMIT');
    } catch (caught) {
      this.db.exec('ROLLBACK');
      throw caught;
    }
  }

  retry(id: number, error: string, nextAttemptAt: Date): void {
    this.db.prepare(`
      UPDATE projection_outbox
      SET status='pending', attempts=attempts+1, next_attempt_at=?, last_error=?, updated_at=?
      WHERE id=?${this.scopeAnd}
    `).run(...this.bind(nextAttemptAt.toISOString(), error, new Date().toISOString(), id));
  }

  deadLetter(id: number, error: string): void {
    this.db.prepare(`
      UPDATE projection_outbox
      SET status='dead', attempts=attempts+1, next_attempt_at=NULL, last_error=?, updated_at=?
      WHERE id=?${this.scopeAnd}
    `).run(...this.bind(error, new Date().toISOString(), id));
  }

  recordReceipt(operationKey: string, status: 'succeeded' | 'failed', attempts: number, detail: unknown, now: string): void {
    if (this.scopeJobId) {
      this.db.prepare(`INSERT INTO projection_receipt(scope_job_id,operation_key,status,attempts,detail_json,recorded_at)
        VALUES(?,?,?,?,?,?) ON CONFLICT(scope_job_id,operation_key) DO UPDATE SET status=excluded.status, attempts=excluded.attempts,
        detail_json=excluded.detail_json, recorded_at=excluded.recorded_at`).run(this.scopeJobId, operationKey, status, attempts, JSON.stringify(detail ?? null), now);
    } else {
      this.db.prepare(`INSERT INTO projection_receipt(operation_key,status,attempts,detail_json,recorded_at)
        VALUES(?,?,?,?,?) ON CONFLICT(operation_key) DO UPDATE SET status=excluded.status, attempts=excluded.attempts,
        detail_json=excluded.detail_json, recorded_at=excluded.recorded_at`).run(operationKey, status, attempts, JSON.stringify(detail ?? null), now);
    }
  }

  recordConflict(id: number, diagnostic: ProjectionConflictDiagnostic): void {
    const evidence = JSON.stringify({
      kind: diagnostic.kind,
      jobId: diagnostic.jobId,
      subjectId: diagnostic.subjectId,
      remoteDefinition: diagnostic.remoteDefinition,
      divergingFields: diagnostic.divergingFields,
      message: diagnostic.message,
    });
    this.db.prepare(`
      UPDATE projection_outbox
      SET status='conflict', attempts=attempts+1, next_attempt_at=NULL, last_error=?,
          conflict_definition_json=?, conflict_evidence_json=?, conflict_detected_at=?,
          conflict_disposition='awaiting_repair', conflict_resolution_json=NULL, updated_at=?
      WHERE id=? AND status NOT IN ('conflict','dead')${this.scopeAnd}
    `).run(...this.bind(diagnostic.message, JSON.stringify(diagnostic.localDefinition), evidence, diagnostic.detectedAt, diagnostic.detectedAt, id));
  }

  listConflicts(): ProjectionConflictRecord[] {
    const rows = this.db.prepare(`
      SELECT ${OUTBOX_COLUMNS} FROM projection_outbox WHERE status='conflict'${this.scopeAnd} ORDER BY id ASC
    `).all(...(this.scopeJobId ? [this.scopeJobId] : [])) as unknown as OutboxRow[];
    return rows.map(rowToConflict);
  }

  /** Explicit repair: requeue the original projection, or discard the blocked local mutation for a fresh one. */
  resolveConflict(id: number, resolution: ProjectionConflictResolutionRequest): boolean {
    const now = new Date().toISOString();
    const record = this.db.prepare(`SELECT status FROM projection_outbox WHERE id=?${this.scopeAnd}`).get(...this.bind(id)) as { status?: string } | undefined;
    if (!record || record.status !== 'conflict') return false;
    const resolutionJson = JSON.stringify({ action: resolution.action, resolvedAt: now, ...(resolution.note ? { note: resolution.note } : {}) });
    if (resolution.action === 'requeue') {
      this.db.prepare(`
        UPDATE projection_outbox
        SET status='pending', attempts=0, next_attempt_at=NULL, conflict_disposition='requeued',
            conflict_resolution_json=?, updated_at=?
        WHERE id=? AND status='conflict'${this.scopeAnd}
      `).run(...this.bind(resolutionJson, now, id));
    } else {
      this.db.prepare(`DELETE FROM projection_outbox WHERE id=? AND status=?${this.scopeAnd}`).run(...this.bind(id, 'conflict'));
    }
    return true;
  }

  conflictCount(): number { return this.count("status='conflict'"); }
  pendingCount(): number { return this.count("status IN ('pending','processing')"); }
  terminalCount(): number { return this.count("status='dead'"); }

  private count(where: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM projection_outbox WHERE ${where}${this.scopeAnd}`).get(...(this.scopeJobId ? [this.scopeJobId] : [])) as { count?: number | bigint } | undefined;
    return Number(row?.count ?? 0);
  }
}
