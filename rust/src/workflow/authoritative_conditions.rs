// Direct port of src/workflow/authoritative-conditions.ts: read-only durable
// SQLite facts; execution identity alone cannot prove process termination.
use crate::task_transitions::completion_gate_satisfied;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

pub const AUTHORITATIVE_PREDICATES: &[&str] = &[
    "task.queued",
    "task.succeeded",
    "task.failed",
    "task.routing-cleared",
    "task.execution-stopped",
    "job.objective-verified",
    "job.completed",
];
pub fn verify_authoritative_condition(
    db: &Connection,
    job_id: &str,
    predicate: &str,
    task_id: Option<&str>,
    execution_id: Option<&str>,
) -> Result<&'static str, String> {
    if job_id.is_empty() {
        return Err("job ID required".into());
    }
    let snapshot: Option<String> = db
        .query_row(
            "SELECT json FROM job_snapshot WHERE job_id=?",
            params![job_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some(snapshot) = snapshot else {
        return Ok("Unknown");
    };
    let job: Value = serde_json::from_str(&snapshot).map_err(|e| e.to_string())?;
    if predicate == "job.objective-verified" {
        return Ok(if completion_gate_satisfied(&job) {
            "Verified"
        } else {
            "Failed"
        });
    }
    if predicate == "job.completed" {
        return Ok(
            if job["state"] == "COMPLETED" && completion_gate_satisfied(&job) {
                "Verified"
            } else {
                "Failed"
            },
        );
    }
    let Some(task) = job["tasks"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|task| task.get("id").and_then(Value::as_str) == task_id)
    else {
        return Ok("Unknown");
    };
    let status = match predicate {
        "task.queued" => task["state"] == "QUEUED",
        "task.succeeded" => task["state"] == "SUCCEEDED",
        "task.failed" => task["state"] == "FAILED",
        "task.routing-cleared" => {
            task.get("executionId") == Some(&Value::Null)
        }
        "task.execution-stopped" => {
            let Some(execution_id) = execution_id.filter(|id| !id.is_empty()) else {
                return Ok("Unknown");
            };
            if task["executionId"] == execution_id {
                return Ok("Failed");
            }
            if !task["executionHistory"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|entry| entry["id"] == execution_id)
            {
                return Ok("Unknown");
            }
            let exists: Option<String> = db.query_row(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='execution_process'",
                [], |r|r.get(0)).optional().map_err(|e|e.to_string())?;
            if exists.is_none() {
                return Ok("Unknown");
            }
            let ended: Option<Option<String>> = db.query_row(
                "SELECT ended_at FROM execution_process WHERE job_id=? AND task_id=? AND execution_id=?",
                params![job_id,task_id,execution_id],|r|r.get(0))
                .optional().map_err(|e|e.to_string())?;
            return Ok(if ended.flatten().is_some_and(|s| !s.is_empty()) {
                "Verified"
            } else {
                "Unknown"
            });
        }
        _ => return Ok("Unknown"),
    };
    Ok(if status { "Verified" } else { "Failed" })
}
