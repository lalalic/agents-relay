// Direct port of Node src/workflow/entity-creation.ts: validate declared Task dependencies,
// derive durable metadata and activate only by canonical Task/Job lifecycle Graph events.
use super::lifecycle::{dispatch_job_lifecycle_sync, dispatch_task_lifecycle_sync};
use crate::{dependency_validity::validate_dependency_validity, final_review_role::is_final_review_agent, task_title::derive_task_title};
use serde_json::{json, Value};
use std::path::Path;
fn dependencies_satisfied(job: &Value, deps: &[String]) -> bool {
    deps.iter().all(|dependency| {
        job["tasks"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|task| task["id"] == *dependency && task["state"] == "SUCCEEDED")
    })
}
fn validate_task_requirements(value: &Value) -> Result<(), String> {
    if value["adapter"] == "orchestrator" {
        return Err("New Tasks cannot use the Relay-internal orchestrator adapter; declare worker requirements and let Execution Router select the route".into());
    }
    if !value["workerRequirements"].is_null()
        && !value["workerRequirements"]["capabilities"].is_array()
    {
        return Err(format!(
            "Task {} workerRequirements.capabilities must be an array",
            value["id"].as_str().unwrap_or("undefined")
        ));
    }
    let dependencies = value["dependencies"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect::<Vec<_>>();
    let field = format!(
        "Task {} dependencyValidity",
        value["id"].as_str().unwrap_or("undefined")
    );
    validate_dependency_validity(&dependencies, &value["dependencyValidity"], &field)?;
    Ok(())
}
/// Match the Node Task constructor's immutable source-commit requirement.
/// A Task may not choose this policy via an input event or override flag.
fn source_commit_required(task: &Value) -> bool {
    let agent = task["agentName"].as_str();
    let graph_present = match task.get("agentGraph") {
        None | Some(Value::Null | Value::Bool(false)) => false,
        Some(Value::String(value)) => !value.is_empty(),
        Some(Value::Number(number)) => number.as_f64().unwrap_or(0.0) != 0.0,
        Some(_) => true,
    };
    task["output"]["kind"] == "task_pr"
        && task["kind"] != "planner"
        && !graph_present
        && !is_final_review_agent(agent)
        && !matches!(agent, Some("troubleshooter" | "planner" | "review-chair"))
}

pub fn create_task_entity(
    directory: &Path,
    job: &Value,
    value: &Value,
    defer: bool,
    timestamp: &str,
) -> Result<Value, String> {
    validate_task_requirements(value)?;
    let mut task = value.clone();
    let title = value["title"]
        .as_str()
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            let fallback = value["agentName"]
                .as_str()
                .filter(|name| !name.is_empty())
                .map(|name| format!("{name} task"))
                .unwrap_or_else(|| "Task".into());
            String::from_utf16_lossy(&derive_task_title(
                value["input"].as_str().unwrap_or(""),
                &fallback,
            ))
        });
    task["gitDeliveryRequired"] = json!(source_commit_required(value));
    task["title"] = json!(title);
    task["state"] = json!("DRAFT");
    if !defer {
        let deps = task["dependencies"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect::<Vec<_>>();
        dispatch_task_lifecycle_sync(
            directory,
            &mut task,
            "reconcile",
            &json!({"dependenciesSatisfied":dependencies_satisfied(job,&deps)}),
            timestamp,
        )?;
    }
    Ok(task)
}
pub fn create_job_entity(
    directory: &Path,
    value: &Value,
    activate: bool,
    timestamp: &str,
) -> Result<Value, String> {
    let mut job = value.clone();
    job["state"] = json!("DRAFT");
    if activate {
        dispatch_job_lifecycle_sync(directory, &mut job, "activate", &json!({}), timestamp)?;
    }
    Ok(job)
}
