// src/troubleshooter-fallback.ts bounded fallback reducer. SQLite caller owns
// mutateJob transaction and idempotent commit. Human escalation is NOT ported.
use crate::local_merge_lock::iso8601_now;
use crate::workflow::lifecycle::dispatch_task_lifecycle_sync;
use regex::Regex;
use serde_json::{json, Value};
use std::path::Path;
const MARKER: &str = "[Relay execution fallback attempted]";
pub fn fallback_failed_troubleshooters(
    root: &Path,
    job: &mut Value,
) -> Result<Vec<String>, String> {
    let snapshot = job["tasks"].as_array().cloned().unwrap_or_default();
    let plans = job["plans"].as_array().cloned().unwrap_or_default();
    let mut queued = Vec::new();
    let pattern=Regex::new("(?i)worker_process_failed|worker_start_timeout|terminal_event_timeout|model.*not supported|unsupported.model|delivery|process.exited|provider").map_err(|e|e.to_string())?;
    for recovery in snapshot.iter().filter(|t| {
        t["agentName"] == "troubleshooter"
            && t["state"] == "FAILED"
            && t["attempt"].as_i64().unwrap_or(0) >= t["maxAttempts"].as_i64().unwrap_or(i64::MAX)
            && !t["input"].as_str().unwrap_or("").contains(MARKER)
    }) {
        let original = snapshot
            .iter()
            .find(|t| t["id"] == recovery["parentTaskId"]);
        let plan = plans.iter().find(|p| p["id"] == recovery["recoveryPlanId"]);
        if !original.is_some_and(|t| t["state"] == "FAILED")
            && !plan.is_some_and(|p| p["status"] == "FAILED")
        {
            continue;
        }
        if original.is_some_and(|t| {
            t["resolution"]["path"] == "same_job_dependency"
                && matches!(
                    t["resolution"]["state"].as_str(),
                    Some("waiting" | "active")
                )
        }) {
            continue;
        }
        let reason = format!(
            "{} {}",
            recovery["failureReason"].as_str().unwrap_or(""),
            recovery["error"].as_str().unwrap_or("")
        );
        if !pattern.is_match(&reason) {
            continue;
        }
        let Some(task) = job["tasks"]
            .as_array_mut()
            .and_then(|v| v.iter_mut().find(|t| t["id"] == recovery["id"]))
        else {
            continue;
        };
        if task["state"] != "FAILED" || task["input"].as_str().unwrap_or("").contains(MARKER) {
            continue;
        }
        let decision =
            dispatch_task_lifecycle_sync(root, task, "retry", &json!({}), &iso8601_now())?;
        if decision["accepted"] != true {
            return Err(format!(
                "Fallback retry rejected for {}",
                task["id"].as_str().unwrap_or("undefined")
            ));
        }
        let attempts = task["attempt"].as_i64().unwrap_or(0);
        task["maxAttempts"] = json!(task["maxAttempts"].as_i64().unwrap_or(0).max(attempts + 1));
        task["input"]=json!(format!("{}\n\n{MARKER} Retry diagnosis with Codex config default model; report valid resolution or explicit blocker.",
            task["input"].as_str().unwrap_or("")));
        task["routing"] = json!({"provider":"","model":"","decidedBy":"troubleshooter-fallback:codex-config-default",
            "decidedAt":iso8601_now()});
        if let Some(obj) = task.as_object_mut() {
            obj.remove("workerSelection");
        }
        task["leaseOwner"] = Value::Null;
        task["leaseExpiresAt"] = Value::Null;
        task["executionId"] = Value::Null;
        queued.push(task["id"].as_str().unwrap_or("").to_owned());
    }
    Ok(queued)
}
/// Commit retry marker, Graph Task transition and fallback routing as one
/// authoritative Job mutation. A failed persistence operation cannot leave a
/// retried Task visible or report a Task as queued.
pub fn fallback_failed_troubleshooters_atomic<W, E>(
    store: &mut crate::relay_workflow_operations::SQLiteWorkflowOperations<'_, W, E>,
    graph_dir: &Path,
    job_id: &str,
) -> Result<Vec<String>, String>
where
    W: FnMut(&Value, &str) -> Result<(), String>,
    E: FnMut(&Value, &str) -> Result<(), String>,
{
    let mut queued = Vec::new();
    store.mutate_job(job_id, |mut job| {
        queued = fallback_failed_troubleshooters(graph_dir, &mut job)?;
        Ok(job)
    })?;
    Ok(queued)
}

/// Durable human action-gate candidates. The Core must still submit these
/// through the authoritative task-recovery escalation API; merely identifying
/// a candidate is not an escalation nor an authorized human response.
pub fn exhausted_troubleshooter_escalations(job: &Value) -> Vec<Value> {
    let tasks = job["tasks"].as_array().cloned().unwrap_or_default();
    let plans = job["plans"].as_array().cloned().unwrap_or_default();
    tasks.iter().filter_map(|recovery| {
        if recovery["agentName"] != "troubleshooter" || recovery["state"] != "FAILED"
            || recovery["attempt"].as_i64().unwrap_or(0)
                < recovery["maxAttempts"].as_i64().unwrap_or(i64::MAX)
            || recovery.get("escalation").is_some_and(|v| !v.is_null())
        { return None; }
        let original = tasks.iter().find(|task| task["id"] == recovery["parentTaskId"]);
        let plan = plans.iter().find(|plan| plan["id"] == recovery["recoveryPlanId"]);
        if !original.is_some_and(|task| task["state"] == "FAILED")
            && !plan.is_some_and(|plan| plan["status"] == "FAILED")
        { return None; }
        if original.is_some_and(|task| {
            task["resolution"]["path"] == "same_job_dependency"
                && matches!(task["resolution"]["state"].as_str(), Some("waiting" | "active"))
        }) { return None; }
        let subject = if let Some(original) = original {
            format!("Task {}", original["id"].as_str().unwrap_or("undefined"))
        } else {
            format!("Plan {}", plan?["id"].as_str().unwrap_or("undefined"))
        };
        let failure = original.and_then(|original| original["error"].as_str()
            .or_else(|| original["failureReason"].as_str()))
            .or_else(|| plan.and_then(|plan| plan["error"].as_str()))
            .unwrap_or("unknown");
        let last = recovery["error"].as_str()
            .or_else(|| recovery["failureReason"].as_str())
            .unwrap_or("unknown");
        let recovery_id = recovery["id"].as_str().unwrap_or("undefined");
        Some(json!({
            "taskId": recovery["id"],
            "requiredAction":format!("Inspect {subject} and Troubleshooter {recovery_id}; correct provider/runtime or supply a concrete recovery decision and supporting evidence."),
            "resolutionCondition":format!("User supplies a corrective action or verified recovery instructions for {subject}."),
            "context":format!("Automatic Troubleshooter {recovery_id} could not produce a verified resolution after {} attempts. Last failure: {last}. Original {subject}: {failure}.",
                recovery["attempt"]),
        }))
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn filters_unrelated() {
        let mut job = json!({"tasks":[]});
        assert!(fallback_failed_troubleshooters(Path::new("/tmp"), &mut job)
            .unwrap()
            .is_empty());
    }
}
