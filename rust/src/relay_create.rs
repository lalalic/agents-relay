// Direct port of Node src/relay-create.ts: atomic create-if-absent using SQLite as Job truth, returning normalized existing Job snapshots.
use crate::observability::json_wire;
use crate::relay_job_snapshot_reads::{current_job_metadata, normalize_relay_job};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::Value;
use std::time::SystemTime;
pub fn create_job_if_absent(db: &mut Connection, job: &Value) -> Result<Value, String> {
    let id = job
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "job.id missing".to_string())?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let prior = tx
        .query_row(
            "SELECT json FROM job_snapshot WHERE job_id=?",
            params![id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if let Some(value) = prior.filter(|value| !value.is_empty()) {
        let normalized = normalize_relay_job(&value)?;
        tx.commit().map_err(|error| error.to_string())?;
        return Ok(normalized);
    }
    let metadata = current_job_metadata(job);
    let now = DateTime::<Utc>::from(SystemTime::now()).to_rfc3339_opts(SecondsFormat::Millis, true);
    tx.execute(
        "INSERT INTO job_snapshot(job_id,json,updated_at) VALUES(?,?,?)",
        params![id, json_wire(&metadata), now],
    )
    .map_err(|error| error.to_string())?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok(job.clone())
}
