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
