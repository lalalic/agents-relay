import type { DatabaseSync } from 'node:sqlite';
import { hostInvocationTablesSql } from './host-invocation-store.js';

/** Bootstrap the single authoritative Relay SQLite schema. */
export function migrateUnifiedRelaySchema(db: DatabaseSync): void {
  db.exec(`
      CREATE TABLE IF NOT EXISTS source_registry (job_id TEXT PRIMARY KEY, source_file TEXT NOT NULL UNIQUE, repository TEXT NOT NULL, pr_number INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS source_registry_repo_pr ON source_registry(repository,pr_number);
      CREATE TABLE IF NOT EXISTS migration_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS relay_meta (scope_job_id TEXT NOT NULL REFERENCES source_registry(job_id), key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(scope_job_id,key));
      CREATE TABLE IF NOT EXISTS job_snapshot (job_id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS job_snapshot_updated ON job_snapshot(updated_at);
      CREATE TABLE IF NOT EXISTS pull_request_facts (scope_job_id TEXT NOT NULL REFERENCES source_registry(job_id), id INTEGER NOT NULL CHECK(id=1), state TEXT NOT NULL CHECK(state IN ('OPEN','MERGED','CLOSED')), head_ref TEXT, head_sha TEXT, observed_at TEXT NOT NULL, PRIMARY KEY(scope_job_id,id));
      CREATE TABLE IF NOT EXISTS publication_state (job_id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS publication_delivery (job_id TEXT NOT NULL, delivery_id TEXT NOT NULL, type TEXT NOT NULL, json TEXT NOT NULL, observed_at TEXT NOT NULL, PRIMARY KEY(job_id,delivery_id));
      CREATE TABLE IF NOT EXISTS agent_snapshot (scope_job_id TEXT NOT NULL REFERENCES source_registry(job_id), agent_id TEXT NOT NULL, json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(scope_job_id,agent_id));
      CREATE TABLE IF NOT EXISTS event_receipt (scope_job_id TEXT NOT NULL REFERENCES source_registry(job_id), event_id TEXT NOT NULL, stream TEXT, sequence INTEGER, received_at TEXT NOT NULL, PRIMARY KEY(scope_job_id,event_id));
      CREATE TABLE IF NOT EXISTS execution_process (job_id TEXT NOT NULL, task_id TEXT NOT NULL, execution_id TEXT NOT NULL, lease_owner TEXT NOT NULL, host TEXT NOT NULL, pid INTEGER NOT NULL, pgid INTEGER NOT NULL, start_token TEXT NOT NULL, observed_at TEXT NOT NULL, ended_at TEXT, PRIMARY KEY(job_id,task_id,execution_id));
      ${hostInvocationTablesSql}
      CREATE TABLE IF NOT EXISTS projection_outbox (scope_job_id TEXT NOT NULL REFERENCES source_registry(job_id), id INTEGER NOT NULL, idempotency_key TEXT NOT NULL, operation_key TEXT, coalesce_key TEXT, operation TEXT NOT NULL, payload_json TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','conflict','dead')), attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, conflict_definition_json TEXT, conflict_evidence_json TEXT, conflict_detected_at TEXT, conflict_disposition TEXT, conflict_resolution_json TEXT, PRIMARY KEY(scope_job_id,id), UNIQUE(scope_job_id,idempotency_key));
      CREATE INDEX IF NOT EXISTS projection_unified_due ON projection_outbox(scope_job_id,status,next_attempt_at,priority DESC,id);
      CREATE INDEX IF NOT EXISTS projection_unified_coalesce ON projection_outbox(scope_job_id,coalesce_key,status);
      CREATE TABLE IF NOT EXISTS projection_receipt (scope_job_id TEXT NOT NULL REFERENCES source_registry(job_id), operation_key TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('succeeded','failed')), attempts INTEGER NOT NULL, detail_json TEXT, recorded_at TEXT NOT NULL, PRIMARY KEY(scope_job_id,operation_key));
      CREATE TABLE IF NOT EXISTS sequences (repository TEXT NOT NULL, kind TEXT NOT NULL, value INTEGER NOT NULL, PRIMARY KEY(repository,kind));
      CREATE TABLE IF NOT EXISTS idempotency (repository TEXT NOT NULL, kind TEXT NOT NULL, request_key TEXT NOT NULL, entity_id TEXT NOT NULL, PRIMARY KEY(repository,kind,request_key));
      INSERT INTO migration_metadata(key,value) VALUES('schema','single-sqlite-staging-v1'),('job_count','0');
    `);}
