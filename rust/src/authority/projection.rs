//! Relay's pre-existing projection_outbox SQL contract. No network side
//! effects occur here. Claiming is not proof that GitHub operations succeeded.
use super::RelayAuthority;
use chrono::{DateTime, Duration};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectionRequest {
    pub idempotency_key: String,
    pub coalesce_key: Option<String>,
    pub operation: String,
    pub payload: Value,
    pub priority: i64,
}
pub struct ProjectionRetry<'a> {
    pub next_attempt_at: &'a str,
    pub attempts: i64,
    pub detail: &'a Value,
    pub at: &'a str,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectionItem {
    pub id: i64,
    pub idempotency_key: String,
    pub operation_key: String,
    pub coalesce_key: Option<String>,
    pub operation: String,
    pub payload: Value,
    pub priority: i64,
    pub attempts: i64,
    pub next_attempt_at: Option<String>,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}
const LEGACY_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS projection_outbox(
 id INTEGER PRIMARY KEY AUTOINCREMENT,idempotency_key TEXT NOT NULL UNIQUE,
 operation_key TEXT,coalesce_key TEXT,operation TEXT NOT NULL,payload_json TEXT NOT NULL,
 priority INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','conflict','dead')),
 attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at TEXT,last_error TEXT,
 created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 conflict_definition_json TEXT,conflict_evidence_json TEXT,conflict_detected_at TEXT,
 conflict_disposition TEXT,conflict_resolution_json TEXT
);
CREATE TABLE IF NOT EXISTS projection_receipt (
 operation_key TEXT PRIMARY KEY,status TEXT NOT NULL CHECK(status IN ('succeeded','failed')),
 attempts INTEGER NOT NULL,detail_json TEXT,recorded_at TEXT NOT NULL
);"#;

