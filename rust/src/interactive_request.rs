// Node provenance: src/interactive-request.ts. Host-neutral request lifecycle
// and execution-fenced task invocation; SQLite writer is supplied by caller.
use crate::events::event_for;
use crate::local_merge_lock::iso8601_now;
use crate::relay_store::SQLiteRelayStore;
use crate::task_actions::apply_task_unblock_retry_action;
use crate::task_comments::append_task_comment;
use crate::task_transitions::try_transition_task_event;
use std::path::Path;
use serde_json::{json, Value};

pub fn interactive_waiting_event(
    job_id: &str, task_id: &str, parent_task_id: Option<&str>, execution_id: &str,
) -> Value {
    event_for(job_id, task_id, parent_task_id,
        "task.interactive_waiting", "waiting", "Interactive review requested",
        Some("orchestrator"), Some(json!({})),
        Some(json!({"id":format!("job/{job_id}/task/{task_id}/execution/{execution_id}"),
            "component":"interactive-review"})))
}
pub fn interactive_template(job_id: &str, task_id: &str, execution_id: &str) -> Value {
    json!({
        "type": "task.interactive_decision",
        "source": format!("job/{job_id}/task/{task_id}/execution/{execution_id}"),
        "data": {"interactive": {"jobId":job_id,"taskId":task_id,"executionId":execution_id}}
    })
}
/// The caller MUST commit this returned snapshot via mutateJob atomically.
pub fn begin_interactive_review(
    current: &Value, job_id: &str, task_id: &str, execution_id: &str,
) -> Result<(Value, Value), String> {
    let mut job = current.clone();
    let task = job.get_mut("tasks").and_then(Value::as_array_mut)
        .and_then(|tasks| tasks.iter_mut().find(|task|
            task.get("id").and_then(Value::as_str) == Some(task_id)))
        .ok_or("Interactive review requires current ACTIVE/RUNNING Task execution")?;
    if current.get("state").and_then(Value::as_str) != Some("ACTIVE")
        || task.get("state").and_then(Value::as_str) != Some("RUNNING")
        || task.get("executionId").and_then(Value::as_str) != Some(execution_id)
    { return Err("Interactive review requires current ACTIVE/RUNNING Task execution".into()); }
    let existing = task.get("interactiveInvocation").filter(|value| !value.is_null());
    let old_execution = existing.and_then(|value| value.get("executionId"))
        .and_then(Value::as_str);
    let old_status = existing.and_then(|value| value.get("status")).and_then(Value::as_str);
    let reused = old_execution == Some(execution_id) && old_status == Some("awaiting_decision");
    if !reused {
        let replace = existing.is_none() || (
            old_execution != Some(execution_id)
            && matches!(old_status, Some("changes_requested" | "awaiting_decision" | "approved"))
        );
        if !replace { return Err("Conflicting interactive invocation on Task".into()); }
        task["interactiveInvocation"] = json!({
            "invocationId":execution_id, "executionId":execution_id,
            "revision":execution_id, "status":"awaiting_decision",
            "boundAt": iso8601_now()
        });
        task["updatedAt"] = json!(iso8601_now());
    }
    Ok((job, json!({"jobId":job_id, "taskId":task_id,
        "executionId":execution_id, "reused":reused,
        "eventTemplate":interactive_template(job_id,task_id,execution_id)})))
}
pub fn abort_interactive_review(
    current: &Value, task_id: &str, execution_id: &str,
) -> Value {
    let mut job = current.clone();
    if let Some(task) = job.get_mut("tasks").and_then(Value::as_array_mut)
        .and_then(|tasks| tasks.iter_mut().find(|task|
            task.get("id").and_then(Value::as_str) == Some(task_id))) {
        let active = task.get("state").and_then(Value::as_str) == Some("RUNNING")
            && task.get("executionId").and_then(Value::as_str) == Some(execution_id);
        let invocation = task.get("interactiveInvocation");
        if active && invocation.and_then(|v|v.get("executionId")).and_then(Value::as_str) == Some(execution_id)
            && invocation.and_then(|v|v.get("status")).and_then(Value::as_str) == Some("awaiting_decision")
        {
            if let Some(map) = task.as_object_mut() { map.remove("interactiveInvocation"); }
            task["updatedAt"] = json!(iso8601_now());
        }
    }
    job
}


/// Review delivery failures are not approvals. This performs the same
/// identity-fenced Graph resume and durable Task mutation as Node.
pub fn fail_interactive_review(
    graph_directory: &Path, store: &SQLiteRelayStore, job_id: &str,
    task_id: &str, execution_id: &str, reason: &str,
) -> Result<Value, String> {
    let mut requeued = false;
    store.mutate_job(job_id, |mut job| {
        let index = job.get("tasks").and_then(Value::as_array)
            .and_then(|items| items.iter().position(|task|
                task.get("id").and_then(Value::as_str) == Some(task_id)));
        let Some(index) = index else { return Ok(job); };
        let task = &mut job["tasks"][index];
        let invocation = task.get("interactiveInvocation");
        if invocation.and_then(|v|v.get("executionId")).and_then(Value::as_str)
                != Some(execution_id)
            || invocation.and_then(|v|v.get("status")).and_then(Value::as_str)
                != Some("awaiting_decision") {
            return Ok(job);
        }
        let state = task.get("state").and_then(Value::as_str).unwrap_or("").to_owned();
        if state == "AWAITING_DECISION" {
            let now = iso8601_now();
            let decision = try_transition_task_event(
                graph_directory, task, "interactive.resume", &json!({}), &now,
            )?;
            if decision.get("accepted") != Some(&Value::Bool(true)) {
                return Err("Graph rejected review delivery failure recovery".into());
            }
            apply_task_unblock_retry_action(graph_directory, task, &now)?;
            if let Some(map) = task.as_object_mut() {
                map.remove("interactiveInvocation");
                map.remove("failureReason");
            }
            task["error"] = Value::Null;
            task["updatedAt"] = json!(now);
            let truncated: String = reason.chars().take(500).collect();
            append_task_comment(
                &mut job, task_id,
                &format!("Interactive review delivery failed; rerun review request: {truncated}"),
                &json!({"author":"cli"}),
            )?;
            requeued = true;
        } else if state == "RUNNING"
            && task.get("executionId").and_then(Value::as_str) == Some(execution_id) {
            if let Some(map) = task.as_object_mut() {
                map.remove("interactiveInvocation");
            }
        }
        Ok(job)
    })?;
    Ok(json!({"requeued": requeued}))
}
