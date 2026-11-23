// Direct port of Node src/task-inactivity-watchdog.ts: execution-scoped
// deadlines, source correlation and monotonic progress receipt guards.
// Durable Graph transition/persistence is owned by the caller, not this clock adapter.
use crate::execution_event_identity::{event_source_id, execution_event_source};
use chrono::{DateTime, NaiveDate, NaiveDateTime};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use std::{
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}
fn parse_ms(text: &str) -> Option<i64> {
    if let Ok(dt) = DateTime::parse_from_rfc3339(text) {
        return Some(dt.timestamp_millis());
    }
    if let Ok(dt) = NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M:%S%.f") {
        return Some(dt.and_utc().timestamp_millis());
    }
    NaiveDate::parse_from_str(text, "%Y-%m-%d")
        .ok()
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .map(|d| d.and_utc().timestamp_millis())
}
fn string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}
fn js_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::String(s) => !s.is_empty(),
        Value::Number(n) => n.as_f64() != Some(0.0),
        _ => true,
    }
}

pub fn requires_worker_inactivity_watchdog(task: &Value) -> bool {
    !(task.get("agentGraph").is_some_and(js_truthy)
        && task.get("executionId") == Some(&Value::Null))
}
pub fn is_recoverable_watchdog_failure(task: &Value) -> bool {
    if matches!(
        string(task, "failureReason"),
        Some(
            "worker_start_timeout"
                | "terminal_event_timeout"
                | "worker_exit_before_start"
                | "worker_exit_without_terminal_event"
                | "worker_delivery_after_start"
        )
    ) {
        return true;
    }
    let error = string(task, "error").unwrap_or("");
    [
        "worker_start_timeout",
        "timed out waiting for the mandatory terminal worker event",
        "exceeded its inactivity timeout",
        "exited before publishing task.started",
        "exited after task.started without publishing a terminal task event",
        "Worker delivery failed after task.started",
    ]
    .iter()
    .any(|fragment| error.contains(fragment))
}
pub fn is_correlated_worker_event(task: &Value, event: &Value) -> bool {
    let Some(execution_id) = string(task, "executionId") else {
        return false;
    };
    let Some(job_id) = string(event, "job_id") else {
        return false;
    };
    let Some(task_id) = string(task, "id") else {
        return false;
    };
    event_source_id(event).as_deref()
        == Some(execution_event_source(job_id, task_id, execution_id).as_str())
}

/// Equivalent to acceptTaskProgress eligibility plus mutation. A durable transition adapter must
/// apply the returned Task atomically through the Task Graph before publishing success.
pub fn task_progress_mutation(task: &Value, event: &Value, now: i64) -> Option<Value> {
    if string(task, "state") != Some("RUNNING") || !is_correlated_worker_event(task, event) {
        return None;
    }
    let parsed = parse_ms(string(event, "timestamp")?)?;
    if parsed > now {
        return None;
    }
    if string(task, "lastProgressEventAt")
        .and_then(parse_ms)
        .is_some_and(|prior| parsed <= prior)
    {
        return None;
    }
    // In JS, invalid previous Date.parse becomes NaN and therefore rejects the new event.
    if string(task, "lastProgressEventAt").is_some_and(|previous| parse_ms(previous).is_none()) {
        return None;
    }
    let mut next = task.clone();
    let received = DateTime::<chrono::Utc>::from_timestamp_millis(now)?
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    next["lastProgressAt"] = json!(received);
    next["lastProgressEventAt"] = event["timestamp"].clone();
    next["updatedAt"] = json!(received);
    Some(next)
}

/// Apply a correlated progress event to fresh SQLite state and commit it atomically.
/// The canonical Graph selects the legal RUNNING self-loop; no receipt can revive
/// a cancelled or superseded execution. No live-store defaults are used.
/// Node acceptTaskProgress: apply the accepted, correlated observation
/// through the canonical Graph+SQLite transition; never accept a stale lease.
pub fn accept_task_progress(
    db:&mut Connection,graph_dir:&Path,event:&Value,received_at:i64,
)->Result<Option<Value>,String>{
    accept_task_progress_sqlite(db,graph_dir,event,received_at)
}
pub fn accept_task_progress_sqlite(
    db: &mut Connection,
    graph_dir: &Path,
    event: &Value,
    received_at: i64,
) -> Result<Option<Value>, String> {
    use crate::task_transitions::try_transition_task_event;
    let Some(job_id) = string(event, "job_id") else {
        return Ok(None);
    };
    let Some(task_id) = string(event, "task_id") else {
        return Ok(None);
    };
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let raw: Option<String> = tx
        .query_row(
            "SELECT json FROM job_snapshot WHERE job_id=?",
            [job_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some(raw) = raw else { return Ok(None) };
    let mut job: Value = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    let Some(tasks) = job.get_mut("tasks").and_then(Value::as_array_mut) else {
        return Ok(None);
    };
    let Some(task) = tasks
        .iter_mut()
        .find(|task| string(task, "id") == Some(task_id))
    else {
        return Ok(None);
    };
    let Some(mut updated) = task_progress_mutation(task, event, received_at) else {
        return Ok(None);
    };
    let timestamp = DateTime::<chrono::Utc>::from_timestamp_millis(received_at)
        .ok_or("invalid progress receipt clock")?
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let decision = try_transition_task_event(
        graph_dir,
        &mut updated,
        "task.progress",
        &json!({}),
        &timestamp,
    )?;
    if decision["accepted"] != true || decision["target"].is_null() {
        return Ok(None);
    }
    // DurableTaskTransitionRuntime increments the version on a same-millisecond
    // self-loop even when the wall clock has moved backwards.
    if let Some(old) = string(task, "updatedAt").and_then(parse_ms) {
        if string(&updated, "updatedAt")
            .and_then(parse_ms)
            .is_none_or(|t| t <= old)
        {
            updated["updatedAt"] = json!(DateTime::<chrono::Utc>::from_timestamp_millis(
                old.saturating_add(1)
            )
            .ok_or("invalid durable Task clock")?
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
        }
    }
    *task = updated.clone();
    let changed = tx
        .execute(
            "UPDATE job_snapshot SET json=?,updated_at=? WHERE job_id=? AND json=?",
            params![
                job.to_string(),
                updated["updatedAt"].as_str().unwrap_or(&timestamp),
                job_id,
                raw
            ],
        )
        .map_err(|error| error.to_string())?;
    if changed != 1 {
        return Err("Stale durable Job snapshot during progress receipt".into());
    }
    tx.commit().map_err(|error| error.to_string())?;
    Ok(Some(updated))
}
