// Node provenance: src/relayd-dashboard-actions.ts.
// Server-side overview binding and workspace controls ONLY. The Dashboard
// browser HTML, CSS and JavaScript remain untouched and are not implemented here.
use crate::{
    dashboard_actions::{
        dashboard_job_set_state, dashboard_task_action, dashboard_task_set_state,
    },
    job_task_id_sequence::allocate_entity_id,
    local_merge_lock::iso8601_now,
    workflow::lifecycle::dispatch_job_lifecycle_sync,
};
use serde_json::{json, Value};
use std::{collections::HashSet, path::Path};

fn field<'a>(value: &'a Value, name: &str) -> &'a str {
    value.get(name).and_then(Value::as_str).unwrap_or("")
}
fn tasks(job: &Value) -> &[Value] {
    job.get("tasks").and_then(Value::as_array)
        .map(Vec::as_slice).unwrap_or(&[])
}
fn is_terminal(job: &Value) -> bool {
    matches!(field(job, "state"), "COMPLETED" | "CANCELLED")
}
pub fn dashboard_overview(
    overviews: &[Value],
    job_id: &str,
    target: Option<&Value>,
) -> Option<Value> {
    overviews.iter().find(|row| {
        let job = &row["job"];
        if field(job, "id") != job_id { return false; }
        if let Some(repository) = target.and_then(|t|t.get("repository"))
            .and_then(Value::as_str).filter(|s|!s.is_empty()) {
            if field(job, "repository") != repository { return false; }
        }
        if let Some(pr) = target.and_then(|t|t.get("prNumber"))
            .and_then(Value::as_i64).filter(|n|*n!=0) {
            if job.get("prNumber").and_then(Value::as_i64) != Some(pr) { return false; }
        }
        true
    }).cloned()
}
pub fn require_dashboard_job(
    overviews: &[Value], job_id: &str, target: Option<&Value>,
) -> Result<Value, String> {
    dashboard_overview(overviews, job_id, target)
        .ok_or_else(||format!("Managed job {job_id} not found"))
}
/// For daemon dispatch. Actual job execution is always delegated to the
/// existing pool/Reconciler, which refreshes the durable SQLite result.
pub fn workspace_job_action_request(
    overviews: &[Value], job_id: &str, action: &str,
) -> Result<Value, String> {
    require_dashboard_job(overviews, job_id, None)?;
    if !matches!(action, "start" | "reconcile" | "cancel") {
        return Err(format!("Unsupported Job action {action}"));
    }
    if action == "reconcile" {
        return Ok(json!({"kind":"pool.reconcileLocalJob",
            "jobId":job_id,"reason":"control.job.reconcile"}));
    }
    Ok(json!({"kind":"dashboardJobAction","jobId":job_id,"action":action}))
}
/// Scope-check a Job state mutation to the visible immutable Job identity.
pub fn workspace_job_set_state(
    graph_directory: &Path, overviews: &[Value], job: &Value,
    target: Option<&Value>, state: &str,
) -> Result<(Value, bool), String> {
    let id = field(job, "id");
    require_dashboard_job(overviews, id, target)?;
    dashboard_job_set_state(graph_directory, job, state)
}

/// Construct Task-create mutation inside an authoritative SQLite mutateJob
/// transaction. Reserved IDs must come from Relay's native global sequence.
pub fn workspace_task_create_snapshot(
    graph_directory: &Path,
    store_directory: &Path,
    overviews: &[Value],
    current: &Value,
    supplied_task: &Value,
    idempotency_key: Option<&str>,
) -> Result<(Value, String, bool), String> {
    let job_id = field(current, "id").to_owned();
    require_dashboard_job(overviews, &job_id, None)?;
    if supplied_task.get("jobId").and_then(Value::as_str) != Some(&job_id) {
        return Err(format!("Task {} belongs to {}, not {}",
            field(supplied_task, "id"),field(supplied_task, "jobId"),job_id));
    }
    if is_terminal(current) {
        return Err(format!("Cannot create task on terminal job {} ({})",
            job_id,field(current,"state")));
    }
    if !field(supplied_task, "id").is_empty() {
        return Err("Task IDs are allocated by Relay and cannot be supplied".into());
    }
    let repository = field(current, "repository");
    let request_key = idempotency_key.map(|key|format!("{job_id}:{key}"));
    let id = allocate_entity_id(
        store_directory, repository, "task",
        request_key.as_deref(), &HashSet::new(),
    )?;
    let mut job = current.clone();
    if let Some(existing) = tasks(&job).iter().find(|task|field(task,"id")==id) {
        if idempotency_key.is_none()
            || existing.get("input") != supplied_task.get("input")
            || existing.get("output") != supplied_task.get("output") {
            return Err(format!("Task {id} already exists with a different definition or no retry key"));
        }
        return Ok((job, id, true));
    }
    let mut task = supplied_task.clone();
    task["id"] = json!(id);
    job.get_mut("tasks").and_then(Value::as_array_mut)
        .ok_or("Job snapshot missing Task array")?.push(task);
    let timestamp=iso8601_now();
    if field(&job,"state")=="DRAFT" {
        let decision=dispatch_job_lifecycle_sync(graph_directory,&mut job,
            "activate",&json!({}),&timestamp)?;
        if decision.get("accepted")!=Some(&Value::Bool(true)) {
            return Err(format!("Job {job_id} activation rejected"));
        }
    }
    job["updatedAt"] = json!(timestamp);
    Ok((job,id,false))
}
/// All Task mutations return control requests consumed by the existing daemon
/// Task dispatcher; the UI cannot directly write a Task lifecycle state.
pub fn workspace_task_action_request(
    overviews: &[Value], job: &Value, task_id: &str, action: &str,
) -> Result<Value, String> {
    require_dashboard_job(overviews, field(job, "id"), None)?;
    dashboard_task_action(job,task_id,action)
}
pub fn workspace_task_set_state_request(
    overviews: &[Value], job: &Value, task_id: &str,
    state: &str, target: Option<&Value>,
) -> Result<Option<Value>, String> {
    require_dashboard_job(overviews, field(job, "id"), target)?;
    dashboard_task_set_state(job,task_id,state)
}
