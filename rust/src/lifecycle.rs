//! Graph-authorized Task state execution using Rust's atomic SQLite writer.
//! Every workflow choice comes from the canonical Mermaid Graph. This module
//! implements only side-effect-free mutation primitives; unknown effects fail.
use crate::authority::{CommittedJob, RelayAuthority, ScriptClaim, WorkflowEvent};
use crate::graph::{Decision, Graph, GraphInput};
use rusqlite::params;
use serde_json::Value;
use std::collections::HashMap;

/// Concrete Graph-selected Task mutations shared by lifecycle and DAG
/// checkpoint paths. Unknown effects are rejected, never acknowledged.
pub(crate) fn apply_pure_task_actions(
    task: &mut Value,
    actions: &[crate::graph::ActionDecision],
) -> Result<(), String> {
    for action in actions {
        match action.id.as_str() {
            "mutation.clearError" => task["error"] = Value::Null,
            "mutation.markUnknownOutcome" => {
                task["error"]=Value::String("Worker execution outcome is unknown; Troubleshooter diagnosis is required before retry.".into());
                task["failureReason"] = Value::String("worker_outcome_unknown".into());
            }
            "mutation.clearLease" => {
                task["leaseOwner"] = Value::Null;
                task["leaseExpiresAt"] = Value::Null;
            }
            "mutation.clearExecution" => task["executionId"] = Value::Null,
            "mutation.clearFailureReason" => {
                if let Some(fields) = task.as_object_mut() {
                    fields.shift_remove("failureReason");
                }
            }
            other => return Err(format!("unimplemented Rust Task Action '{other}'")),
        }
    }
    Ok(())
}
pub struct TaskTransition<'a> {
    pub job_id: &'a str,
    pub task_id: &'a str,
    pub input: GraphInput,
    pub guard_facts: &'a HashMap<String, bool>,
    pub at: &'a str,
    pub events: Vec<WorkflowEvent>,
}
pub struct TaskLifecycle<'g> {
    graph: &'g Graph,
}
impl<'g> TaskLifecycle<'g> {
    pub fn new(graph: &'g Graph) -> Self {
        Self { graph }
    }
    pub fn apply(
        &self,
        store: &mut RelayAuthority,
        request: TaskTransition<'_>,
    ) -> Result<(CommittedJob, Decision), String> {
        self.apply_with_result(store, request, None)
    }

    /// Persist a verified Worker result in the same SQLite transaction as
    /// Graph-authorized task.completed. Never expose SUCCEEDED while its
    /// structured evidence is still an uncommitted second write.
    pub fn apply_with_result(
        &self,
        store: &mut RelayAuthority,
        request: TaskTransition<'_>,
        result: Option<Value>,
    ) -> Result<(CommittedJob, Decision), String> {
        self.apply_internal(store, request, result, None)
    }

    /// Complete a real worker generation and its launch Action receipt in ONE
    /// SQLite transaction with Task state/result and terminal event outbox.
    /// A partially committed Task/Action postcondition is never observable.
    pub fn apply_with_launch_receipt(
        &self,
        store: &mut RelayAuthority,
        request: TaskTransition<'_>,
        result: Option<Value>,
        claim: &ScriptClaim,
    ) -> Result<(CommittedJob, Decision), String> {
        self.apply_internal(store, request, result, Some(claim))
    }

