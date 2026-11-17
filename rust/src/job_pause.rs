// Node provenance: src/job-pause.ts. Build atomic pause/resume mutations
// over the SQLite Job snapshot; the caller supplies the canonical Graph guard.
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{json, Value};
use std::time::SystemTime;

fn now_iso() -> String {
    DateTime::<Utc>::from(SystemTime::now())
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn property_str<'a>(value: &'a Value, field: &str) -> &'a str {
    value.get(field).and_then(Value::as_str).unwrap_or("")
}
fn is_terminal_task(state: &str) -> bool {
    matches!(state, "SUCCEEDED" | "FAILED" | "CANCELLED")
}

/// Apply only inside mutateJob's transaction. Return a fresh copy so denied
/// Graph transitions never partially mutate the caller's Job.
pub fn pause_job<Transition>(current: &Value, mut transition: Transition) -> Result<Value, String>
where Transition: FnMut(&mut Value, &str) -> bool {
    let mut job = current.clone();
    let state = property_str(&job, "state");
    if matches!(state, "COMPLETED" | "CANCELLED") {
        return Err(format!("Cannot pause terminal Job {} ({state})", property_str(&job, "id")));
    }
    if job.get("pause").is_some_and(|v| !v.is_null()) { return Ok(job); }
    let now = now_iso();
    job["pause"] = json!({"generation": 1, "requestedAt": now});
    let tasks = job.get_mut("tasks").and_then(Value::as_array_mut)
        .ok_or("Job snapshot has no Task array")?;
    for task in tasks {
        if property_str(task, "kind") == "planner"
            || is_terminal_task(property_str(task, "state"))
        { continue; }
        let state = property_str(task, "state").to_string();
        let id = property_str(task, "id").to_string();
        let execution_id = task.get("executionId").cloned()
            .filter(|value| !value.is_null());
        if let Some(execution_id) = execution_id {
            task["pausedExecution"] = json!({
                "id": execution_id,
                "state": if state == "RUNNING" { "RUNNING" } else { "QUEUED" },
                "attempt": task.get("attempt").cloned().unwrap_or(Value::Null),
                "at": now,
            });
        }
        if state == "RUNNING" && !transition(task, "pause") {
            return Err(format!("Cannot pause running Task {id}"));
        }
        task["executionId"] = Value::Null;
        task["leaseOwner"] = Value::Null;
        task["leaseExpiresAt"] = Value::Null;
        task["updatedAt"] = json!(now);
    }
    if let Some(plans) = job.get_mut("plans").and_then(Value::as_array_mut) {
        for plan in plans {
            if property_str(plan, "status") != "PLANNING" { continue; }
            if let Some(execution_id) = plan.get("executionId").filter(|value| !value.is_null()).cloned() {
                plan["pausedExecutionId"] = execution_id;
            }
            plan["executionId"] = Value::Null;
            plan["leaseOwner"] = Value::Null;
            plan["leaseExpiresAt"] = Value::Null;
            plan["updatedAt"] = json!(now);
        }
    }
    job["updatedAt"] = json!(now);
    Ok(job)
}
pub fn resume_job(current: &Value) -> Result<Value, String> {
    let mut job = current.clone();
    if job.get("pause").is_none_or(Value::is_null) { return Ok(job); }
    let now = now_iso();
    if let Some(map) = job.as_object_mut() { map.remove("pause"); }
    if let Some(tasks) = job.get_mut("tasks").and_then(Value::as_array_mut) {
        for task in tasks {
            if task.get("pausedExecution").is_none_or(Value::is_null) { continue; }
            let attempt = task.get("attempt").and_then(Value::as_i64).unwrap_or(0);
            let max_attempts = task.get("maxAttempts").and_then(Value::as_i64).unwrap_or(0);
            if attempt >= max_attempts { task["maxAttempts"] = json!(attempt + 1); }
            if let Some(map) = task.as_object_mut() { map.remove("pausedExecution"); }
            task["updatedAt"] = json!(now);
        }
    }
    if let Some(plans) = job.get_mut("plans").and_then(Value::as_array_mut) {
        for plan in plans {
            if let Some(map) = plan.as_object_mut() { map.remove("pausedExecutionId"); }
        }
    }
    job["updatedAt"] = json!(now);
    Ok(job)
}
