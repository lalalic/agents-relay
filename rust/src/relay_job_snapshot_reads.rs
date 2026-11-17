// Direct port of Node src/relay-job-snapshot-reads.ts: immutable normalized Job read projections from the authoritative SQLite snapshots.
use crate::{
    job_pr_number_migration::{normalize_legacy_job_pr_number, parse_js_json},
    legacy_blocked_task_migration::normalize_legacy_task_lifecycle,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

const HISTORIC_JOB_KEYS: [&str; 6] = [
    "schedule",
    "executionMode",
    "contentOnly",
    "shortcutExecutionStartedAt",
    "shortcutRunnerContext",
    "shortcutExecutionDeadlineAt",
];

pub fn current_job_metadata(job: &Value) -> Value {
    let mut result = job.clone();
    if let Some(object) = result.as_object_mut() {
        for key in HISTORIC_JOB_KEYS {
            object.remove(key);
        }
    }
    result
}

pub fn normalize_relay_job(raw: &str) -> Result<Value, String> {
    let initial = parse_js_json(raw)?;
    let mut job = current_job_metadata(&normalize_legacy_job_pr_number(&initial));
    let tasks = job
        .get_mut("tasks")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "job.tasks is not an array".to_string())?;
    for task in tasks.iter_mut() {
        *task = normalize_legacy_task_lifecycle(task);
    }
    let plans = job.get_mut("plans");
    if plans.is_none_or(|plans| plans.is_null()) {
        job["plans"] = Value::Array(Vec::new());
    }
    let plans = job
        .get_mut("plans")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "job.plans is not an array".to_string())?;
    for plan in plans {
        if let Some(object) = plan.as_object_mut() {
            if !object.contains_key("forceRestate")
                && object.get("forceCleanHistory") == Some(&Value::Bool(true))
            {
                object.insert("forceRestate".into(), Value::Bool(true));
            }
            if !object.contains_key("restateTaskIds") {
                if let Some(legacy) = object.get("cleanHistoryTaskIds").filter(|value| {
                    !value.is_null()
                        && value != &&Value::Bool(false)
                        && value != &&Value::String(String::new())
                }) {
                    object.insert("restateTaskIds".into(), legacy.clone());
                }
            }
            object.remove("forceCleanHistory");
            object.remove("cleanHistoryTaskIds");
        }
    }
    Ok(job)
}

pub fn load_relay_job(db: &Connection, job_id: &str) -> Result<Option<Value>, String> {
    let raw = db
        .query_row(
            "SELECT json FROM job_snapshot WHERE job_id=?",
            params![job_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    raw.filter(|raw| !raw.is_empty())
        .map(|raw| normalize_relay_job(&raw))
        .transpose()
}
pub fn list_relay_jobs(db: &Connection, scope_job_id: Option<&str>) -> Result<Vec<Value>, String> {
    let sql = if scope_job_id.is_some_and(|id| !id.is_empty()) {
        "SELECT json FROM job_snapshot WHERE job_id=? ORDER BY job_id"
    } else {
        "SELECT json FROM job_snapshot ORDER BY job_id"
    };
    let mut query = db.prepare(sql).map_err(|error| error.to_string())?;
    let rows = if let Some(id) = scope_job_id.filter(|id| !id.is_empty()) {
        query
            .query_map(params![id], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    } else {
        query
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    };
    rows.iter().map(|raw| normalize_relay_job(raw)).collect()
}
