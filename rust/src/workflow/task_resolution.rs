// Direct port of src/workflow/task-resolution.ts. Only Mermaid Graph outcomes
// select actions; the helper facts/validation reproduce Node's pure adapters.
use super::dispatcher::{
    decide_workflow_graph, dispatch_workflow_graph, dispatch_workflow_graph_sync, DispatchOptions,
};
use super::policy_graph::load_policy_graph;
use serde_json::{json, Value};
use std::{future::Future, path::Path};

/// Public equivalent of the exported Node `taskResolutionV2` GraphRuntime:
/// it loads the canonical Mermaid file and its strict durable-fact guards.
pub fn task_resolution_v2(directory: &Path) -> Result<super::graph_v2::GraphRuntime, String> {
    let mut runtime = load_policy_graph(directory, "task-resolution")?;
    // Node registers two reserved classification states and one fallback
    // action even though none is selected by the current canonical graph.
    // Preserve the exported GraphRuntime registry without authoring policy.
    runtime
        .registry
        .states
        .insert("check_classification".into());
    runtime.registry.states.insert("classificationKind".into());
    runtime.registry.actions.insert(
        "resolution.activateShortcutWorkerFallback".into(),
        (None, None),
    );
    Ok(runtime)
}

pub const TASK_RESOLUTION_PATHS: &[&str] = &[
    "exact_original_retry",
    "same_job_dependency",
    "blocker_job_dependency",
    "escalation_gate",
    "cancel_supersede",
];
fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn truthy(v: &Value) -> bool {
    !v.is_null() && v != false && v != "" && v != 0
}
pub fn unresolved_task(task: &Value) -> bool {
    task["kind"] != "planner" && task["state"] != "SUCCEEDED" && task["state"] != "CANCELLED"
}
pub fn validate_resolution_proposal(
    job: &Value,
    original: &Value,
    proposal: &Value,
) -> Result<(), String> {
    let path = s(proposal, "path");
    if !TASK_RESOLUTION_PATHS.contains(&path) {
        return Err(format!("Unknown task resolution path {path}"));
    }
    if path == "exact_original_retry" && original["state"] != "FAILED" {
        return Err("Exact-original retry requires a FAILED original Task".into());
    }
    if path == "same_job_dependency"
        && (!truthy(&proposal["targetTaskId"])
            || proposal["targetTaskId"] == original["id"]
            || !job["tasks"].as_array().into_iter().flatten().any(|task| {
                task["id"] == proposal["targetTaskId"]
                    && task["jobId"] == job["id"]
                    && task["state"] != "SUCCEEDED"
                    && task["state"] != "CANCELLED"
            }))
    {
        return Err("Same-Job dependency resolution requires an existing unresolved target Task in the same Job".into());
    }
    if path == "blocker_job_dependency"
        && (!truthy(&proposal["targetJobId"]) || !truthy(&proposal["mode"]))
    {
        return Err(
            "Blocker-Job dependency resolution requires targetJobId and merge or verified mode"
                .into(),
        );
    }
    if path == "escalation_gate"
        && (!truthy(&proposal["rootCause"]) || !truthy(&proposal["solution"]))
    {
        return Err("Escalation gate resolution requires rootCause and solution".into());
    }
    if path == "cancel_supersede" && !truthy(&proposal["rootCause"]) {
        return Err("Cancellation/supersession requires an explicit obsolescence rootCause".into());
    }
    Ok(())
}
pub fn resolution_facts(task: &Value, proposal: &Value, owner: &Value) -> Value {
    let path = s(proposal, "path");
    let troubleshooter = owner == "troubleshooter";
    let has_owner = !owner.is_null();
    let recovery_id = &proposal["recoveryExecutionId"];
    let fresh = !troubleshooter
        || path != "exact_original_retry"
        || (truthy(recovery_id)
            && *recovery_id
                != task
                    .pointer("/resolution/recoveryExecutionId")
                    .cloned()
                    .unwrap_or(Value::Null));
    json!({"recoveryOwnerAvailable":troubleshooter,
        "plannerOwnerAvailable":has_owner && !troubleshooter,
        "exactOriginalRetry":path == "exact_original_retry" && task["state"] == "FAILED",
        "sameJobDependency":path == "same_job_dependency" && has_owner && proposal["targetTaskId"] != task["id"],
        "blockerJobDependency":path == "blocker_job_dependency" && has_owner && truthy(&proposal["targetJobId"]) && truthy(&proposal["mode"]),
        "escalationGate":path == "escalation_gate" && troubleshooter && truthy(&proposal["rootCause"]) && truthy(&proposal["solution"]),
        "genuinelyObsolete":path == "cancel_supersede" && truthy(&proposal["rootCause"]),
        "freshRecoveryExecution":fresh,
        "unresolved":unresolved_task(task)})
}
fn checked(mut decision: Value) -> Value {
    if decision["accepted"] == true && decision["target"] == "rejected" {
        decision["accepted"] = json!(false);
        decision["reason"] = json!("no_transition");
    }
    decision
}
fn transient(state: &str) -> bool {
    matches!(
        state,
        "check_owner" | "check_path" | "check_fresh_execution"
    )
}
fn options<'a>(
    state: &'a str,
    event: &str,
    payload: &Value,
    facts: &Value,
    steps: usize,
) -> DispatchOptions<'a> {
    let mut result = DispatchOptions::event(state, event, facts, steps);
    result.input["payload"] = payload.clone();
    result.graph_name = Some("task-resolution".into());
    result
}
pub fn decide_task_resolution(
    directory: &Path,
    task: &Value,
    proposal: &Value,
    owner: &Value,
) -> Result<Value, String> {
    let runtime = load_policy_graph(directory, "task-resolution")?;
    let facts = resolution_facts(task, proposal, owner);
    Ok(checked(decide_workflow_graph(
        &runtime,
        &options("unresolved", "resolution.propose", proposal, &facts, 8),
        transient,
    )?))
}
pub fn dispatch_task_resolution_sync(
    directory: &Path,
    task: &Value,
    proposal: &Value,
    owner: &Value,
    mut effect: impl FnMut(&str) -> Result<(), String>,
) -> Result<Value, String> {
    let runtime = load_policy_graph(directory, "task-resolution")?;
    let facts = resolution_facts(task, proposal, owner);
    Ok(checked(dispatch_workflow_graph_sync(
        &runtime,
        &options("unresolved", "resolution.propose", proposal, &facts, 8),
        transient,
        |_, _| Ok(()),
        |action| effect(action).map(|_| json!({})),
        |_, _| Ok(()),
    )?))
}
pub async fn dispatch_task_resolution<Effect, Fut>(
    directory: &Path,
    task: &Value,
    proposal: &Value,
    owner: &Value,
    mut effect: Effect,
) -> Result<Value, String>
where
    Effect: FnMut(String) -> Fut,
    Fut: Future<Output = Result<(), String>>,
{
    let runtime = load_policy_graph(directory, "task-resolution")?;
    let facts = resolution_facts(task, proposal, owner);
    Ok(checked(
        dispatch_workflow_graph(
            &runtime,
            &options("unresolved", "resolution.propose", proposal, &facts, 8),
            transient,
            |_, _| async { Ok(()) },
            |action| {
                let future = effect(action);
                async move { future.await.map(|_| json!({})) }
            },
            |_, _| async { Ok(()) },
        )
        .await?,
    ))
}
pub fn materialize_resolution(proposal: &Value, owner: &Value, now: &str) -> Value {
    let mut value = proposal.clone();
    value["state"] = json!(if proposal["path"] == "escalation_gate"
        || proposal["path"] == "blocker_job_dependency"
    {
        "waiting"
    } else {
        "active"
    });
    value["owner"] = owner.clone();
    value["updatedAt"] = json!(now);
    value
}
pub fn classify_task_resolution(
    directory: &Path,
    task: &mut Value,
    classification: &Value,
    now: &str,
) -> Result<Value, String> {
    let complete = ["targetTaskId", "evidence", "reason"]
        .iter()
        .all(|key| !s(classification, key).trim().is_empty());
    let kind = s(classification, "kind");
    let classifiable = task["kind"] != "planner"
        && task["state"] == "FAILED"
        && task["failureReason"] != "worker_outcome_unknown"
        && !truthy(&task["executionId"])
        && !truthy(&task["leaseOwner"])
        && !truthy(&task["leaseExpiresAt"])
        && task["resolutionClassification"].is_null()
        && task.pointer("/resolution/state").and_then(Value::as_str) != Some("active")
        && task.pointer("/resolution/state").and_then(Value::as_str) != Some("waiting");
    let facts = json!({"classifiableFailure":classifiable,"classificationSuperseded":kind == "superseded",
        "supersededEvidenceComplete":kind == "superseded" && complete,
        "invalidEvidenceComplete":kind == "invalid" && complete});
    let mut applied = Value::Null;
    let runtime = load_policy_graph(directory, "task-resolution")?;
    let decision = dispatch_workflow_graph_sync(
        &runtime,
        &options(
            "unresolved",
            "resolution.classify",
            classification,
            &facts,
            6,
        ),
        |state| matches!(state, "check_classification" | "classificationKind"),
        |_, _| Ok(()),
        |action| {
            let expected = if kind == "superseded" {
                "resolution.classifySuperseded"
            } else {
                "resolution.classifyInvalid"
            };
            if action != expected {
                return Err(format!("Unexpected Task Resolution action {action}"));
            }
            applied = classification.clone();
            applied["updatedAt"] = json!(now);
            Ok(json!({}))
        },
        |_, _| Ok(()),
    )?;
    if decision["accepted"] != true || decision["target"] != "resolved" || applied.is_null() {
        return Err(format!(
            "Task resolution graph rejected {kind} classification for {}",
            s(task, "id")
        ));
    }
    task["resolutionClassification"] = applied.clone();
    task["updatedAt"] = json!(now);
    Ok(applied)
}
pub fn attach_resolution_ownership(
    directory: &Path,
    job: &mut Value,
    child: &Value,
    proposal: &Value,
    owner: &Value,
    now: &str,
) -> Result<Value, String> {
    let target = &proposal["targetTaskId"];
    let Some(index) = job["tasks"]
        .as_array()
        .into_iter()
        .flatten()
        .position(|t| t["id"] == *target)
    else {
        let missing = target.as_str().unwrap_or("(missing)");
        return Err(format!("Resolution target {missing} not found"));
    };
    if proposal["path"] != "same_job_dependency" {
        return Err(format!("Planner child resolution {} cannot materialize replacement work; use the dedicated resolution effect",s(proposal,"path")));
    }
    let original = job["tasks"][index].clone();
    let mut normalized = proposal.clone();
    normalized["targetTaskId"] = child["id"].clone();
    let mut selected = false;
    let decision =
        dispatch_task_resolution_sync(directory, &original, &normalized, owner, |action| {
            if action != "resolution.attachSameJobDependency" {
                return Err(format!("Task resolution effect {action} is unavailable"));
            }
            selected = true;
            Ok(())
        })?;
    if decision["accepted"] != true || !selected {
        return Err(format!(
            "Task resolution graph rejected same-Job dependency for {}",
            s(&original, "id")
        ));
    }
    let mut updated = original;
    // Node calls `original.dependencies.includes(child.id)` inside the selected
    // action. A malformed persisted Task must fail here, not invent an empty
    // dependency list and silently accept an invalid ownership mutation.
    match updated.get("dependencies") {
        None => return Err("Cannot read properties of undefined (reading 'includes')".into()),
        Some(Value::Null) => {
            return Err("Cannot read properties of null (reading 'includes')".into())
        }
        Some(Value::Array(_)) => (),
        Some(_) => return Err("original.dependencies.includes is not a function".into()),
    }
    if !updated["dependencies"]
        .as_array()
        .is_some_and(|v| v.contains(&child["id"]))
    {
        if !updated["dependencies"].is_array() {
            updated["dependencies"] = json!([]);
        }
        updated["dependencies"]
            .as_array_mut()
            .expect("array")
            .push(child["id"].clone());
    }
    let mut resolution = materialize_resolution(&normalized, owner, now);
    resolution["state"] = json!("waiting");
    updated["resolution"] = resolution;
    job["tasks"][index] = updated.clone();
    Ok(updated)
}
pub fn claim_exact_original_recovery(
    original: &mut Value,
    recovery: &Value,
    now: &str,
) -> Result<(), String> {
    if !truthy(&recovery["executionId"]) {
        return Err(format!(
            "Troubleshooter {} has no current execution for a fresh resolution",
            s(recovery, "id")
        ));
    }
    let root_cause = ["failureReason", "error"]
        .iter()
        .find_map(|key| original.get(*key).filter(|x| truthy(x)).cloned())
        .unwrap_or(json!("durable failure"));
    let proposal = json!({"path":"exact_original_retry","targetTaskId":original["id"],
        "recoveryExecutionId":recovery["executionId"],"rootCause":root_cause,
        "solution":format!("Troubleshooter {} diagnosis and exact-original recovery",s(recovery,"id"))});
    original["resolution"] = materialize_resolution(&proposal, &json!("troubleshooter"), now);
    Ok(())
}
