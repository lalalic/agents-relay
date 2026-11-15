//! Read-only Node-compatible Workflow predicate verification from durable SQLite.
//! No caller-supplied facts are accepted as authority and no mutations occur.
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::Path;

fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::String(s) => !s.is_empty(),
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        _ => true,
    }
}
fn superseded(task: &Value, by_id: &HashMap<&str, &Value>) -> bool {
    if task["state"] == "CANCELLED"
        && task["resolution"]["path"] == "cancel_supersede"
        && task["resolution"]["state"] == "resolved"
    {
        return true;
    }
    let c = &task["resolutionClassification"];
    if task["state"] != "FAILED" || c["kind"] != "superseded" {
        return false;
    }
    let valid = ["targetTaskId", "evidence", "reason"]
        .iter()
        .all(|key| c[*key].as_str().is_some_and(|s| !s.trim().is_empty()));
    valid
        && c["targetTaskId"]
            .as_str()
            .and_then(|id| by_id.get(id))
            .is_some_and(|candidate| candidate["state"] == "SUCCEEDED")
}
fn completion_gate(job: &Value) -> bool {
    let tasks = job["tasks"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    let plans = job["plans"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    let latest = plans
        .iter()
        .max_by_key(|p| p["round"].as_i64().unwrap_or(0));
    let review = job["reviewEnabled"] != false;
    let plan_satisfied = latest.is_some_and(|p| {
        p["status"] == "SUCCEEDED" && (review || p["objectiveStatus"] == "satisfied")
    });
    let legacy_satisfied = plans.is_empty()
        && tasks.iter().any(|task| {
            task["kind"] == "planner"
                && task["state"] == "SUCCEEDED"
                && (review || task["plannerResult"]["objective_status"] == "satisfied")
        });
    let coordinator_satisfied = plans.is_empty()
        && tasks.iter().any(|task| {
            task["title"] == "Coordinator"
                && truthy(&task["agentGraph"])
                && task["state"] == "SUCCEEDED"
        });
    let by_id = tasks
        .iter()
        .filter_map(|task| task["id"].as_str().map(|id| (id, task)))
        .collect::<HashMap<_, _>>();
    let stale_revisions = job["reviewRevisionRequests"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|req| req["status"] == "stale")
        .filter_map(|req| req["revisionTaskId"].as_str())
        .collect::<HashSet<_>>();
    let implementation = tasks
        .iter()
        .filter(|task| {
            task["kind"] != "planner"
                && !matches!(
                    task["agentName"].as_str(),
                    Some("job-acceptance-reviewer" | "reviewer" | "troubleshooter")
                )
                && !superseded(task, &by_id)
                && task["id"]
                    .as_str()
                    .is_none_or(|id| !stale_revisions.contains(id))
                && (task["state"] != "DRAFT" || truthy(&task["revision"]))
        })
        .collect::<Vec<_>>();
    (plan_satisfied || legacy_satisfied || coordinator_satisfied)
        && !implementation.is_empty()
        && implementation
            .iter()
            .all(|task| task["state"] == "SUCCEEDED")
}
pub fn run(opts: &HashMap<String, String>) -> Result<Value, String> {
    let path = opts.get("--sqlite").ok_or("verify requires --sqlite")?;
    let job_id = opts.get("--job").ok_or("verify requires --job")?;
    let condition = opts
        .get("--condition")
        .ok_or("verify requires --condition")?;
    let allowed = [
        "task.queued",
        "task.succeeded",
        "task.failed",
        "task.routing-cleared",
        "task.execution-stopped",
        "job.objective-verified",
        "job.completed",
    ];
    if !Path::new(path).is_file() || !allowed.contains(&condition.as_str()) {
        return Err("verify requires existing --sqlite, --job and supported --condition".into());
    }
    let db = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| e.to_string())?;
    db.execute_batch("PRAGMA query_only=ON")
        .map_err(|e| e.to_string())?;
    let data: Option<String> = db
        .query_row(
            "SELECT json FROM job_snapshot WHERE job_id=?1",
            [job_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let task_id = opts
        .get("--task")
        .map(String::as_str)
        .filter(|s| !s.is_empty());
    let outcome = if let Some(data) = data {
        let job: Value =
            serde_json::from_str(&data).map_err(|e| format!("invalid durable Job JSON: {e}"))?;
        match condition.as_str() {
            "job.objective-verified" => {
                if completion_gate(&job) {
                    "Verified"
                } else {
                    "Failed"
                }
            }
            "job.completed" => {
                if job["state"] == "COMPLETED" && completion_gate(&job) {
                    "Verified"
                } else {
                    "Failed"
                }
            }
            other => {
                let task = job["tasks"]
                    .as_array()
                    .and_then(|all| all.iter().find(|task| task["id"].as_str() == task_id));
                if let Some(task) = task {
                    match other {
                        "task.queued" => {
                            if task["state"] == "QUEUED" {
                                "Verified"
                            } else {
                                "Failed"
                            }
                        }
                        "task.succeeded" => {
                            if task["state"] == "SUCCEEDED" {
                                "Verified"
                            } else {
                                "Failed"
                            }
                        }
                        "task.failed" => {
                            if task["state"] == "FAILED" {
                                "Verified"
                            } else {
                                "Failed"
                            }
                        }
                        "task.routing-cleared" => {
                            if task.get("executionId").is_some_and(Value::is_null)
                                && !truthy(&task["leaseOwner"])
                            {
                                "Verified"
                            } else {
                                "Failed"
                            }
                        }
                        "task.execution-stopped" => {
                            let execution = opts
                                .get("--execution")
                                .map(String::as_str)
                                .filter(|s| !s.is_empty());
                            if let Some(execution) = execution {
                                if task["executionId"].as_str() == Some(execution) {
                                    "Failed"
                                } else if task["executionHistory"]
                                    .as_array()
                                    .is_none_or(|hist| !hist.iter().any(|e| e["id"] == execution))
                                {
                                    "Unknown"
                                } else {
                                    let exists:i64=db.query_row(
                                        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='execution_process')",
                                        [],|row|row.get(0)).map_err(|e|e.to_string())?;
                                    if exists == 0 {
                                        "Unknown"
                                    } else {
                                        let ended:Option<Option<String>>=db.query_row(
                                            "SELECT ended_at FROM execution_process WHERE job_id=?1 AND task_id=?2 AND execution_id=?3",
                                            rusqlite::params![job_id,task_id,execution],
                                            |row|row.get(0)
                                        ).optional().map_err(|e|e.to_string())?;
                                        if ended.flatten().is_some_and(|s| !s.is_empty()) {
                                            "Verified"
                                        } else {
                                            "Unknown"
                                        }
                                    }
                                }
                            } else {
                                "Unknown"
                            }
                        }
                        _ => "Unknown",
                    }
                } else {
                    "Unknown"
                }
            }
        }
    } else {
        "Unknown"
    };
    Ok(json!({"condition":condition,"jobId":job_id,"taskId":task_id,"outcome":outcome}))
}
