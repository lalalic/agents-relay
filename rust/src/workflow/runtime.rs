// Direct port of Node src/workflow/runtime.ts: mechanical Graph-authorized Job/Task state mutations, error and execution cleanup; never decides workflow transitions.
use super::{
    contracts::{classify_workflow_actions, empty_workflow_decision},
    mermaid::WorkflowEngine,
};
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{json, Value};
use std::time::SystemTime;
fn now() -> String {
    DateTime::<Utc>::from(SystemTime::now()).to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}
fn erase(value: &mut Value, key: &str) {
    if let Some(object) = value.as_object_mut() {
        object.shift_remove(key);
    }
}
fn set(value: &mut Value, key: &str, field: Value) {
    if let Some(object) = value.as_object_mut() {
        object.insert(key.into(), field);
    }
}
fn parse_date(value: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|date| date.timestamp_millis())
}
fn next_timestamp(previous: &Value, candidate: &str) -> String {
    let Some(previous) = previous.as_str().and_then(parse_date) else {
        return candidate.to_string();
    };
    let candidate =
        parse_date(candidate).unwrap_or_else(|| parse_date(&now()).expect("current time valid"));
    DateTime::<Utc>::from_timestamp_millis(candidate.max(previous + 1))
        .expect("valid timestamp range")
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}
pub fn graph_workflow_decision(
    engine: &WorkflowEngine,
    from: &str,
    event: &str,
    facts: &Value,
) -> Result<Value, String> {
    let enabled = engine.enabled_sync(from, event, facts)?;
    if enabled.is_empty() {
        return Ok(empty_workflow_decision("no_transition"));
    }
    if enabled.len() > 1 {
        return Ok(empty_workflow_decision("ambiguous"));
    }
    let transition = enabled[0];
    let classified = classify_workflow_actions(&transition.actions)?;
    Ok(
        json!({"accepted":true,"target":transition.to,"guard":transition.guard,"actions":transition.actions,
        "mutations":classified["mutations"],"effects":classified["effects"],"reason":"accepted"}),
    )
}
pub fn apply_task_mutation(task: &mut Value, mutation: &str, now_at: &str) -> Result<(), String> {
    match mutation {
        "mutation.clearError" => set(task, "error", Value::Null),
        "mutation.clearFailureReason" => erase(task, "failureReason"),
        "mutation.clearExecution" => set(task, "executionId", Value::Null),
        "mutation.markStartupOrphanedExhausted" => set(
            task,
            "error",
            json!("Orphaned after relayd restart after maximum attempts"),
        ),
        "mutation.markUnknownOutcome" => {
            set(task,"error",json!("Worker execution outcome is unknown; Troubleshooter diagnosis is required before retry."));
            set(task, "failureReason", json!("worker_outcome_unknown"));
        }
        "mutation.markPlannerUnavailable" => {
            set(task, "error", json!("No objective planner configured"))
        }
        "mutation.prepareNoStartFallback" => {
            let adapter = text(task, "adapter").to_string();
            if adapter != "chatgpt" && adapter != "z" {
                return Err("No-start fallback is only legal for ChatGPT/Z Workers".into());
            }
            let route = task.get("routing").cloned().unwrap_or(Value::Null);
            let selection = task.get("workerSelection").cloned().unwrap_or(Value::Null);
            let worker_id = selection
                .get("workerId")
                .filter(|item| !item.is_null())
                .cloned()
                .unwrap_or_else(|| json!(adapter));
            let original = task
                .get("executionId")
                .filter(|item| !item.is_null())
                .cloned()
                .unwrap_or(json!("missing"));
            let attempt = task.get("attempt").cloned().unwrap_or(Value::Null);
            let error = task
                .get("error")
                .filter(|value| !value.is_null())
                .cloned()
                .unwrap_or(json!(
                    "Worker failed without an accepted task.started event"
                ));
            let provider = route
                .get("provider")
                .filter(|value| !value.is_null())
                .cloned()
                .unwrap_or(json!("unknown"));
            let model = route
                .get("model")
                .filter(|value| !value.is_null())
                .cloned()
                .unwrap_or(json!("unknown"));
            let profile = route
                .get("profile")
                .filter(|value| {
                    !value.is_null() && value.as_str() != Some("") && value != &&json!(false)
                })
                .cloned();
            let mut previous =
                json!({"adapter":adapter,"workerId":worker_id,"provider":provider,"model":model});
            if let Some(profile) = profile.as_ref() {
                previous["profile"] = profile.clone();
            }
            set(
                task,
                "noStartFallback",
                json!({"failedExecutionId":original,"failedAttempt":attempt,"previous":previous,"reason":error,"at":now_at}),
            );
            let mut exclusion =
                json!({"adapter":adapter,"workerId":worker_id,"provider":provider,"model":model});
            if let Some(profile) = profile {
                exclusion["profile"] = profile;
            }
            exclusion["reason"] = json!("no_started_event");
            exclusion["at"] = json!(now_at);
            let mut exclusions = task
                .get("routingExclusions")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            exclusions.push(exclusion);
            set(task, "routingExclusions", json!(exclusions));
            set(task, "error", Value::Null);
            erase(task, "failureReason");
            for key in ["routing", "workerSelection"] {
                erase(task, key);
            }
            for key in ["executionId"] {
                set(task, key, Value::Null);
            }
        }
        "mutation.preparePlatformFallback" => {
            set(task, "error", Value::Null);
            erase(task, "failureReason");
            for key in ["routing", "workerSelection"] {
                erase(task, key);
            }
            for key in ["executionId"] {
                set(task, key, Value::Null);
            }
        }
        "mutation.quarantinePlatformFailure" => {
            for key in ["routing", "workerSelection"] {
                erase(task, key);
            }
            for key in ["executionId"] {
                set(task, key, Value::Null);
            }
            let classification = task
                .pointer("/platformFailure/classification")
                .and_then(Value::as_str)
                .unwrap_or("");
            set(
                task,
                "failureReason",
                json!(
                    if matches!(classification, "outcome_unknown" | "start_ack_timeout") {
                        "worker_outcome_unknown"
                    } else {
                        "worker_platform_failure"
                    }
                ),
            );
        }
        _ => {}
    }
    Ok(())
}
pub fn apply_task_graph_target(
    task: &mut Value,
    target: &str,
    timestamp: &str,
    authoritative_unblock: bool,
) -> Result<(), String> {
    let id = text(task, "id");
    let agent = text(task, "agentName");
    let state = text(task, "state");
    if target == "BLOCKED" && agent != "troubleshooter" {
        return Err(format!(
            "Only a Troubleshooter Task may become BLOCKED ({id})"
        ));
    }
    if state == "BLOCKED"
        && target == "QUEUED"
        && (!authoritative_unblock || agent != "troubleshooter")
    {
        return Err(format!(
            "Blocked Task {id} requires an authoritative Troubleshooter unblock before transition"
        ));
    }
    if state == "BLOCKED" && !matches!(target, "QUEUED" | "CANCELLED" | "BLOCKED") {
        return Err(format!(
            "Blocked Task {id} requires an authoritative Troubleshooter unblock before transition"
        ));
    }
    let updated = next_timestamp(&task["updatedAt"], timestamp);
    set(task, "state", json!(target));
    set(task, "updatedAt", json!(updated));
    Ok(())
}
pub fn apply_job_graph_target(job: &mut Value, target: &str, timestamp: &str) {
    let updated = next_timestamp(&job["updatedAt"], timestamp);
    set(job, "state", json!(target));
    set(job, "updatedAt", json!(updated));
}
pub fn apply_task_workflow_decision(
    task: &mut Value,
    decision: &Value,
    timestamp: &str,
) -> Result<(), String> {
    if decision.get("accepted") != Some(&Value::Bool(true))
        || decision.get("target").is_none_or(|value| value.is_null())
    {
        return Err(format!(
            "Cannot apply rejected workflow decision to task {}",
            text(task, "id")
        ));
    }
    let target = decision["target"].clone();
    set(task, "state", target);
    for mutation in decision["mutations"].as_array().into_iter().flatten() {
        apply_task_mutation(task, mutation.as_str().unwrap_or(""), timestamp)?;
    }
    let updated = next_timestamp(&task["updatedAt"], timestamp);
    set(task, "updatedAt", json!(updated));
    Ok(())
}
pub fn apply_job_workflow_decision(
    job: &mut Value,
    decision: &Value,
    timestamp: &str,
) -> Result<(), String> {
    if decision.get("accepted") != Some(&Value::Bool(true))
        || decision.get("target").is_none_or(|value| value.is_null())
    {
        return Err(format!(
            "Cannot apply rejected workflow decision to job {}",
            text(job, "id")
        ));
    }
    set(job, "state", decision["target"].clone());
    set(job, "updatedAt", json!(timestamp));
    Ok(())
}
pub fn apply_historical_job_compatibility_repair(
    job: &mut Value,
    target: &str,
    timestamp: &str,
) -> Result<(), String> {
    if !matches!(target, "COMPLETED" | "CANCELLED") {
        return Err(format!("Invalid historical Job repair target {target}"));
    }
    set(job, "state", json!(target));
    set(job, "updatedAt", json!(timestamp));
    Ok(())
}
