// Direct port of Node src/legacy-blocked-task-migration.ts and its normalizeLegacyTaskLifecycle dependency in src/types.ts.
use crate::json_wire_parse::parse_js_json;
use crate::observability::json_wire;
use chrono::{DateTime, NaiveDateTime};
use rusqlite::{params, Connection};
use serde_json::{json, Value};

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64() != Some(0.0),
        _ => true,
    }
}
fn parse_date(raw: &str) -> Option<i64> {
    if let Ok(date) = DateTime::parse_from_rfc3339(raw) {
        return Some(date.timestamp_millis());
    }
    if let Ok(date) = NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M:%S") {
        return Some(date.and_utc().timestamp_millis());
    }
    None
}
fn missing_or_null(item: &Value, key: &str) -> bool {
    item.get(key).is_none_or(Value::is_null)
}

/// Preserve ordinary dependency-held DRAFT Tasks. Only historical overloaded
/// BLOCKED/UNBLOCKED and interactive-wait snapshots are rewritten.
pub fn normalize_legacy_task_lifecycle(task: &Value) -> Value {
    let mut updated = task.clone();
    let Some(object) = updated.as_object_mut() else {
        return updated;
    };
    let state = object
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if state == "UNBLOCKED" {
        let is_troubleshooter =
            object.get("agentName").and_then(Value::as_str) == Some("troubleshooter");
        object.insert(
            "state".into(),
            json!(if is_troubleshooter {
                "QUEUED"
            } else {
                "FAILED"
            }),
        );
        if missing_or_null(task, "failureReason") {
            object.insert(
                "failureReason".into(),
                json!("legacy_unblocked_task_requires_recovery"),
            );
        }
        let attempt = task.get("attempt").and_then(Value::as_f64).unwrap_or(0.0);
        let max_attempts = task
            .get("maxAttempts")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let next = 3.0_f64.max(max_attempts).max(attempt + 1.0);
        object.insert("maxAttempts".into(), json!(next as i64));
        if truthy(task.get("unblock")) {
            if let Some(unblock) = object.get_mut("unblock").and_then(Value::as_object_mut) {
                unblock.insert("event".into(), json!("task.unblocked"));
            }
        } else {
            object.remove("unblock");
        }
    }
    if state == "DRAFT" {
        let attempt = task.get("attempt").and_then(Value::as_f64).unwrap_or(0.0);
        let interactive = task.get("interactiveInvocation");
        let bound = interactive.and_then(|value| value.get("boundAt"));
        let status = interactive
            .and_then(|value| value.get("status"))
            .and_then(Value::as_str);
        let decided = interactive.and_then(|value| value.get("decidedAt"));
        let within_decision = truthy(decided)
            && task
                .get("updatedAt")
                .and_then(Value::as_str)
                .and_then(parse_date)
                .zip(decided.and_then(Value::as_str).and_then(parse_date))
                .is_some_and(|(updated, decided)| updated <= decided);
        if attempt > 0.0
            && truthy(interactive)
            && !truthy(task.get("executionId"))
            && truthy(bound)
            && !truthy(task.get("unblock"))
            && (status == Some("awaiting_decision") || within_decision)
        {
            object.insert("state".into(), json!("AWAITING_DECISION"));
        }
    }
    if state == "BLOCKED"
        && task.get("kind").and_then(Value::as_str) != Some("planner")
        && task.get("agentName").and_then(Value::as_str) != Some("troubleshooter")
    {
        object.insert("state".into(), json!("FAILED"));
        if missing_or_null(task, "failureReason") {
            object.insert("failureReason".into(), json!("legacy_ordinary_blocked"));
        }
        if missing_or_null(task, "error") {
            object.insert("error".into(),json!("Legacy ordinary Task was BLOCKED; preserved as FAILED pending Troubleshooter diagnosis."));
        }
    }
    updated
}

pub fn migrate_legacy_blocked_tasks(db: &Connection) -> Result<(), String> {
    let mut select = db
        .prepare("SELECT job_id,json FROM job_snapshot")
        .map_err(|error| error.to_string())?;
    let rows = select
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(select);
    let mut update = db
        .prepare("UPDATE job_snapshot SET json=? WHERE job_id=?")
        .map_err(|error| error.to_string())?;
    for (id, json_data) in rows {
        let mut job = parse_js_json(&json_data)?;
        let Some(original) = job.get("tasks").and_then(Value::as_array) else {
            return Err(format!("Job {id} tasks is not an array"));
        };
        let rewritten = original
            .iter()
            .map(normalize_legacy_task_lifecycle)
            .collect::<Vec<_>>();
        if &rewritten != original {
            job["tasks"] = json!(rewritten);
            update
                .execute(params![json_wire(&job), id])
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}
