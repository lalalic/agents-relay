// Node provenance: src/workflow-effect-failures.ts. Record Graph effect failures
// as durable observations even when a state has no applicable failure transition.
use crate::events::event_for;
use crate::workflow::contracts::workflow_effect_failure_event;
use serde_json::{json, Value};
use std::future::Future;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowEffectOutcome {
    pub effect: String,
    pub key: String,
    pub status: String,
    pub error: Option<String>,
}

pub async fn apply_job_effect_outcomes<Transition, TFuture, Emit, EFuture>(
    job: &mut Value,
    outcomes: &[WorkflowEffectOutcome],
    mut transition_and_save: Transition,
    mut emit: Emit,
) -> Result<(), String>
where
    Transition: FnMut(Value, String) -> TFuture,
    TFuture: Future<Output = Result<Value, String>>,
    Emit: FnMut(Value) -> EFuture,
    EFuture: Future<Output = Result<(), String>>,
{
    let job_id = job.get("id").and_then(Value::as_str)
        .ok_or("Job missing immutable ID")?.to_owned();
    for outcome in outcomes.iter().filter(|outcome| outcome.status == "failed") {
        let name = workflow_effect_failure_event(&outcome.effect)?;
        if let Ok(updated) = transition_and_save(job.clone(), name.into()).await {
            *job = updated;
        }
        emit(event_for(&job_id, "job", None,
            "workflow.effect.failed", "failed",
            &format!("{} failed: {}", outcome.effect,
                outcome.error.as_deref().unwrap_or("unknown error")),
            Some("orchestrator"),
            Some(json!({"effect": outcome.effect, "idempotencyKey": outcome.key, "workflowEvent": name})),
            Some(json!({"agent": "relay", "component": "agents-relay"})),
        )).await?;
    }
    Ok(())
}

pub async fn apply_task_effect_outcomes<Transition, TFuture, Emit, EFuture>(
    job: &Value,
    task: &mut Value,
    outcomes: &[WorkflowEffectOutcome],
    mut transition_and_save: Transition,
    mut emit: Emit,
) -> Result<(), String>
where
    Transition: FnMut(Value, String) -> TFuture,
    TFuture: Future<Output = Result<Value, String>>,
    Emit: FnMut(Value) -> EFuture,
    EFuture: Future<Output = Result<(), String>>,
{
    let job_id = job.get("id").and_then(Value::as_str)
        .ok_or("Job missing immutable ID")?.to_owned();
    let task_id = task.get("id").and_then(Value::as_str)
        .ok_or("Task missing immutable ID")?.to_owned();
    let parent_id = task.get("parentTaskId").and_then(Value::as_str).map(str::to_owned);
    for outcome in outcomes.iter().filter(|outcome| outcome.status == "failed") {
        let name = workflow_effect_failure_event(&outcome.effect)?;
        let mut transitioned = task.clone();
        transitioned["error"] = Value::String(outcome.error.clone()
            .unwrap_or_else(|| format!("{} failed", outcome.effect)));
        if let Ok(updated) = transition_and_save(transitioned, name.into()).await {
            *task = updated;
        }
        let mut event=event_for(&job_id, &task_id, parent_id.as_deref(),
            "workflow.effect.failed", "failed",
            &format!("{} failed: {}", outcome.effect,
                outcome.error.as_deref().unwrap_or("unknown error")),
            Some("orchestrator"),
            Some(json!({"effect": outcome.effect, "idempotencyKey": outcome.key, "workflowEvent": name})),
            Some(json!({"agent": "relay", "component": "agents-relay"})),
        );
        // Node eventFor receives Task.parentTaskId directly: a truly absent
        // field serializes as absent, while an explicit null stays null.
        // This distinction matters to event-source identity and parity.
        if task.get("parentTaskId").is_none(){
            event.as_object_mut().expect("event JSON object")
                .remove("parent_task_id");
        }
        emit(event).await?;
    }
    Ok(())
}