    fn apply_internal(
        &self,
        store: &mut RelayAuthority,
        request: TaskTransition<'_>,
        result: Option<Value>,
        launch: Option<&ScriptClaim>,
    ) -> Result<(CommittedJob, Decision), String> {
        let TaskTransition {
            job_id,
            task_id,
            input,
            guard_facts,
            at,
            events,
        } = request;
        // Evaluate inside SQLite's IMMEDIATE transaction, not against a stale
        // read from before the lock. A competing reconciler cannot race us.
        let mut decision = None;
        let committed = store.commit_job_with_tx(job_id, at, |tx,job| {
            let mut next = job.clone();
            let task = next
                .get_mut("tasks")
                .and_then(Value::as_array_mut)
                .and_then(|tasks| {
                    tasks
                        .iter_mut()
                        .find(|task| task.get("id").and_then(Value::as_str) == Some(task_id))
                })
                .ok_or_else(|| format!("Unknown Task '{task_id}' in Job '{job_id}'"))?;
            let state = task
                .get("state")
                .and_then(Value::as_str)
                .ok_or("Task state is missing")?
                .to_owned();
            // The executor may never claim completion using another execution
            // generation or omit an identity on an in-flight Task.
            if !input.payload.is_object() {
                return Err("Task event payload must be object".into());
            }
            let expected = task.get("executionId").and_then(Value::as_str);
            let provided = input.payload.get("executionId").and_then(Value::as_str);
            if expected.is_some() && expected != provided {
                return Err("stale or missing Task executionId".into());
            }
            if let Some(event_task) = input.payload.get("taskId").and_then(Value::as_str) {
                if event_task != task_id {
                    return Err("event Task identity mismatch".into());
                }
            }
            if let Some(owner) = input.payload.get("leaseOwner").and_then(Value::as_str) {
                if task.get("leaseOwner").and_then(Value::as_str) != Some(owner) {
                    return Err("Task lease owner mismatch".into());
                }
            }
            if let Some(attempt) = input.payload.get("attempt").and_then(Value::as_i64) {
                if task.get("attempt").and_then(Value::as_i64) != Some(attempt) {
                    return Err("Task attempt generation mismatch".into());
                }
            }
            let graph_decision = self.graph.decide(&state, input.clone(), guard_facts)?;
            let Decision::Accepted {
                target, actions, ..
            } = &graph_decision
            else {
                return Err(format!(
                    "Graph denied Task transition {state} on {}",
                    input.id
                ));
            };
            if result.is_some() {
                if job.get("state").and_then(Value::as_str) != Some("ACTIVE")
                    || job.get("pause").is_some_and(|v| !v.is_null())
                    || state != "RUNNING"
                {
                    return Err(
                        "Cannot commit Script completion on paused, terminal or unowned Job".into(),
                    );
                }
                let owner = input
                    .payload
                    .get("leaseOwner")
                    .and_then(Value::as_str)
                    .ok_or("completion missing owner")?;
                let attempt = input
                    .payload
                    .get("attempt")
                    .and_then(Value::as_i64)
                    .ok_or("completion missing attempt")?;
                if task.get("leaseOwner").and_then(Value::as_str) != Some(owner)
                    || task.get("attempt").and_then(Value::as_i64) != Some(attempt)
                    || !task
                        .get("executionHistory")
                        .and_then(Value::as_array)
                        .is_some_and(|h| {
                            h.iter().any(|v| {
                                v["id"].as_str() == expected
                                    && v["attempt"].as_i64() == Some(attempt)
                            })
                        })
                {
                    return Err("Script completion generation lacks durable owner/history".into());
                }
                let expiry = task
                    .get("leaseExpiresAt")
                    .and_then(Value::as_str)
                    .ok_or("Script lease missing")?;
                let deadline = chrono::DateTime::parse_from_rfc3339(expiry)
                    .map_err(|_| "bad Script lease expiry")?;
                let observed = chrono::DateTime::parse_from_rfc3339(at)
                    .map_err(|_| "bad Script receipt timestamp")?;
                if deadline <= observed {
                    return Err("Script completion after lease expiration".into());
                }
            }
            if result.is_some() && (input.id != "task.completed" || target != "SUCCEEDED") {
                return Err("structured result requires Graph-authorized task.completed".into());
            }
            apply_pure_task_actions(task, actions)?;
            // Graph owns the FAILED transition. Preserve its correlated
            // Worker error on the same atomic Task snapshot so recovery
            // never depends on an out-of-band event reader.
            if input.id == "task.failed" && target == "FAILED" {
                if let Some(failure) = events.iter().find(|event| {
                    event.event_id == "task.failed"
                        && event.payload["taskId"] == task_id
                        && event.payload["executionId"] == provided.unwrap_or("")
                }) {
                    let message = failure.payload["reason"]
                        .as_str()
                        .ok_or("failure reason missing")?;
                    if message.is_empty() || message.len() > 2048 {
                        return Err("invalid correlated failure reason".into());
                    }
                    task["error"] = Value::String(message.into());
                }
            }
            if let Some(result) = &result {
                if result
                    .get("data")
                    .and_then(|v| v.get("status"))
                    .and_then(Value::as_str)
                    != Some("COMPLETED")
                    || !result
                        .get("data")
                        .and_then(|v| v.get("output"))
                        .is_some_and(Value::is_object)
                {
                    return Err("Worker result has no verified COMPLETED object".into());
                }
                task["result"] = result.clone();
            }
            if let Some(claim)=launch {
                if !matches!(input.id.as_str(),"task.completed"|"task.failed")
                    || state!="RUNNING"
                    || task.get("executionId").and_then(Value::as_str)!=Some(claim.execution_id.as_str())
                    || task.get("leaseOwner").and_then(Value::as_str)!=Some(claim.owner.as_str())
                    || task.get("attempt").and_then(Value::as_i64)!=Some(claim.attempt)
                    || !matches!(target.as_str(),"SUCCEEDED"|"FAILED"){
                    return Err("Task transition does not match registered Worker launch generation".into());
                }
                let changed=tx.execute(
                    "UPDATE workflow_action_trace SET outcome='Verified',observed_at=?1 WHERE attempt_key=?2 AND execution_id=?3 AND generation=?4 AND action_id='effect.launchTask' AND outcome='Unknown'",
                    params![at,claim.attempt_key,claim.execution_id,claim.attempt],
                ).map_err(|e|e.to_string())?;
                if changed!=1{return Err("missing fresh launch Action postcondition in Task transaction".into());}
            }
            task["state"] = Value::String(target.clone());
            task["updatedAt"] = Value::String(at.into());
            next["updatedAt"] = Value::String(at.into());
            decision = Some(graph_decision);
            Ok((next, events))
        })?;
        Ok((
            committed,
            decision.expect("successful transition sets decision"),
        ))
    }
}

#[cfg(test)]
mod tests;
