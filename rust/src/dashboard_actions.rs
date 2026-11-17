// Node provenance: src/dashboard-actions.ts. Rust server-only action adapters.
// Browser HTML/CSS/JS remain the original, unmodified client assets.
use crate::{
    job_actions::apply_job_cancel_action,
    local_merge_lock::iso8601_now,
    workflow::{
        definitions_v2::job_lifecycle_v2,
        dispatcher::dispatch_workflow_target_override,
        runtime::apply_job_graph_target,
    },
};
use serde_json::{json, Value};
use std::path::Path;

fn value<'a>(source: &'a Value, key: &str) -> &'a str {
    source.get(key).and_then(Value::as_str).unwrap_or("")
}

fn require_task<'a>(job: &'a Value, task_id: &str) -> Result<&'a Value, String> {
    job.get("tasks").and_then(Value::as_array).into_iter().flatten()
        .find(|task| value(task, "id") == task_id)
        .ok_or_else(|| format!("Task {task_id} not found"))
}

/// The daemon routes this command to its existing Task Action dispatcher and
/// then returns the refreshed Job from SQLite. No browser logic is duplicated.
pub fn dashboard_task_action(
    job: &Value, task_id: &str, action: &str,
) -> Result<Value, String> {
    require_task(job, task_id)?;
    let command = match action {
        "retry" => "task.retry",
        "cancel" => "task.cancel",
        _ => return Err(format!("Unsupported dashboard Task action {action}")),
    };
    Ok(json!({"id":command,"jobId":job.get("id"),"taskId":task_id}))
}

/// Snapshot mutation is intended for atomic SQLite store application. The
/// Boolean indicates whether the existing external PR close effect is needed.
pub fn dashboard_job_set_state(
    directory: &Path, job: &Value, target: &str,
) -> Result<(Value, bool), String> {
    if target == "CANCELLED" {
        let next = if value(job, "state") == "CANCELLED" {
            job.clone()
        } else {
            apply_job_cancel_action(directory, job, None)?
        };
        let close_pr = next.pointer("/localMerge/sourceRef").is_none_or(Value::is_null);
        return Ok((next, close_pr));
    }
    if value(job, "state") == target {
        return Ok((job.clone(), false));
    }
    let runtime = job_lifecycle_v2(directory)?;
    let mut changed = job.clone();
    let from = value(job, "state").to_owned();
    let now = iso8601_now();
    dispatch_workflow_target_override(
        &runtime,
        &from,
        target,
        "job",
        |_, accepted_target| {
            apply_job_graph_target(&mut changed, accepted_target, &now);
            Ok(())
        },
    )?;
    Ok((changed, false))
}

/// Task states remain Graph-managed; only CANCELLED maps to the existing
/// canonical Task Action. Never force-write a browser-specified Task state.
pub fn dashboard_task_set_state(
    job: &Value, task_id: &str, target: &str,
) -> Result<Option<Value>, String> {
    let task = require_task(job, task_id)?;
    if value(task, "state") == target {
        return Ok(None);
    }
    if target != "CANCELLED" {
        return Err("Task lifecycle state is managed by Relay; use retry, cancel, or the Troubleshooter response flow".into());
    }
    dashboard_task_action(job, task_id, "cancel").map(Some)
}
