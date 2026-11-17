// Direct port of src/task-transitions.ts: all policy decisions delegate to
// the canonical Graph lifecycle; completion uses existing runtime-status selection.
use crate::{
    runtime_status,
    workflow::{lifecycle, task_reconcile},
};
use serde_json::Value;
use std::path::Path;
pub fn completion_gate_satisfied(job: &Value) -> bool {
    let plans = job["plans"].as_array();
    let latest = plans.and_then(|plans| {
        plans.iter().max_by(|a, b| {
            a["round"]
                .as_f64()
                .unwrap_or(0.0)
                .partial_cmp(&b["round"].as_f64().unwrap_or(0.0))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
    });
    let review = job.get("reviewEnabled") != Some(&Value::Bool(false));
    let plan_satisfied = latest.is_some_and(|plan| {
        plan["status"] == "SUCCEEDED" && (review || plan["objectiveStatus"] == "satisfied")
    });
    let no_plans = plans.is_none_or(Vec::is_empty);
    let tasks = job["tasks"].as_array();
    let legacy_satisfied = no_plans
        && tasks.into_iter().flatten().any(|task| {
            task["kind"] == "planner"
                && task["state"] == "SUCCEEDED"
                && (review
                    || task.pointer("/plannerResult/objective_status")
                        == Some(&Value::String("satisfied".into())))
        });
    let coordinator_satisfied = no_plans
        && tasks.into_iter().flatten().any(|task| {
            task["title"] == "Coordinator"
                && task
                    .get("agentGraph")
                    .is_some_and(|graph| !graph.is_null() && graph != false)
                && task["state"] == "SUCCEEDED"
        });
    let implementation = runtime_status::implementation_tasks(job);
    (plan_satisfied || legacy_satisfied || coordinator_satisfied)
        && !implementation.is_empty()
        && implementation
            .iter()
            .all(|task| task["state"] == "SUCCEEDED")
}
pub fn refresh_task_dependencies(
    directory: &Path,
    job: &mut Value,
    timestamp: &str,
) -> Result<(), String> {
    if job
        .get("pause")
        .is_some_and(|pause| !pause.is_null() && pause != false)
    {
        return Ok(());
    }
    task_reconcile::reconcile_task_dependencies(directory, job, timestamp)
}
pub fn extend_retry_budget(
    attempt: f64,
    max_attempts: f64,
    window_size: f64,
) -> Result<f64, String> {
    if !window_size.is_finite() || window_size.fract() != 0.0 || window_size < 1.0 {
        return Err("Retry window size must be a positive integer".into());
    }
    let used = attempt.max(max_attempts);
    Ok(window_size.max(((used / window_size).floor() + 1.0) * window_size))
}
pub fn try_transition_task_event(
    directory: &Path,
    task: &mut Value,
    event: &str,
    context: &Value,
    timestamp: &str,
) -> Result<Value, String> {
    lifecycle::dispatch_task_lifecycle_sync(directory, task, event, context, timestamp)
}
pub fn transition_task_event(
    directory: &Path,
    task: &mut Value,
    event: &str,
    context: &Value,
    timestamp: &str,
) -> Result<Value, String> {
    let from = task["state"].as_str().unwrap_or("undefined").to_owned();
    let decision = try_transition_task_event(directory, task, event, context, timestamp)?;
    if decision["accepted"] != true || decision["target"].is_null() {
        return Err(if decision["reason"] == "ambiguous" {
            format!("Ambiguous workflow transition from {from} on {event}")
        } else {
            format!("No enabled workflow transition from {from} on {event}")
        });
    }
    Ok(decision)
}
pub fn transition_job_event(
    directory: &Path,
    job: &mut Value,
    event: &str,
    context: &Value,
    timestamp: &str,
) -> Result<Value, String> {
    let from = job["state"].as_str().unwrap_or("undefined").to_owned();
    let decision =
        lifecycle::dispatch_job_lifecycle_sync(directory, job, event, context, timestamp)?;
    if decision["accepted"] != true || decision["target"].is_null() {
        return Err(if decision["reason"] == "ambiguous" {
            format!("Ambiguous workflow transition from {from} on {event}")
        } else {
            format!("No enabled workflow transition from {from} on {event}")
        });
    }
    Ok(decision)
}
