// Direct port of Node src/workflow/lifecycle.ts: Graph-owned lifecycle decision and
// mechanical state/mutation application. Never creates a second workflow policy.
use super::{
    contracts::{classify_workflow_actions, empty_workflow_decision},
    definitions_v2::{job_lifecycle_v2, task_lifecycle_v2},
    graph_v2::GraphRuntime,
    runtime::{apply_job_graph_target, apply_task_graph_target, apply_task_mutation},
};
use serde_json::{json, Value};
use std::path::Path;
fn facts_for(task: &Value, facts: &Value, dispatch: bool) -> Value {
    let mut facts = facts.clone();
    if !facts.is_object() {
        facts = json!({});
    }
    facts["troubleshooterTask"] = json!(task["agentName"] == "troubleshooter");
    // Read-only decisions use Node's default. Actual dispatch is fail-closed
    // for source Tasks unless their current execution has a verified Git receipt.
    let verified = if dispatch {
        task["gitDeliveryRequired"] != true || facts["sourceDeliveryVerified"] == true
    } else {
        facts["sourceDeliveryVerified"] != false
    };
    facts["sourceDeliveryVerified"] = json!(verified);
    facts
}
fn graph_decision(
    runtime: &GraphRuntime,
    state: &str,
    event: &str,
    facts: &Value,
) -> Result<Value, String> {
    runtime.evaluate_sync(&json!({"currentState":state,"input":{"transport":"event","id":event,"payload":{}},"durableFacts":facts}))
}
fn workflow_decision(decision: &Value, actions: &[String]) -> Result<Value, String> {
    if decision["accepted"] != true {
        let reason = if decision["reason"] == "ambiguous" {
            "ambiguous"
        } else {
            "no_transition"
        };
        return Ok(empty_workflow_decision(reason));
    }
    let mut value = json!({"accepted":true,"target":decision["target"],"guard":null,
        "actions":actions,"reason":"accepted"});
    let classified = classify_workflow_actions(actions)?;
    value["mutations"] = classified["mutations"].clone();
    value["effects"] = classified["effects"].clone();
    Ok(value)
}
fn action_ids(decision: &Value) -> Vec<String> {
    decision["actions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|value| value["id"].as_str().map(str::to_owned))
        .collect()
}
pub fn decide_task_lifecycle(
    directory: &Path,
    task: &Value,
    event: &str,
    facts: &Value,
) -> Result<Value, String> {
    let runtime = task_lifecycle_v2(directory)?;
    let decision = graph_decision(
        &runtime,
        task["state"].as_str().unwrap_or(""),
        event,
        &facts_for(task, facts, false),
    )?;
    workflow_decision(&decision, &action_ids(&decision))
}
pub fn decide_job_lifecycle(
    directory: &Path,
    job: &Value,
    event: &str,
    facts: &Value,
) -> Result<Value, String> {
    let runtime = job_lifecycle_v2(directory)?;
    let decision = graph_decision(&runtime, job["state"].as_str().unwrap_or(""), event, facts)?;
    workflow_decision(&decision, &action_ids(&decision))
}
fn task_dispatch<Effect, Persist>(
    directory: &Path,
    task: &mut Value,
    event: &str,
    facts: &Value,
    timestamp: &str,
    mut effect: Effect,
    mut persist: Persist,
) -> Result<Value, String>
where
    Effect: FnMut(&str) -> Result<(), String>,
    Persist: FnMut(&Value) -> Result<(), String>,
{
    let runtime = task_lifecycle_v2(directory)?;
    let initial = task["state"].as_str().unwrap_or("").to_string();
    let decision = graph_decision(&runtime, &initial, event, &facts_for(task, facts, true))?;
    if decision["accepted"] != true {
        return workflow_decision(&decision, &[]);
    }
    let actions = action_ids(&decision);
    apply_task_graph_target(
        task,
        decision["target"].as_str().unwrap_or(""),
        timestamp,
        event == "task.unblocked" && task["agentName"] == "troubleshooter",
    )?;
    persist(task)?;
    for action in &actions {
        if action.starts_with("mutation.") {
            apply_task_mutation(task, action, timestamp)?;
        } else {
            effect(action)?;
        }
    }
    workflow_decision(&decision, &actions)
}
fn job_dispatch<Effect, Persist>(
    directory: &Path,
    job: &mut Value,
    event: &str,
    facts: &Value,
    timestamp: &str,
    mut effect: Effect,
    mut persist: Persist,
) -> Result<Value, String>
where
    Effect: FnMut(&str) -> Result<(), String>,
    Persist: FnMut(&Value) -> Result<(), String>,
{
    let runtime = job_lifecycle_v2(directory)?;
    let decision = graph_decision(&runtime, job["state"].as_str().unwrap_or(""), event, facts)?;
    if decision["accepted"] != true {
        return workflow_decision(&decision, &[]);
    }
    let actions = action_ids(&decision);
    apply_job_graph_target(job, decision["target"].as_str().unwrap_or(""), timestamp);
    persist(job)?;
    for action in &actions {
        effect(action)?;
    }
    workflow_decision(&decision, &actions)
}
pub fn dispatch_task_lifecycle_sync(
    directory: &Path,
    task: &mut Value,
    event: &str,
    facts: &Value,
    timestamp: &str,
) -> Result<Value, String> {
    task_dispatch(
        directory,
        task,
        event,
        facts,
        timestamp,
        |_| Ok(()),
        |_| Ok(()),
    )
}
pub async fn dispatch_task_lifecycle<Effect, Persist>(
    directory: &Path,
    task: &mut Value,
    event: &str,
    facts: &Value,
    timestamp: &str,
    effect: Effect,
    persist: Persist,
) -> Result<Value, String>
where
    Effect: FnMut(&str) -> Result<(), String>,
    Persist: FnMut(&Value) -> Result<(), String>,
{
    task_dispatch(directory, task, event, facts, timestamp, effect, persist)
}
pub fn dispatch_job_lifecycle_sync(
    directory: &Path,
    job: &mut Value,
    event: &str,
    facts: &Value,
    timestamp: &str,
) -> Result<Value, String> {
    job_dispatch(
        directory,
        job,
        event,
        facts,
        timestamp,
        |_| Ok(()),
        |_| Ok(()),
    )
}
pub async fn dispatch_job_lifecycle<Effect, Persist>(
    directory: &Path,
    job: &mut Value,
    event: &str,
    facts: &Value,
    timestamp: &str,
    effect: Effect,
    persist: Persist,
) -> Result<Value, String>
where
    Effect: FnMut(&str) -> Result<(), String>,
    Persist: FnMut(&Value) -> Result<(), String>,
{
    job_dispatch(directory, job, event, facts, timestamp, effect, persist)
}
