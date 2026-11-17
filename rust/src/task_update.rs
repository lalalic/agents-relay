// Node provenance: src/task-update.ts. Validate managed Task preflight and
// prepare a one-Task atomic SQLite mutation with canonical Graph lifecycle actions.
use crate::local_merge_lock::iso8601_now;
use serde_json::{json, Value};

const CANONICAL_EDITABLE: [&str; 16] = [
    "priority","storySize","projectName","agentName","agentGraph",
    "parentTaskId","dependencies","capabilities","workerRequirements",
    "adapter","chatgptTabClosePolicy","input","attachments",
    "routing","timeoutMs","maxAttempts",
];

pub fn apply_managed_task_update_snapshot<Transition>(
    original: &Value, job_id: &str, task_id: &str,
    proposed: &Value, expected_updated_at: &str,
    mut transition: Transition,
) -> Result<Value, String>
where Transition: FnMut(&mut Value, &str) -> bool {
    let mut job = original.clone();
    let tasks = job.get_mut("tasks").and_then(Value::as_array_mut)
        .ok_or("Task update identity mismatch")?;
    let Some(current) = tasks.iter_mut().find(|task|
        task.get("id").and_then(Value::as_str) == Some(task_id))
    else {return Err("Task update identity mismatch".into());};
    if proposed.get("id").and_then(Value::as_str) != Some(task_id)
        || proposed.get("jobId").and_then(Value::as_str) != Some(job_id) {
        return Err("Task update identity mismatch".into());
    }
    if current.get("updatedAt").and_then(Value::as_str) != Some(expected_updated_at) {
        return Err("Task changed since update preflight; refresh and retry".into());
    }
    let state = current.get("state").and_then(Value::as_str).unwrap_or("");
    if matches!(state, "RUNNING" | "SUCCEEDED" | "CANCELLED")
        || current.get("executionId").is_some_and(|v| !v.is_null())
        || current.get("leaseOwner").is_some_and(|v| !v.is_null())
    { return Err("Task is not mutable while active or terminal".into()); }
    let attempt = current.get("attempt").and_then(Value::as_i64).unwrap_or(0);
    if attempt > 0 && current.get("adapter") != proposed.get("adapter") {
        return Err("Cannot replace adapter after an execution attempt".into());
    }
    if proposed.get("maxAttempts").and_then(Value::as_i64).unwrap_or(0) < attempt {
        return Err("Retry budget is below execution attempts".into());
    }
    let mut next = current.clone();
    if let Some(map) = next.as_object_mut() {
        for key in CANONICAL_EDITABLE {
            match proposed.get(key) {
                Some(value) => {map.insert(key.into(),value.clone());}
                None => {map.remove(key);}
            }
        }
    }
    if next.get("dependencies").and_then(Value::as_array)
        .is_some_and(|deps| deps.iter().any(|id| id.as_str() == Some(task_id))) {
        return Err("Task cannot depend on itself".into());
    }
    let proposed_state = proposed.get("state").and_then(Value::as_str).unwrap_or("");
    if proposed_state != state {
        let effect = if proposed_state == "DRAFT" && state == "QUEUED" {
            "hold"
        } else if proposed_state == "QUEUED" {
            "queue"
        } else {return Err("Task state change requires a dedicated lifecycle action".into());};
        if !transition(&mut next, effect) {
            return Err("Task state change requires a dedicated lifecycle action".into());
        }
    }
    if next.get("adapter") != current.get("adapter")
        || next.get("routing") != current.get("routing") {
        if let Some(map) = next.as_object_mut() {map.remove("workerSelection");}
    }
    next["updatedAt"] = json!(iso8601_now());
    *current = next;
    Ok(job)
}
