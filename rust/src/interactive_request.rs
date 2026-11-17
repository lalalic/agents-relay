// Node provenance: src/interactive-request.ts. Host-neutral request lifecycle
// and execution-fenced task invocation; SQLite writer is supplied by caller.
use crate::events::event_for;
use crate::local_merge_lock::iso8601_now;
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
