// Direct port of src/task-transitions.ts: all policy decisions delegate to
// the canonical Graph lifecycle; completion uses existing runtime-status selection.
use crate::{
    final_review_role::is_final_review_agent,
    runtime_status,
    workflow::{lifecycle, runtime, task_reconcile},
};
use serde_json::Value;
use std::{future::Future, path::Path};
/// A completed immutable-head Final Review is independent evidence that the
/// current code passed acceptance. Historical failed Planner rounds must not
/// block the merge after that independent review. Do not accept a loose
/// review.outcome field without the matching successful Reviewer Task.
pub fn latest_head_approved_by_final_review(job:&Value)->bool{
    if job["reviewEnabled"]==false{return false;}
    let review=&job["review"];
    let head=review["headSha"].as_str().unwrap_or("");
    let reviewer_id=review["taskId"].as_str().unwrap_or("");
    if head.is_empty()||reviewer_id.is_empty()||review["outcome"]!="approved"
        ||job["headSha"]!=head{return false;}
    job["tasks"].as_array().into_iter().flatten().any(|task|
        task["id"]==reviewer_id
            &&is_final_review_agent(task["agentName"].as_str())
            &&task["state"]=="SUCCEEDED"
            &&task["reviewHeadSha"]==head
            &&task.pointer("/result/data/verdict")==Some(&Value::String("approved".into()))
            &&task.pointer("/result/data/head_sha")==Some(&Value::String(head.into())))
}
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
    let coordinator = runtime_status::coordinator_task(job);
    let coordinator_satisfied = coordinator.is_some_and(|task| task["state"] == "SUCCEEDED");
    let implementation = runtime_status::implementation_tasks(job);
    let active_plan=plans.into_iter().flatten().any(|p|p["status"]=="PLANNING");
    let final_review_satisfied=!active_plan&&latest_head_approved_by_final_review(job);
    // A historical stray Plan cannot supersede the authoritative DAG. An
    // actually active Plan still fences completion until it is terminal.
    let acceptance = if coordinator.is_some() {
        coordinator_satisfied && !active_plan
            && (no_plans || !review || final_review_satisfied)
    } else {
        plan_satisfied || legacy_satisfied || final_review_satisfied
    };
    acceptance && !implementation.is_empty()
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

/// Node-equivalent transitionTaskEvent: Graph-authorized state change, awaited
/// durable persistence, then each mutation or external effect in Graph order.
/// The caller supplies the atomic store writer; no workflow policy is copied.
pub async fn transition_task_event_async<Effect, EFut, Persist, PFut>(
    directory: &Path,
    task: &mut Value,
    event: &str,
    context: &Value,
    timestamp: &str,
    mut execute_effect: Effect,
    mut persist: Persist,
) -> Result<Value, String>
where
    Effect: FnMut(String) -> EFut,
    EFut: Future<Output = Result<(), String>>,
    Persist: FnMut(Value) -> PFut,
    PFut: Future<Output = Result<(), String>>,
{
    let from = task["state"].as_str().unwrap_or("undefined").to_owned();
    let decision = lifecycle::decide_task_lifecycle(directory, task, event, context)?;
    if decision["accepted"] != true || decision["target"].is_null() {
        return Err(if decision["reason"] == "ambiguous" {
            format!("Ambiguous workflow transition from {from} on {event}")
        } else {
            format!("No enabled workflow transition from {from} on {event}")
        });
    }
    let target = decision["target"]
        .as_str()
        .ok_or("Graph Task target missing")?;
    let unblock = event == "task.unblocked" && task["agentName"] == "troubleshooter";
    runtime::apply_task_graph_target(task, target, timestamp, unblock)?;
    persist(task.clone()).await?;
    for action in decision["actions"].as_array().into_iter().flatten() {
        let action = action.as_str().ok_or("Graph Task action missing")?;
        if action.starts_with("mutation.") {
            runtime::apply_task_mutation(task, action, timestamp)?;
        } else {
            execute_effect(action.to_owned()).await?;
        }
    }
    Ok(decision)
}

/// Node-equivalent transitionJobEvent: persist Graph target before awaiting
/// side effects; reject an ineligible event before any callback is invoked.
pub async fn transition_job_event_async<Effect, EFut, Persist, PFut>(
    directory: &Path,
    job: &mut Value,
    event: &str,
    context: &Value,
    timestamp: &str,
    mut execute_effect: Effect,
    mut persist: Persist,
) -> Result<Value, String>
where
    Effect: FnMut(String) -> EFut,
    EFut: Future<Output = Result<(), String>>,
    Persist: FnMut(Value) -> PFut,
    PFut: Future<Output = Result<(), String>>,
{
    let from = job["state"].as_str().unwrap_or("undefined").to_owned();
    let decision = lifecycle::decide_job_lifecycle(directory, job, event, context)?;
    if decision["accepted"] != true || decision["target"].is_null() {
        return Err(if decision["reason"] == "ambiguous" {
            format!("Ambiguous workflow transition from {from} on {event}")
        } else {
            format!("No enabled workflow transition from {from} on {event}")
        });
    }
    let target = decision["target"]
        .as_str()
        .ok_or("Graph Job target missing")?;
    runtime::apply_job_graph_target(job, target, timestamp);
    persist(job.clone()).await?;
    for action in decision["actions"].as_array().into_iter().flatten() {
        execute_effect(
            action
                .as_str()
                .ok_or("Graph Job action missing")?
                .to_owned(),
        )
        .await?;
    }
    Ok(decision)
}
