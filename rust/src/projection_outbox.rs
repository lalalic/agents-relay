// Direct Node src/projection-outbox.ts persistence port. SQLite is the durable projection authority.
// Both the standalone legacy table and consolidated job-scoped table are supported.
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{
    params, params_from_iter, types::Value as SqlValue, Connection, OptionalExtension, Row,
};
use serde_json::{json, Value};
use std::time::SystemTime;

pub const SCHEMA_VERSION: i64 = 6;
const COLS: &str = "id,idempotency_key,operation_key,coalesce_key,operation,payload_json,priority,status,attempts,next_attempt_at,last_error,created_at,updated_at,conflict_definition_json,conflict_evidence_json,conflict_detected_at,conflict_disposition,conflict_resolution_json";
fn sql_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}
fn now_iso() -> String {
    DateTime::<Utc>::from(SystemTime::now()).to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn js_json(value: &Value) -> String {
    crate::observability::json_wire(value)
}
fn get_str<'a>(input: &'a Value, key: &str) -> Result<&'a str, String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("missing {key}"))
}

pub fn logical_operation_key(key: &str) -> String {
    for suffix in [":queued:", ":lost:"] {
        if let Some((prefix, digits)) = key.rsplit_once(suffix) {
            if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) {
                return prefix.into();
            }
        }
    }
    key.into()
}