#[derive(Clone)]
struct Scope {
    job_id: Option<String>,
}
impl Scope {
    fn from_conn(conn: &rusqlite::Connection, scope: Option<&str>) -> Result<Self, String> {
        let exists:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='projection_outbox')",[],|r|r.get(0)).map_err(|e|e.to_string())?;
        if !exists {
            return Err("projection_outbox missing; bootstrap with native Relay schema".into());
        }
        let mut stmt = conn
            .prepare("PRAGMA table_info('projection_outbox')")
            .map_err(|e| e.to_string())?;
        let names = stmt
            .query_map([], |r| r.get::<_, String>(1))
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        let unified = names.iter().any(|c| c == "scope_job_id");
        if unified && scope.is_none() {
            return Err("unified outbox requires explicit Job scope".into());
        }
        if !unified && scope.is_some() {
            return Err("unscoped outbox rejects Job scope".into());
        }
        if let Some(id) = scope {
            let found: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM source_registry WHERE job_id=?1)",
                    [id],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            if !found {
                return Err("unknown unified Job scope".into());
            }
        }
        Ok(Self {
            job_id: scope.map(str::to_owned),
        })
    }
}
fn logical_operation_key(key: &str) -> &str {
    for part in [":queued:", ":lost:"] {
        if let Some((base, suffix)) = key.rsplit_once(part) {
            if !suffix.is_empty() && suffix.bytes().all(|b| b.is_ascii_digit()) {
                return base;
            }
        }
    }
    key
}
fn to_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProjectionItem> {
    let json: String = row.get(5)?;
    let payload: Value = serde_json::from_str(&json).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(5, rusqlite::types::Type::Text, Box::new(e))
    })?;
    let idempotency_key: String = row.get(1)?;
    let operation_key: Option<String> = row.get(2)?;
    Ok(ProjectionItem {
        id: row.get(0)?,
        idempotency_key: idempotency_key.clone(),
        operation_key: operation_key
            .unwrap_or_else(|| logical_operation_key(&idempotency_key).to_string()),
        coalesce_key: row.get(3)?,
        operation: row.get(4)?,
        payload,
        priority: row.get(6)?,
        attempts: row.get(7)?,
        next_attempt_at: row.get(8)?,
        last_error: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}
const FIELDS:&str="id,idempotency_key,operation_key,coalesce_key,operation,payload_json,priority,attempts,next_attempt_at,last_error,created_at,updated_at";

impl RelayAuthority {
    fn projection_scope(&self, scope: Option<&str>) -> Result<Scope, String> {
        Scope::from_conn(&self.connection, scope)
    }
    /// Legacy fixtures can create the pre-unified outbox. Production unified
    /// stores already own and migrate their schema; Rust never second-guesses.
    pub fn prepare_legacy_projection(&mut self) -> Result<(), String> {
        let unified:bool=self.connection.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_registry')",[],|r|r.get(0)).map_err(|e|e.to_string())?;
        if unified {
            return Err("cannot create a legacy projection table in a unified Relay store".into());
        }
        self.connection
            .execute_batch(LEGACY_SCHEMA)
            .map_err(|e| e.to_string())
    }
    pub fn enqueue_projection(
        &mut self,
        scope: Option<&str>,
        req: &ProjectionRequest,
        at: &str,
    ) -> Result<bool, String> {
        if req.idempotency_key.is_empty() || req.operation.is_empty() {
            return Err("invalid projection identity".into());
        }
        if !matches!(
            req.operation.as_str(),
            "save_job"
                | "append_plan"
                | "save_plan"
                | "append_task"
                | "save_task"
                | "append_task_comment"
                | "save_agent"
                | "update_pr_body"
                | "create_pull_request"
                | "merge_pull_request"
                | "close_pull_request"
        ) {
            return Err("unsupported projection operation".into());
        }
        let scope = self.projection_scope(scope)?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let operation_key = logical_operation_key(&req.idempotency_key);
        let mut coalesced = false;
        if let Some(coalesce) = &req.coalesce_key {
            let count=if let Some(job)=&scope.job_id {
                tx.execute("DELETE FROM projection_outbox WHERE coalesce_key=?1 AND status='pending' AND operation_key<>?2 AND scope_job_id=?3",params![coalesce,operation_key,job])
            } else {
                tx.execute("DELETE FROM projection_outbox WHERE coalesce_key=?1 AND status='pending' AND operation_key<>?2",params![coalesce,operation_key])
            }.map_err(|e|e.to_string())?;
            coalesced = count > 0;
        }
        let existing:Option<String>=if let Some(job)=&scope.job_id {
            tx.query_row("SELECT status FROM projection_outbox WHERE operation_key=?1 AND scope_job_id=?2 ORDER BY id DESC LIMIT 1",params![operation_key,job],|r|r.get(0))
        } else {
            tx.query_row("SELECT status FROM projection_outbox WHERE operation_key=?1 ORDER BY id DESC LIMIT 1",[operation_key],|r|r.get(0))
        }.optional().map_err(|e|e.to_string())?;
        let next_id: i64 = if let Some(job) = &scope.job_id {
            tx.query_row(
                "SELECT COALESCE(MAX(id),0)+1 FROM projection_outbox WHERE scope_job_id=?1",
                [job],
                |r| r.get(0),
            )
        } else {
            tx.query_row(
                "SELECT COALESCE(MAX(id),0)+1 FROM projection_outbox",
                [],
                |r| r.get(0),
            )
        }
        .map_err(|e| e.to_string())?;
        let collides = matches!(
            existing.as_deref(),
            Some("processing" | "conflict" | "dead")
        );
        let key = if collides {
            format!("{operation_key}:queued:{next_id}")
        } else {
            operation_key.to_owned()
        };
        let json = serde_json::to_string(&req.payload).map_err(|e| e.to_string())?;
        if let Some(job)=&scope.job_id {
            tx.execute("INSERT INTO projection_outbox(scope_job_id,id,idempotency_key,operation_key,coalesce_key,operation,payload_json,priority,status,attempts,next_attempt_at,last_error,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'pending',0,NULL,NULL,?9,?10) ON CONFLICT(scope_job_id,idempotency_key) DO UPDATE SET operation_key=excluded.operation_key,coalesce_key=excluded.coalesce_key,operation=excluded.operation,payload_json=excluded.payload_json,priority=MAX(projection_outbox.priority,excluded.priority),status='pending',next_attempt_at=NULL,last_error=NULL,updated_at=excluded.updated_at",
                params![job,next_id,key,operation_key,req.coalesce_key,req.operation,json,req.priority,at,at])
        } else {
            tx.execute("INSERT INTO projection_outbox(idempotency_key,operation_key,coalesce_key,operation,payload_json,priority,status,attempts,next_attempt_at,last_error,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,'pending',0,NULL,NULL,?7,?8) ON CONFLICT(idempotency_key) DO UPDATE SET operation_key=excluded.operation_key,coalesce_key=excluded.coalesce_key,operation=excluded.operation,payload_json=excluded.payload_json,priority=MAX(projection_outbox.priority,excluded.priority),status='pending',next_attempt_at=NULL,last_error=NULL,updated_at=excluded.updated_at",
                params![key,operation_key,req.coalesce_key,req.operation,json,req.priority,at,at])
        }.map_err(|e|e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(coalesced)
    }
    /// Reclaim a claim only after its 120s retry window; transactionally mark
    /// all due rows before returning them to the caller/provider.
    pub fn claim_projections(
        &mut self,
        scope: Option<&str>,
        limit: u32,
        at: &str,
    ) -> Result<Vec<ProjectionItem>, String> {
        let scope = self.projection_scope(scope)?;
        let parsed = DateTime::parse_from_rfc3339(at).map_err(|_| "invalid claim timestamp")?;
        let cutoff =
            (parsed - Duration::seconds(120)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        if let Some(job) = &scope.job_id {
            tx.execute("UPDATE projection_outbox SET status='pending',updated_at=?1 WHERE status='processing' AND updated_at<=?2 AND scope_job_id=?3",
                params![at,cutoff,job]).map_err(|e|e.to_string())?;
        } else {
            tx.execute("UPDATE projection_outbox SET status='pending',updated_at=?1 WHERE status='processing' AND updated_at<=?2",
                params![at,cutoff]).map_err(|e|e.to_string())?;
        }
        let sql=format!("SELECT {FIELDS} FROM projection_outbox WHERE status='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?1){} ORDER BY priority DESC,id ASC LIMIT ?{}",
            if scope.job_id.is_some(){" AND scope_job_id=?2"}else{""},
            if scope.job_id.is_some(){"3"}else{"2"});
        let rows = {
            let mut statement = tx.prepare(&sql).map_err(|e| e.to_string())?;
            let mut cursor = if let Some(job) = &scope.job_id {
                statement.query_map(params![at, job, limit.max(1)], to_item)
            } else {
                statement.query_map(params![at, limit.max(1)], to_item)
            }
            .map_err(|e| e.to_string())?;
            let mut results = Vec::new();
            for row in &mut cursor {
                results.push(row.map_err(|e| e.to_string())?);
            }
            results
        };
        let mut claimed = Vec::new();
        for mut item in rows {
            let count=if let Some(job)=&scope.job_id {
                tx.execute("UPDATE projection_outbox SET status='processing',updated_at=?1 WHERE id=?2 AND status='pending' AND scope_job_id=?3",
                    params![at,item.id,job])
            } else {
                tx.execute("UPDATE projection_outbox SET status='processing',updated_at=?1 WHERE id=?2 AND status='pending'",
                    params![at,item.id])
            }.map_err(|e|e.to_string())?;
            if count == 1 {
                item.updated_at = at.into();
                claimed.push(item);
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(claimed)
    }
    pub fn complete_projection_with_receipt(
        &mut self,
        scope: Option<&str>,
        item: &ProjectionItem,
        success: bool,
        attempts: i64,
        detail: &Value,
        at: &str,
    ) -> Result<(), String> {
        let scope = self.projection_scope(scope)?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let status = if success { "succeeded" } else { "failed" };
        let json = serde_json::to_string(detail).map_err(|e| e.to_string())?;
        // Exact claim generation fence: a stale caller must not overwrite a
        // newer worker's receipt after the 120-second reclaim window.
        let deleted=if let Some(job)=&scope.job_id {
            tx.execute("DELETE FROM projection_outbox WHERE id=?1 AND scope_job_id=?2 AND status='processing' AND operation_key=?3 AND updated_at=?4",
                params![item.id,job,item.operation_key,item.updated_at])
        } else {
            tx.execute("DELETE FROM projection_outbox WHERE id=?1 AND status='processing' AND operation_key=?2 AND updated_at=?3",
                params![item.id,item.operation_key,item.updated_at])
        }.map_err(|e|e.to_string())?;
        if deleted != 1 {
            return Err("stale or mismatched projection claim".into());
        }
        if let Some(job) = &scope.job_id {
            tx.execute("INSERT INTO projection_receipt(scope_job_id,operation_key,status,attempts,detail_json,recorded_at) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(scope_job_id,operation_key) DO UPDATE SET status=excluded.status,attempts=excluded.attempts,detail_json=excluded.detail_json,recorded_at=excluded.recorded_at",
                params![job,item.operation_key,status,attempts,json,at]).map_err(|e|e.to_string())?;
        } else {
            tx.execute("INSERT INTO projection_receipt(operation_key,status,attempts,detail_json,recorded_at) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(operation_key) DO UPDATE SET status=excluded.status,attempts=excluded.attempts,detail_json=excluded.detail_json,recorded_at=excluded.recorded_at",
                params![item.operation_key,status,attempts,json,at]).map_err(|e|e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn retry_projection_with_receipt(
        &mut self,
        scope: Option<&str>,
        item: &ProjectionItem,
        reason: &str,
        update: ProjectionRetry<'_>,
    ) -> Result<(), String> {
        let ProjectionRetry {
            next_attempt_at: next_at,
            attempts,
            detail,
            at,
        } = update;
        let scope = self.projection_scope(scope)?;
        DateTime::parse_from_rfc3339(next_at).map_err(|_| "invalid retry timestamp")?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let count=if let Some(job)=&scope.job_id {
            tx.execute("UPDATE projection_outbox SET status='pending',attempts=?1,next_attempt_at=?2,last_error=?3,updated_at=?4 WHERE id=?5 AND scope_job_id=?6 AND status='processing' AND operation_key=?7 AND updated_at=?8",
                params![attempts,next_at,reason,at,item.id,job,item.operation_key,item.updated_at])
        } else {
            tx.execute("UPDATE projection_outbox SET status='pending',attempts=?1,next_attempt_at=?2,last_error=?3,updated_at=?4 WHERE id=?5 AND status='processing' AND operation_key=?6 AND updated_at=?7",
                params![attempts,next_at,reason,at,item.id,item.operation_key,item.updated_at])
        }.map_err(|e|e.to_string())?;
        if count != 1 {
            return Err("stale or mismatched projection claim".into());
        }
        let json = serde_json::to_string(detail).map_err(|e| e.to_string())?;
        if let Some(job) = &scope.job_id {
            tx.execute("INSERT INTO projection_receipt(scope_job_id,operation_key,status,attempts,detail_json,recorded_at) VALUES(?1,?2,'failed',?3,?4,?5) ON CONFLICT(scope_job_id,operation_key) DO UPDATE SET status=excluded.status,attempts=excluded.attempts,detail_json=excluded.detail_json,recorded_at=excluded.recorded_at",
                params![job,item.operation_key,attempts,json,at]).map_err(|e|e.to_string())?;
        } else {
            tx.execute("INSERT INTO projection_receipt(operation_key,status,attempts,detail_json,recorded_at) VALUES(?1,'failed',?2,?3,?4) ON CONFLICT(operation_key) DO UPDATE SET status=excluded.status,attempts=excluded.attempts,detail_json=excluded.detail_json,recorded_at=excluded.recorded_at",
                params![item.operation_key,attempts,json,at]).map_err(|e|e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authority::tests::setup;
    use serde_json::json;
    fn request(key: &str, coalesce: Option<&str>, priority: i64) -> ProjectionRequest {
        ProjectionRequest {
            idempotency_key: key.into(),
            coalesce_key: coalesce.map(str::to_owned),
            operation: "save_task".into(),
            payload: json!({"operation":"save_task","value":{"id":"101"}}),
            priority,
        }
    }
    #[test]
    fn priority_claim_idempotency_coalesce_receipts_and_backoff() {
        let (_dir, path) = setup();
        let mut db = RelayAuthority::open_existing(&path).unwrap();
        db.prepare_legacy_projection().unwrap();
        assert!(!db
            .enqueue_projection(
                None,
                &request("key-1", Some("task:101"), 1),
                "2026-11-13T20:00:00.000Z"
            )
            .unwrap());
        assert!(db
            .enqueue_projection(
                None,
                &request("key-2", Some("task:101"), 2),
                "2026-11-13T20:00:01.000Z"
            )
            .unwrap());
        db.enqueue_projection(
            None,
            &request("key-3", None, 10),
            "2026-11-13T20:00:02.000Z",
        )
        .unwrap();
        let first = db
            .claim_projections(None, 2, "2026-11-13T20:00:03.000Z")
            .unwrap();
        assert_eq!(
            first
                .iter()
                .map(|r| r.operation_key.as_str())
                .collect::<Vec<_>>(),
            ["key-3", "key-2"]
        );
        assert!(db
            .claim_projections(None, 2, "2026-11-13T20:00:04.000Z")
            .unwrap()
            .is_empty());
        db.retry_projection_with_receipt(
            None,
            &first[0],
            "network",
            ProjectionRetry {
                next_attempt_at: "2026-11-13T20:05:00.000Z",
                attempts: 1,
                detail: &json!({"retry":1}),
                at: "2026-11-13T20:00:05.000Z",
            },
        )
        .unwrap();
        db.complete_projection_with_receipt(
            None,
            &first[1],
            true,
            0,
            &json!({"ok":true}),
            "2026-11-13T20:00:05.000Z",
        )
        .unwrap();
        assert!(db
            .claim_projections(None, 2, "2026-11-13T20:00:06.000Z")
            .unwrap()
            .is_empty());
        let later = db
            .claim_projections(None, 1, "2026-11-13T20:05:01.000Z")
            .unwrap();
        assert_eq!(later[0].attempts, 1);
        assert_eq!(later[0].operation_key, "key-3");
        db.complete_projection_with_receipt(
            None,
            &later[0],
            true,
            1,
            &json!({"ok":true}),
            "2026-11-13T20:05:02.000Z",
        )
        .unwrap();
        assert!(db
            .claim_projections(None, 1, "2026-11-13T20:05:03.000Z")
            .unwrap()
            .is_empty());
    }
    #[test]
    fn reclaimed_projection_fences_old_completion_and_retry() {
        let (_dir, path) = setup();
        let mut db = RelayAuthority::open_existing(&path).unwrap();
        db.prepare_legacy_projection().unwrap();
        db.enqueue_projection(
            None,
            &request("claim-1", None, 5),
            "2026-11-13T20:00:00.000Z",
        )
        .unwrap();
        let first = db
            .claim_projections(None, 1, "2026-11-13T20:00:01.000Z")
            .unwrap()
            .remove(0);
        assert!(db
            .claim_projections(None, 1, "2026-11-13T20:01:30.000Z")
            .unwrap()
            .is_empty());
        let second = db
            .claim_projections(None, 1, "2026-11-13T20:03:01.000Z")
            .unwrap()
            .remove(0);
        assert_eq!(first.id, second.id);
        assert_ne!(first.updated_at, second.updated_at);
        assert!(db
            .complete_projection_with_receipt(
                None,
                &first,
                true,
                0,
                &json!({"stale":true}),
                "2026-11-13T20:03:02.000Z"
            )
            .unwrap_err()
            .contains("stale"));
        assert!(db
            .retry_projection_with_receipt(
                None,
                &first,
                "outdated",
                ProjectionRetry {
                    next_attempt_at: "2026-11-13T20:04:00.000Z",
                    attempts: 1,
                    detail: &json!({"stale":true}),
                    at: "2026-11-13T20:03:02.000Z",
                }
            )
            .unwrap_err()
            .contains("stale"));
        let receipt: Option<String> = db
            .connection
            .query_row(
                "SELECT status FROM projection_receipt WHERE operation_key='claim-1'",
                [],
                |r| r.get(0),
            )
            .optional()
            .unwrap();
        assert!(receipt.is_none(), "stale worker must not create a receipt");
        db.complete_projection_with_receipt(
            None,
            &second,
            true,
            0,
            &json!({"fresh":true}),
            "2026-11-13T20:03:03.000Z",
        )
        .unwrap();
        assert!(db
            .claim_projections(None, 1, "2026-11-13T20:03:04.000Z")
            .unwrap()
            .is_empty());
    }
}
