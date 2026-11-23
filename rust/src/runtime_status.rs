// Direct head-to-head port of Node src/runtime-status.ts. All status decisions derive from the durable Job/Task view, never an external PR state.
use crate::final_review_role::is_final_review_agent;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64() != Some(0.0),
        _ => true,
    }
}
fn task_rows(job: &Value) -> Vec<&Value> {
    job.get("tasks")
        .and_then(Value::as_array)
        .map(|items| items.iter().collect())
        .unwrap_or_default()
}
fn stale_targeted_revision_ids(job: &Value) -> HashSet<String> {
    job.get("reviewRevisionRequests")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|row| text(row, "status") == "stale")
        .filter_map(|row| row.get("revisionTaskId"))
        .filter(|id| truthy(Some(id)))
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

pub fn is_superseded(task: &Value, by_id: &HashMap<String, Value>) -> bool {
    let state = text(task, "state");
    if state == "CANCELLED"
        && task.pointer("/resolution/path") == Some(&Value::String("cancel_supersede".into()))
        && task.pointer("/resolution/state") == Some(&Value::String("resolved".into()))
    {
        return true;
    }
    if state != "FAILED"
        || task
            .pointer("/resolutionClassification/kind")
            .and_then(Value::as_str)
            != Some("superseded")
    {
        return false;
    }
    let Some(classification) = task.get("resolutionClassification") else {
        return false;
    };
    let target = text(classification, "targetTaskId");
    if target.trim().is_empty()
        || text(classification, "evidence").trim().is_empty()
        || text(classification, "reason").trim().is_empty()
    {
        return false;
    }
    by_id
        .get(target)
        .is_some_and(|success| text(success, "state") == "SUCCEEDED")
}

pub fn implementation_tasks(job: &Value) -> Vec<Value> {
    let tasks = task_rows(job);
    let mut by_id = HashMap::new();
    for task in &tasks {
        if let Some(id) = task.get("id").and_then(Value::as_str) {
            by_id.insert(id.to_owned(), (*task).clone());
        }
    }
    let stale = stale_targeted_revision_ids(job);
    tasks
        .into_iter()
        .filter(|task| {
            let name = task.get("agentName").and_then(Value::as_str);
            text(task, "kind") != "planner"
                && !is_final_review_agent(name)
                && name != Some("troubleshooter")
                && !is_superseded(task, &by_id)
                && !stale.contains(text(task, "id"))
                && (text(task, "state") != "DRAFT" || truthy(task.get("revision")))
        })
        .cloned()
        .collect()
}
pub fn implementation_complete(job: &Value) -> bool {
    let tasks = implementation_tasks(job);
    !tasks.is_empty() && tasks.iter().all(|task| text(task, "state") == "SUCCEEDED")
}

pub fn derive_job_runtime_status(job: &Value, _pr_state: &str) -> &'static str {
    match text(job, "state") {
        "CANCELLED" => return "CANCELLED",
        "COMPLETED" => return "COMPLETED",
        "DRAFT" => return "IDLE",
        _ => {}
    }
    let tasks = task_rows(job);
    let waiting = tasks
        .iter()
        .any(|task| text(task, "state") == "AWAITING_DECISION");
    let leased = tasks.iter().any(|task| {
        text(task, "state") == "RUNNING"
            && task.get("executionId") != Some(&Value::Null)
    });
    if waiting && !leased {
        return "WAITING";
    }
    let plan = job
        .get("plans")
        .and_then(Value::as_array)
        .and_then(|rows| rows.last());
    let planner_failed = plan.is_some_and(|plan| text(plan, "status") == "FAILED")
        && !tasks
            .iter()
            .any(|task| matches!(text(task, "state"), "QUEUED" | "RUNNING"));
    let planner_running = plan.is_some_and(|plan| text(plan, "status") == "PLANNING");
    let implementation = implementation_tasks(job);
    if implementation
        .iter()
        .any(|task| text(task, "state") == "RUNNING")
    {
        return "RUNNING";
    }
    if implementation
        .iter()
        .any(|task| text(task, "state") == "QUEUED")
    {
        return "QUEUED";
    }
    let review_running = tasks.iter().any(|task| {
        is_final_review_agent(task.get("agentName").and_then(Value::as_str))
            && text(task, "state") == "RUNNING"
    });
    if job.pointer("/review/outcome").and_then(Value::as_str) == Some("approved") {
        return "MERGE_PENDING";
    }
    if review_running {
        return "REVIEWING";
    }
    if tasks.iter().any(|task| text(task, "state") == "RUNNING") {
        return "RUNNING";
    }
    if tasks.iter().any(|task| text(task, "state") == "QUEUED") {
        return "QUEUED";
    }
    if tasks.iter().any(|task| text(task, "state") == "BLOCKED") {
        return "BLOCKED";
    }
    let stale = stale_targeted_revision_ids(job);
    if tasks
        .iter()
        .any(|task| text(task, "state") == "FAILED" && !stale.contains(text(task, "id")))
    {
        return "FAILED";
    }
    if tasks
        .iter()
        .any(|task| matches!(text(task, "state"), "AWAITING_DECISION" | "DRAFT"))
    {
        return "WAITING";
    }
    if planner_failed {
        return "FAILED";
    }
    if planner_running {
        return "RUNNING";
    }
    if job.get("reviewEnabled") == Some(&Value::Bool(false)) && implementation_complete(job) {
        return "MERGE_PENDING";
    }
    "IDLE"
}
