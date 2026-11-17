// Node provenance: src/cli-unblock.ts. Restrict CLI unblock input and
// delegate all durable recovery decisions to the canonical Task effects.
use crate::cli_core_support::arg;
use serde_json::{json, Value};

pub fn task_unblock_request(
    args: &[String], task: &Value,
) -> Result<Value, String> {
    let reason = arg(args, "--reason", "");
    let response = arg(args, "--response", "");
    if reason.trim().is_empty() && response.trim().is_empty() {
        return Err("task unblock requires --reason or --response".into());
    }
    let troubleshooter = task.get("agentName").and_then(Value::as_str)
        == Some("troubleshooter");
    let pending = task.get("escalation").and_then(|e|e.get("status"))
        .and_then(Value::as_str) == Some("pending");
    let resume = troubleshooter && pending && !response.trim().is_empty();
    Ok(json!({
        "taskId":task.get("id"),
        "reason": reason,
        "response": response,
        "resumeTroubleshooter":resume,
        "source":"cli"
    }))
}
pub fn job_unblock_request(
    args: &[String], job: &Value, effectively_blocked: impl Fn(&Value) -> bool,
) -> Result<Value, String> {
    let reason = arg(args, "--reason", "");
    if reason.trim().is_empty() { return Err("job unblock requires --reason".into()); }
    let blocked: Vec<Value> = job.get("tasks").and_then(Value::as_array)
        .into_iter().flatten().filter(|task| effectively_blocked(task))
        .filter_map(|task| task.get("id").cloned()).collect();
    if blocked.is_empty() {
        let id = job.get("id").and_then(Value::as_str).unwrap_or("undefined");
        return Err(format!("Job {id} has no effective BLOCKED work task"));
    }
    Ok(json!({"jobId":job.get("id"),"resumedTasks":blocked,"reason":reason}))
}
