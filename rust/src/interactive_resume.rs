// Node provenance: src/interactive-resume.ts. Atomic, identity-fenced
// Graph-authorized continuation after an accepted human decision.
use crate::local_merge_lock::iso8601_now;
use crate::relay_store::SQLiteRelayStore;
use crate::interactive_invocation::should_recover_interactive_decision;
use crate::task_transitions::try_transition_task_event;
use std::path::Path;
use crate::task_comments::append_task_comment;
use serde_json::{json, Value};

pub fn resume_interactive_task<Transition>(
    current: &Value, task_id: &str, invocation_id: &str,
    revision: &str, decision: &str, mut graph_transition: Transition,
) -> Result<(Value, bool), String>
where
    Transition: FnMut(&mut Value, &str) -> bool,
{
    let mut job = current.clone();
    let Some(tasks) = job.get_mut("tasks").and_then(Value::as_array_mut) else {
        return Ok((job, false));
    };
    let Some(task) = tasks.iter_mut().find(|task|
        task.get("id").and_then(Value::as_str) == Some(task_id))
    else { return Ok((job, false)); };
    let Some(invocation) = task.get("interactiveInvocation") else {
        return Ok((job, false));
    };
    if task.get("state").and_then(Value::as_str) != Some("AWAITING_DECISION")
        || invocation.get("invocationId").and_then(Value::as_str) != Some(invocation_id)
        || invocation.get("revision").and_then(Value::as_str) != Some(revision)
        || invocation.get("status").and_then(Value::as_str) != Some(decision)
        || invocation.get("decidedAt").is_none_or(Value::is_null)
    { return Ok((job, false)); }
    let feedback = invocation.get("feedback").and_then(Value::as_str)
        .map(str::trim).filter(|text| !text.is_empty())
        .unwrap_or("Changes requested").to_string();
    if !graph_transition(task, "interactive.resume") {
        return Err("Interactive Task release rejected by canonical lifecycle Graph".into());
    }
    let state = task.get("state").and_then(Value::as_str).unwrap_or("");
    if !matches!(state, "QUEUED" | "DRAFT") {
        return Err(format!("Task {task_id} is not retryable after unblock ({state})"));
    }
    task["attempt"] = json!(0);
    let max_attempts = task.get("maxAttempts").and_then(Value::as_i64).unwrap_or(0).max(3);
    task["maxAttempts"] = json!(max_attempts);
    task["executionId"] = Value::Null;
    task["leaseOwner"] = Value::Null;
    task["leaseExpiresAt"] = Value::Null;
    task["error"] = Value::Null;
    if let Some(map) = task.as_object_mut() {
        map.remove("blockedBy");
        map.remove("failureReason");
    }
    task["updatedAt"] = json!(iso8601_now());
    if decision == "changes_requested" {
        let truncated: String = feedback.chars().take(1000).collect();
        append_task_comment(&mut job, task_id,
            &format!("Interactive review changes requested for revision {revision}: {truncated}"),
            &json!({"author":"cli"}))?;
    }
    Ok((job, true))
}
pub fn recoverable_interactive_decisions(job: &Value) -> Vec<(String, String, String, String)> {
    job.get("tasks").and_then(Value::as_array).into_iter().flatten()
        .filter_map(|task| {
            if task.get("state").and_then(Value::as_str) != Some("AWAITING_DECISION") {return None;}
            let invocation = task.get("interactiveInvocation")?;
            if invocation.get("decidedAt").is_none_or(Value::is_null) {return None;}
            let status = invocation.get("status")?.as_str()?;
            if status == "awaiting_decision" { return None; }
            Some((
                task.get("id")?.as_str()?.into(),
                invocation.get("invocationId")?.as_str()?.into(),
                invocation.get("revision")?.as_str()?.into(),
                status.into(),
            ))
        }).collect()
}


/// Restart-safe recovery of decisions already persisted in SQLite. The
/// EventBus wake may be lost; the Graph determines eligibility on replay.
pub fn recover_interactive_decisions(
    directory: &Path, store: &SQLiteRelayStore, job_id: &str,
) -> Result<bool, String> {
    let snapshot = store.load_job(job_id)?
        .ok_or_else(||format!("Local authoritative Job {job_id} not found"))?;
    let mut recovered = false;
    for (task_id, invocation_id, revision, status) in
        recoverable_interactive_decisions(&snapshot)
    {
        if !should_recover_interactive_decision(directory, &status)? {continue;}
        let mut resumed = false;
        store.mutate_job(job_id, |job| {
            let mut transition_error = None;
            let (next, did_resume) = resume_interactive_task(
                &job, &task_id, &invocation_id, &revision, &status,
                |task, event| match try_transition_task_event(
                    directory, task, event, &json!({}), &iso8601_now(),
                ) {
                    Ok(decision) => decision.get("accepted") == Some(&Value::Bool(true)),
                    Err(error) => { transition_error = Some(error); false }
                },
            )?;
            if let Some(error) = transition_error {return Err(error);}
            resumed = did_resume;
            Ok(next)
        })?;
        recovered |= resumed;
    }
    Ok(recovered)
}
