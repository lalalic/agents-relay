// Direct port of Node src/reconciler-cancellation.ts: effect orchestration only.
// It delegates each Task transition to the canonical task-lifecycle Graph and
// each durable write to caller callbacks, preserving cancellation order.
use crate::workflow::{
    definitions_v2::task_lifecycle_v2,
    dispatcher::{dispatch_workflow_graph_sync, DispatchOptions},
    runtime::apply_task_graph_target,
};
use chrono::{SecondsFormat, Utc};
use serde_json::{json, Value};
use std::path::Path;
fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("undefined")
}
fn now_iso() -> String {
    chrono::DateTime::<Utc>::from(std::time::SystemTime::now())
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn cancel_task_action(
    task: &mut Value,
    reason: &str,
    workflow_directory: &Path,
) -> Result<(), String> {
    if text(task, "kind") == "planner" {
        return Err(format!(
            "Legacy planner Task {} is read-only",
            text(task, "id")
        ));
    }
    let state = text(task, "state").to_string();
    let graph = task_lifecycle_v2(workflow_directory)?;
    let mut options = DispatchOptions::event(
        &state,
        "cancel",
        &json!({"troubleshooterTask":text(task,"agentName")=="troubleshooter"}),
        1,
    );
    options.observe = false;
    let decision = dispatch_workflow_graph_sync(
        &graph,
        &options,
        |_| false,
        |_, _| Ok(()),
        |_| Ok(json!({})),
        |_, _| Ok(()),
    )?;
    if decision["accepted"] != true {
        return Err(format!(
            "Task {} is not cancellable ({state})",
            text(task, "id")
        ));
    }
    let target = decision["target"]
        .as_str()
        .ok_or("missing cancellation target")?;
    apply_task_graph_target(task, target, &now_iso(), false)?;
    task["error"] = json!(reason);
    task["executionId"] = Value::Null;
    Ok(())
}

/// The callbacks are the Rust equivalents of DurableStore.savePlan/saveTask,
/// cancelPlanner and cancelExecutionGeneration. Caller owns transactional durability.
/// Job is the loaded authoritative snapshot; this function does not access default stores.
pub fn cancel_active_tasks(
    job: &mut Value,
    reason: &str,
    workflow_directory: &Path,
    mut cancel_planner: impl FnMut(&str),
    mut cancel_execution_generation: impl FnMut(&str, &str, Option<&str>),
    mut save_plan: impl FnMut(&Value) -> Result<(), String>,
    mut save_task: impl FnMut(&Value) -> Result<(), String>,
) -> Result<(), String> {
    let job_id = text(job, "id").to_string();
    if let Some(plans) = job.get_mut("plans").and_then(Value::as_array_mut) {
        for plan in plans
            .iter_mut()
            .filter(|plan| text(plan, "status") == "PLANNING")
        {
            let id = text(plan, "id").to_string();
            cancel_planner(&id);
            plan["status"] = json!("FAILED");
            plan["error"] = json!(reason);
            plan["assessment"] = json!(format!("Planning failed: {reason}"));
            plan["executionId"] = Value::Null;
            plan["updatedAt"] = json!(now_iso());
            save_plan(plan)?;
        }
    }
    if let Some(tasks) = job.get_mut("tasks").and_then(Value::as_array_mut) {
        for task in tasks.iter_mut().filter(|task| {
            text(task, "kind") != "planner"
                && !matches!(text(task, "state"), "SUCCEEDED" | "FAILED" | "CANCELLED")
        }) {
            let task_id = text(task, "id").to_string();
            let execution_id = task
                .get("executionId")
                .and_then(Value::as_str)
                .or_else(|| {
                    task["executionHistory"]
                        .as_array()
                        .and_then(|items| items.last())
                        .and_then(|entry| entry["id"].as_str())
                })
                .map(str::to_string);
            cancel_execution_generation(&job_id, &task_id, execution_id.as_deref());
            cancel_planner(&task_id);
            cancel_task_action(task, reason, workflow_directory)?;
            save_task(task)?;
        }
    }
    Ok(())
}