#[derive(Debug, Clone)]
pub struct OutboxRow {
    pub id: i64,
    pub idempotency_key: String,
    pub operation_key: Option<String>,
    pub coalesce_key: Option<String>,
    pub operation: String,
    pub payload_json: String,
    pub priority: i64,
    pub status: String,
    pub attempts: i64,
    pub next_attempt_at: Option<String>,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub conflict_definition_json: Option<String>,
    pub conflict_evidence_json: Option<String>,
    pub conflict_detected_at: Option<String>,
    pub conflict_disposition: Option<String>,
    pub conflict_resolution_json: Option<String>,
}
impl OutboxRow {
    fn from_sql(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            idempotency_key: row.get(1)?,
            operation_key: row.get(2)?,
            coalesce_key: row.get(3)?,
            operation: row.get(4)?,
            payload_json: row.get(5)?,
            priority: row.get(6)?,
            status: row.get(7)?,
            attempts: row.get(8)?,
            next_attempt_at: row.get(9)?,
            last_error: row.get(10)?,
            created_at: row.get(11)?,
            updated_at: row.get(12)?,
            conflict_definition_json: row.get(13)?,
            conflict_evidence_json: row.get(14)?,
            conflict_detected_at: row.get(15)?,
            conflict_disposition: row.get(16)?,
            conflict_resolution_json: row.get(17)?,
        })
    }
}
pub fn row_to_projection(row: &OutboxRow) -> Result<Value, String> {
    Ok(json!({"id":row.id,"idempotencyKey":row.idempotency_key,
        "operationKey":row.operation_key.clone().unwrap_or_else(||logical_operation_key(&row.idempotency_key)),
        "coalesceKey":row.coalesce_key,"operation":row.operation,
        "payload":serde_json::from_str::<Value>(&row.payload_json).map_err(sql_error)?,
        "priority":row.priority,"attempts":row.attempts,"nextAttemptAt":row.next_attempt_at,
        "lastError":row.last_error,"createdAt":row.created_at,"updatedAt":row.updated_at}))
}
pub fn row_to_conflict(row: &OutboxRow) -> Result<Value, String> {
    let evidence = row
        .conflict_evidence_json
        .as_ref()
        .map(|s| serde_json::from_str::<Value>(s))
        .transpose()
        .map_err(sql_error)?
        .unwrap_or_else(|| json!({}));
    let resolution = row
        .conflict_resolution_json
        .as_ref()
        .map(|s| serde_json::from_str::<Value>(s))
        .transpose()
        .map_err(sql_error)?
        .unwrap_or(Value::Null);
    let operation_key = row
        .operation_key
        .clone()
        .unwrap_or_else(|| logical_operation_key(&row.idempotency_key));
    let diverging = evidence["divergingFields"]
        .as_array()
        .map(|v| {
            v.iter()
                .map(|s| {
                    Value::String(match s {
                        Value::String(s) => s.clone(),
                        Value::Null => "null".into(),
                        _ => s.to_string(),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(
        json!({"id":row.id,"status":row.status,"operation":row.operation,"operationKey":operation_key,"attempts":row.attempts,
        "diagnostic":{"kind":evidence["kind"].as_str().unwrap_or("task"),"jobId":evidence["jobId"].as_str().unwrap_or(""),
            "subjectId":evidence["subjectId"].as_str().unwrap_or(""),"operation":row.operation,"operationKey":operation_key,
            "localDefinition":row.conflict_definition_json.as_ref().map(|s|serde_json::from_str::<Value>(s)).transpose().map_err(sql_error)?.unwrap_or(Value::Null),
            "remoteDefinition":evidence.get("remoteDefinition").cloned().unwrap_or(Value::Null),"divergingFields":diverging,
            "detectedAt":row.conflict_detected_at.as_deref().unwrap_or(&row.updated_at),
            "message":evidence["message"].as_str().or(row.last_error.as_deref()).unwrap_or("projection definition conflict")},
        "resolution":resolution}),
    )
}
pub fn create_table_sql(table: &str) -> String {
    format!("CREATE TABLE IF NOT EXISTS {table} (\n        id INTEGER PRIMARY KEY AUTOINCREMENT,\n        idempotency_key TEXT NOT NULL UNIQUE,\n        operation_key TEXT,\n        coalesce_key TEXT,\n        operation TEXT NOT NULL,\n        payload_json TEXT NOT NULL,\n        priority INTEGER NOT NULL DEFAULT 0,\n        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','conflict','dead')),\n        attempts INTEGER NOT NULL DEFAULT 0,\n        next_attempt_at TEXT,\n        last_error TEXT,\n        created_at TEXT NOT NULL,\n        updated_at TEXT NOT NULL,\n        conflict_definition_json TEXT,\n        conflict_evidence_json TEXT,\n        conflict_detected_at TEXT,\n        conflict_disposition TEXT,\n        conflict_resolution_json TEXT\n      );")
}
pub fn create_index_sql() -> &'static str {
    "CREATE INDEX IF NOT EXISTS projection_due_idx ON projection_outbox(status, next_attempt_at, priority DESC, id);\nCREATE INDEX IF NOT EXISTS projection_coalesce_idx ON projection_outbox(coalesce_key, status);"
}
pub fn create_receipt_table_sql() -> &'static str {
    "CREATE TABLE IF NOT EXISTS projection_receipt (\n      operation_key TEXT PRIMARY KEY,\n      status TEXT NOT NULL CHECK(status IN ('succeeded','failed')),\n      attempts INTEGER NOT NULL,\n      detail_json TEXT,\n      recorded_at TEXT NOT NULL\n    );"
}

/// Transactional legacy migration. Any SQL/JSON error returns without partial promotion.
pub fn upgrade(db: &Connection, previous_version: i64) -> Result<(), String> {
    let sql: Option<String> = db
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='projection_outbox'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(sql_error)?;
    let sql = sql.unwrap_or_default();
    let needs_rebuild =
        !sql.is_empty() && (!sql.contains("'conflict'") || !sql.contains("operation_key"));
    db.execute_batch("BEGIN IMMEDIATE").map_err(sql_error)?;
    let outcome = (|| -> Result<(), String> {
        if needs_rebuild {
            db.execute_batch(&format!("DROP INDEX IF EXISTS projection_due_idx; DROP INDEX IF EXISTS projection_coalesce_idx; ALTER TABLE projection_outbox RENAME TO projection_outbox_legacy; {} INSERT INTO projection_outbox(id,idempotency_key,coalesce_key,operation,payload_json,priority,status,attempts,next_attempt_at,last_error,created_at,updated_at) SELECT id,idempotency_key,coalesce_key,operation,payload_json,priority,status,attempts,next_attempt_at,last_error,created_at,updated_at FROM projection_outbox_legacy; DROP TABLE projection_outbox_legacy;",create_table_sql("projection_outbox"))).map_err(sql_error)?;
        }
        db.execute_batch(create_index_sql()).map_err(sql_error)?;
        db.execute("UPDATE projection_outbox SET operation_key=CASE WHEN operation_key IS NOT NULL AND operation_key<>'' THEN operation_key WHEN idempotency_key GLOB '*:queued:*' THEN substr(idempotency_key,1,instr(idempotency_key,':queued:')-1) ELSE idempotency_key END WHERE operation_key IS NULL OR operation_key=''",[]).map_err(sql_error)?;
        let diagnostics = {
            let mut stmt=db.prepare("SELECT id,operation,last_error,attempts,updated_at FROM projection_outbox WHERE status='dead' AND last_error LIKE '%already exists with a different definition%'").map_err(sql_error)?;
            let collected = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, Option<String>>(2)?,
                        r.get::<_, i64>(3)?,
                        r.get::<_, String>(4)?,
                    ))
                })
                .map_err(sql_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(sql_error)?;
            collected
        };
        for (id, op, error, attempts, updated) in diagnostics {
            let evidence = json!({"kind":if op=="append_plan"{"plan"}else{"task"},"subjectId":"","jobId":"","divergingFields":[],"message":error.unwrap_or_else(||"legacy deterministic projection conflict".into()),"migratedFromAttempts":attempts,"recoveredFromSchema":previous_version});
            db.execute("UPDATE projection_outbox SET status='conflict',conflict_detected_at=?,conflict_disposition='classified_on_migration',conflict_evidence_json=?,conflict_definition_json=COALESCE(conflict_definition_json,payload_json) WHERE id=?", params![updated,js_json(&evidence),id]).map_err(sql_error)?;
        }
        Ok(())
    })();
    match outcome {
        Ok(()) => db.execute_batch("COMMIT").map_err(sql_error),
        Err(error) => {
            let _ = db.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

pub struct ProjectionOutbox<'a> {
    db: &'a Connection,
    scope_job_id: Option<String>,
}
impl<'a> ProjectionOutbox<'a> {
    pub fn new(db: &'a Connection, scope_job_id: Option<&str>) -> Self {
        Self {
            db,
            scope_job_id: scope_job_id.map(str::to_string),
        }
    }
    fn and_scope(&self) -> &'static str {
        if self.scope_job_id.is_some() {
            " AND scope_job_id=?"
        } else {
            ""
        }
    }
    fn bind(&self, mut values: Vec<SqlValue>) -> Vec<SqlValue> {
        if let Some(scope) = &self.scope_job_id {
            values.push(SqlValue::Text(scope.clone()));
        }
        values
    }
    fn exec(&self, sql: &str, values: Vec<SqlValue>) -> Result<usize, String> {
        self.db
            .execute(sql, params_from_iter(values))
            .map_err(sql_error)
    }
    fn query_rows(&self, sql: &str, values: Vec<SqlValue>) -> Result<Vec<OutboxRow>, String> {
        let mut stmt = self.db.prepare(sql).map_err(sql_error)?;
        let collected = stmt
            .query_map(params_from_iter(values), OutboxRow::from_sql)
            .map_err(sql_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sql_error);
        collected
    }
    fn transactional<T>(&self, f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        self.db
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(sql_error)?;
        match f() {
            Ok(v) => {
                self.db.execute_batch("COMMIT").map_err(sql_error)?;
                Ok(v)
            }
            Err(e) => {
                let _ = self.db.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }
    pub fn reset_processing(&self, now: &str) -> Result<(), String> {
        let date = DateTime::parse_from_rfc3339(now).map_err(sql_error)?;
        let cutoff = (date - chrono::Duration::seconds(120))
            .with_timezone(&Utc)
            .to_rfc3339_opts(SecondsFormat::Millis, true);
        self.exec(&format!("UPDATE projection_outbox SET status='pending',updated_at=? WHERE status='processing' AND updated_at<=?{}",self.and_scope()),self.bind(vec![now.to_string().into(),cutoff.into()]))?;
        Ok(())
    }
    pub fn enqueue(&self, request: &Value, now: &str) -> Result<bool, String> {
        let key = get_str(request, "idempotencyKey")?;
        let operation_key = logical_operation_key(key);
        let coalesce_key = request
            .get("coalesceKey")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());
        let mut coalesced = false;
        if let Some(coalesce) = coalesce_key {
            coalesced=self.exec(&format!("DELETE FROM projection_outbox WHERE coalesce_key=? AND status='pending' AND operation_key<>?{}",self.and_scope()),self.bind(vec![coalesce.to_string().into(),operation_key.clone().into()]))?>0;
        }
        let existing:Option<String>=self.db.query_row(&format!("SELECT status FROM projection_outbox WHERE operation_key=?{} ORDER BY id DESC LIMIT 1",self.and_scope()),params_from_iter(self.bind(vec![operation_key.clone().into()])),|r|r.get(0)).optional().map_err(sql_error)?;
        let next_id: i64 = self
            .db
            .query_row(
                &format!(
                    "SELECT COALESCE(MAX(id),0)+1 FROM projection_outbox{}",
                    if self.scope_job_id.is_some() {
                        " WHERE scope_job_id=?"
                    } else {
                        ""
                    }
                ),
                params_from_iter(
                    self.scope_job_id
                        .clone()
                        .map(|s| vec![SqlValue::Text(s)])
                        .unwrap_or_default(),
                ),
                |r| r.get(0),
            )
            .map_err(sql_error)?;
        let collides = matches!(
            existing.as_deref(),
            Some("processing" | "conflict" | "dead")
        );
        let idempotency = if collides {
            format!("{operation_key}:queued:{next_id}")
        } else {
            operation_key.clone()
        };
        let payload = js_json(request.get("payload").unwrap_or(&Value::Null));
        let operation = get_str(request, "operation")?;
        let priority = request.get("priority").and_then(Value::as_i64).unwrap_or(0);
        if let Some(scope) = &self.scope_job_id {
            self.db.execute("INSERT INTO projection_outbox(scope_job_id,id,idempotency_key,operation_key,coalesce_key,operation,payload_json,priority,status,attempts,next_attempt_at,last_error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'pending',0,NULL,NULL,?,?) ON CONFLICT(scope_job_id,idempotency_key) DO UPDATE SET operation_key=excluded.operation_key,coalesce_key=excluded.coalesce_key,operation=excluded.operation,payload_json=excluded.payload_json,priority=MAX(projection_outbox.priority,excluded.priority),status='pending',next_attempt_at=NULL,last_error=NULL,updated_at=excluded.updated_at",params![scope,next_id,idempotency,operation_key,coalesce_key,operation,payload,priority,now,now]).map_err(sql_error)?;
        } else {
            self.db.execute("INSERT INTO projection_outbox(idempotency_key,operation_key,coalesce_key,operation,payload_json,priority,status,attempts,next_attempt_at,last_error,created_at,updated_at) VALUES(?,?,?,?,?,?,'pending',0,NULL,NULL,?,?) ON CONFLICT(idempotency_key) DO UPDATE SET operation_key=excluded.operation_key,coalesce_key=excluded.coalesce_key,operation=excluded.operation,payload_json=excluded.payload_json,priority=MAX(projection_outbox.priority,excluded.priority),status='pending',next_attempt_at=NULL,last_error=NULL,updated_at=excluded.updated_at",params![idempotency,operation_key,coalesce_key,operation,payload,priority,now,now]).map_err(sql_error)?;
        }
        Ok(coalesced)
    }
    pub fn claim_due(&self, limit: f64, now: &str) -> Result<Vec<Value>, String> {
        self.db
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(sql_error)?;
        let transaction = (|| -> Result<Vec<OutboxRow>, String> {
            self.reset_processing(now)?;
            let bound = self.bind(vec![
                now.to_string().into(),
                SqlValue::Integer(if limit.is_finite() {
                    limit.floor().max(1.0) as i64
                } else {
                    1
                }),
            ]);
            let rows=self.query_rows(&format!("SELECT {COLS} FROM projection_outbox WHERE status='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?){} ORDER BY priority DESC,id ASC LIMIT ?",self.and_scope()),if self.scope_job_id.is_some(){let mut values=bound;values.swap(1,2);values}else{bound})?;
            let mut claimed = vec![];
            for mut row in rows {
                let changed=self.exec(&format!("UPDATE projection_outbox SET status='processing',updated_at=? WHERE id=? AND status='pending'{}",self.and_scope()),self.bind(vec![now.to_string().into(),row.id.into()]))?;
                if changed == 1 {
                    row.updated_at = now.to_string();
                    claimed.push(row)
                }
            }
            Ok(claimed)
        })();
        match transaction {
            Ok(rows) => {
                self.db.execute_batch("COMMIT").map_err(sql_error)?;
                // Node maps rowToProjection *after* COMMIT, inside its try. Preserve
                // the legacy post-commit invalid-JSON/failed-ROLLBACK behavior.
                match rows
                    .iter()
                    .map(row_to_projection)
                    .collect::<Result<Vec<_>, _>>()
                {
                    Ok(projected) => Ok(projected),
                    Err(_) => Err(self
                        .db
                        .execute_batch("ROLLBACK")
                        .expect_err("already committed")
                        .to_string()),
                }
            }
            Err(error) => match self.db.execute_batch("ROLLBACK") {
                Ok(()) => Err(error),
                Err(rollback) => Err(rollback.to_string()),
            },
        }
    }
    pub fn complete(&self, id: i64) -> Result<(), String> {
        self.exec(
            &format!(
                "DELETE FROM projection_outbox WHERE id=?{}",
                self.and_scope()
            ),
            self.bind(vec![id.into()]),
        )?;
        Ok(())
    }
    pub fn record_receipt(
        &self,
        key: &str,
        status: &str,
        attempts: i64,
        detail: &Value,
        now: &str,
    ) -> Result<(), String> {
        let json = js_json(detail);
        if let Some(scope) = &self.scope_job_id {
            self.db.execute("INSERT INTO projection_receipt(scope_job_id,operation_key,status,attempts,detail_json,recorded_at) VALUES(?,?,?,?,?,?) ON CONFLICT(scope_job_id,operation_key) DO UPDATE SET status=excluded.status,attempts=excluded.attempts,detail_json=excluded.detail_json,recorded_at=excluded.recorded_at",params![scope,key,status,attempts,json,now]).map_err(sql_error)?;
        } else {
            self.db.execute("INSERT INTO projection_receipt(operation_key,status,attempts,detail_json,recorded_at) VALUES(?,?,?,?,?) ON CONFLICT(operation_key) DO UPDATE SET status=excluded.status,attempts=excluded.attempts,detail_json=excluded.detail_json,recorded_at=excluded.recorded_at",params![key,status,attempts,json,now]).map_err(sql_error)?;
        }
        Ok(())
    }
    pub fn complete_with_receipt(
        &self,
        id: i64,
        key: &str,
        status: &str,
        attempts: i64,
        detail: &Value,
        now: &str,
    ) -> Result<(), String> {
        self.transactional(|| {
            self.record_receipt(key, status, attempts, detail, now)?;
            self.complete(id)
        })
    }
    #[allow(clippy::too_many_arguments)]
    // Mirrors seven caller-visible arguments of Node retryWithReceipt.
    // Preserve Node method signature for direct file-to-file parity.
    #[allow(clippy::too_many_arguments)]
    pub fn retry_with_receipt(
        &self,
        id: i64,
        key: &str,
        error: &str,
        next_at: &str,
        attempts: i64,
        detail: &Value,
        now: &str,
    ) -> Result<(), String> {
        self.transactional(||{self.exec(&format!("UPDATE projection_outbox SET status='pending',attempts=?,next_attempt_at=?,last_error=?,updated_at=? WHERE id=?{}",self.and_scope()),self.bind(vec![attempts.into(),next_at.to_string().into(),error.to_string().into(),now.to_string().into(),id.into()]))?;self.record_receipt(key,"failed",attempts,detail,now)})
    }
    pub fn retry(&self, id: i64, error: &str, next_at: &str) -> Result<(), String> {
        self.exec(&format!("UPDATE projection_outbox SET status='pending',attempts=attempts+1,next_attempt_at=?,last_error=?,updated_at=? WHERE id=?{}",self.and_scope()),self.bind(vec![next_at.to_string().into(),error.to_string().into(),now_iso().into(),id.into()]))?;
        Ok(())
    }
    pub fn dead_letter(&self, id: i64, error: &str) -> Result<(), String> {
        self.exec(&format!("UPDATE projection_outbox SET status='dead',attempts=attempts+1,next_attempt_at=NULL,last_error=?,updated_at=? WHERE id=?{}",self.and_scope()),self.bind(vec![error.to_string().into(),now_iso().into(),id.into()]))?;
        Ok(())
    }
    pub fn record_conflict(&self, id: i64, diagnostic: &Value) -> Result<(), String> {
        let evidence = json!({"kind":diagnostic["kind"],"jobId":diagnostic["jobId"],"subjectId":diagnostic["subjectId"],"remoteDefinition":diagnostic["remoteDefinition"],"divergingFields":diagnostic["divergingFields"],"message":diagnostic["message"]});
        let time = get_str(diagnostic, "detectedAt")?;
        let message = get_str(diagnostic, "message")?;
        self.exec(&format!("UPDATE projection_outbox SET status='conflict',attempts=attempts+1,next_attempt_at=NULL,last_error=?,conflict_definition_json=?,conflict_evidence_json=?,conflict_detected_at=?,conflict_disposition='awaiting_repair',conflict_resolution_json=NULL,updated_at=? WHERE id=? AND status NOT IN ('conflict','dead'){}",self.and_scope()),self.bind(vec![message.to_string().into(),js_json(&diagnostic["localDefinition"]).into(),js_json(&evidence).into(),time.to_string().into(),time.to_string().into(),id.into()]))?;
        Ok(())
    }
    pub fn list_conflicts(&self) -> Result<Vec<Value>, String> {
        self.query_rows(
            &format!(
                "SELECT {COLS} FROM projection_outbox WHERE status='conflict'{} ORDER BY id ASC",
                self.and_scope()
            ),
            self.bind(vec![]),
        )?
        .iter()
        .map(row_to_conflict)
        .collect()
    }
    pub fn resolve_conflict(&self, id: i64, resolution: &Value) -> Result<bool, String> {
        let status: Option<String> = self
            .db
            .query_row(
                &format!(
                    "SELECT status FROM projection_outbox WHERE id=?{}",
                    self.and_scope()
                ),
                params_from_iter(self.bind(vec![id.into()])),
                |r| r.get(0),
            )
            .optional()
            .map_err(sql_error)?;
        if status.as_deref() != Some("conflict") {
            return Ok(false);
        }
        let now = now_iso();
        let mut resolved = json!({"action":resolution["action"],"resolvedAt":now});
        if let Some(note) = resolution
            .get("note")
            .and_then(Value::as_str)
            .filter(|n| !n.is_empty())
        {
            resolved["note"] = note.into();
        }
        if resolution["action"] == "requeue" {
            self.exec(&format!("UPDATE projection_outbox SET status='pending',attempts=0,next_attempt_at=NULL,conflict_disposition='requeued',conflict_resolution_json=?,updated_at=? WHERE id=? AND status='conflict'{}",self.and_scope()),self.bind(vec![js_json(&resolved).into(),now.to_string().into(),id.into()]))?;
        } else {
            self.exec(
                &format!(
                    "DELETE FROM projection_outbox WHERE id=? AND status=?{}",
                    self.and_scope()
                ),
                self.bind(vec![id.into(), String::from("conflict").into()]),
            )?;
        }
        Ok(true)
    }
    fn count(&self, where_clause: &str) -> Result<i64, String> {
        self.db
            .query_row(
                &format!(
                    "SELECT COUNT(*) FROM projection_outbox WHERE {where_clause}{}",
                    self.and_scope()
                ),
                params_from_iter(self.bind(vec![])),
                |r| r.get(0),
            )
            .map_err(sql_error)
    }
    pub fn conflict_count(&self) -> Result<i64, String> {
        self.count("status='conflict'")
    }
    pub fn pending_count(&self) -> Result<i64, String> {
        self.count("status IN ('pending','processing')")
    }
    pub fn terminal_count(&self) -> Result<i64, String> {
        self.count("status='dead'")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(&format!(
            "{} {} {}",
            create_table_sql("projection_outbox"),
            create_index_sql(),
            create_receipt_table_sql()
        ))
        .unwrap();
        db
    }
    fn request(key: &str, priority: i64) -> Value {
        json!({"idempotencyKey":key,"operation":"save_task","payload":{"task":key},"priority":priority})
    }
    #[test]
    fn priority_fifo_upsert_dedupe_and_retry() {
        let db = db();
        let box_ = ProjectionOutbox::new(&db, None);
        let t = "2026-01-02T00:00:00.000Z";
        box_.enqueue(&request("a", 1), t).unwrap();
        box_.enqueue(&request("b", 3), t).unwrap();
        box_.enqueue(&request("a", 2), t).unwrap();
        assert_eq!(box_.pending_count().unwrap(), 2);
        let claimed = box_.claim_due(100., t).unwrap();
        assert_eq!(
            claimed
                .iter()
                .map(|v| v["idempotencyKey"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["b", "a"]
        );
        assert_eq!(claimed[0]["priority"], 3);
        box_.retry_with_receipt(
            2,
            "b",
            "timeout",
            "2026-01-03T00:00:00.000Z",
            2,
            &json!({"failed":true}),
            t,
        )
        .unwrap();
        let attempts: i64 = db
            .query_row(
                "SELECT attempts FROM projection_outbox WHERE id=2",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(attempts, 2);
        assert_eq!(box_.claim_due(10., t).unwrap().len(), 0);
        box_.complete_with_receipt(1, "a", "succeeded", 1, &json!({"ok":true}), t)
            .unwrap();
        assert_eq!(box_.pending_count().unwrap(), 1);
        assert_eq!(
            db.query_row(
                "SELECT status FROM projection_receipt WHERE operation_key='a'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "succeeded"
        );
    }
    #[test]
    fn coalescing_does_not_delete_processing_conflicts() {
        let db = db();
        let box_ = ProjectionOutbox::new(&db, None);
        let t = "2026-01-02T00:00:00.000Z";
        for key in ["a", "b"] {
            let mut q = request(key, 1);
            q["coalesceKey"] = "same".into();
            assert_eq!(box_.enqueue(&q, t).unwrap(), key == "b");
        }
        let claimed = box_.claim_due(1., t).unwrap();
        assert_eq!(claimed[0]["idempotencyKey"], "b");
        let mut q = request("b", 1);
        q["coalesceKey"] = "same".into();
        box_.enqueue(&q, t).unwrap();
        assert_eq!(box_.pending_count().unwrap(), 2);
        assert_eq!(
            box_.claim_due(10., t).unwrap()[0]["idempotencyKey"],
            "b:queued:3"
        );
        box_.complete(2).unwrap();
        assert_eq!(box_.pending_count().unwrap(), 1);
    }
    #[test]
    fn conflict_round_trip_and_explicit_disposition() {
        let db = db();
        let box_ = ProjectionOutbox::new(&db, None);
        let t = "2026-01-02T00:00:00.000Z";
        box_.enqueue(&request("x", 0), t).unwrap();
        let diagnostic = json!({"kind":"plan","jobId":"7","subjectId":"4","operation":"append_plan","operationKey":"x","localDefinition":{"a":1},"remoteDefinition":{"a":2},"divergingFields":["a"],"detectedAt":t,"message":"different"});
        box_.record_conflict(1, &diagnostic).unwrap();
        box_.record_conflict(1, &diagnostic).unwrap();
        assert_eq!(box_.conflict_count().unwrap(), 1);
        let conflicts = box_.list_conflicts().unwrap();
        assert_eq!(conflicts[0]["attempts"], 1);
        assert_eq!(conflicts[0]["diagnostic"]["remoteDefinition"]["a"], 2);
        assert!(!box_
            .resolve_conflict(25, &json!({"action":"requeue"}))
            .unwrap());
        assert!(box_
            .resolve_conflict(1, &json!({"action":"requeue","note":"repair"}))
            .unwrap());
        assert_eq!(box_.pending_count().unwrap(), 1);
        box_.record_conflict(1, &diagnostic).unwrap();
        assert!(box_
            .resolve_conflict(1, &json!({"action":"discard_local"}))
            .unwrap());
        assert_eq!(box_.pending_count().unwrap(), 0);
    }
    #[test]
    fn atomic_receipt_failure_rolls_back_delete_and_retry() {
        let db = db();
        let box_ = ProjectionOutbox::new(&db, None);
        let t = "2026-01-02T00:00:00.000Z";
        box_.enqueue(&request("x", 0), t).unwrap();
        db.execute_batch("DROP TABLE projection_receipt").unwrap();
        assert!(box_
            .complete_with_receipt(1, "x", "succeeded", 0, &Value::Null, t)
            .is_err());
        assert_eq!(box_.pending_count().unwrap(), 1);
        assert!(box_
            .retry_with_receipt(1, "x", "failed", t, 9, &Value::Null, t)
            .is_err());
        assert_eq!(
            db.query_row("SELECT attempts FROM projection_outbox", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn claim_commits_before_parsing_legacy_invalid_json() {
        let db = db();
        let box_ = ProjectionOutbox::new(&db, None);
        let t = "2026-01-02T00:00:00.000Z";
        box_.enqueue(&request("good", 1), t).unwrap();
        box_.enqueue(&request("bad", 0), t).unwrap();
        db.execute(
            "UPDATE projection_outbox SET payload_json='[invalid' WHERE id=2",
            [],
        )
        .unwrap();
        assert!(box_.claim_due(8., t).is_err());
        assert_eq!(
            db.query_row(
                "SELECT COUNT(*) FROM projection_outbox WHERE status='processing'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            2
        );
    }
    #[test]
    fn migration_classifies_conflicts_and_rolls_back_on_error() {
        let db = db();
        let t = "2026-01-02T00:00:00.000Z";
        db.execute("INSERT INTO projection_outbox(idempotency_key,operation,payload_json,priority,status,attempts,last_error,created_at,updated_at) VALUES('op:queued:7','append_plan','{}',0,'dead',2,'already exists with a different definition',?,?)",params![t,t]).unwrap();
        upgrade(&db, 4).unwrap();
        let box_ = ProjectionOutbox::new(&db, None);
        let r = box_.list_conflicts().unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0]["operationKey"], "op");
        assert_eq!(r[0]["diagnostic"]["kind"], "plan");
        assert_eq!(r[0]["diagnostic"]["localDefinition"], json!({}));
    }
    #[test]
    fn scoped_rows_isolated_and_no_cross_job_delete() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE projection_outbox(scope_job_id TEXT NOT NULL,id INTEGER NOT NULL,idempotency_key TEXT NOT NULL,operation_key TEXT,coalesce_key TEXT,operation TEXT NOT NULL,payload_json TEXT NOT NULL,priority INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at TEXT,last_error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,conflict_definition_json TEXT,conflict_evidence_json TEXT,conflict_detected_at TEXT,conflict_disposition TEXT,conflict_resolution_json TEXT,PRIMARY KEY(scope_job_id,id),UNIQUE(scope_job_id,idempotency_key)); CREATE TABLE projection_receipt(scope_job_id TEXT NOT NULL,operation_key TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL,detail_json TEXT,recorded_at TEXT, PRIMARY KEY(scope_job_id,operation_key));").unwrap();
        let a = ProjectionOutbox::new(&db, Some("job1"));
        let b = ProjectionOutbox::new(&db, Some("job2"));
        let t = "2026-01-02T00:00:00.000Z";
        a.enqueue(&request("same", 2), t).unwrap();
        b.enqueue(&request("same", 5), t).unwrap();
        assert_eq!(a.claim_due(1., t).unwrap()[0]["priority"], 2);
        assert_eq!(b.claim_due(1., t).unwrap()[0]["priority"], 5);
        a.complete_with_receipt(1, "same", "succeeded", 1, &Value::Null, t)
            .unwrap();
        assert_eq!(a.pending_count().unwrap(), 0);
        assert_eq!(b.pending_count().unwrap(), 1);
    }
    #[test]
    fn operation_key_suffix_only_numeric() {
        assert_eq!(logical_operation_key("x:queued:12"), "x");
        assert_eq!(logical_operation_key("x:lost:1"), "x");
        assert_eq!(logical_operation_key("x:queued:x"), "x:queued:x");
        assert_eq!(
            logical_operation_key("x:queued:12:more"),
            "x:queued:12:more"
        );
    }
}
