// Node provenance: src/single-job-task-control.ts. Admit only the six
// daemon Graph-backed Task commands within the exact bound local Job.
use serde_json::Value;
use std::future::Future;

const ALLOWED_COMMANDS: [&str; 6] = [
    "task.unblock", "task.recover", "task.escalate",
    "task.resume-troubleshooter", "task.classify", "task.revise",
];

pub fn validate_single_job_control(job_id: &str, body: &Value) -> Result<(), String> {
    let command = body.get("command").and_then(Value::as_str).unwrap_or("");
    if !ALLOWED_COMMANDS.contains(&command) {
        return Err("Single-Job control command not supported".into());
    }
    if body.get("jobId").and_then(Value::as_str) != Some(job_id) {
        return Err("Control request outside bound Job".into());
    }
    Ok(())
}

/// The callback is the canonical daemon control adapter, never a second
/// lifecycle decision table or an alternate SQLite writer.
pub async fn create_single_job_task_control<F, Fut>(
    job_id: &str, body: &Value, canonical_control: F,
) -> Result<Value, String>
where
    F: FnOnce(Value) -> Fut,
    Fut: Future<Output = Result<Value, String>>,
{
    validate_single_job_control(job_id, body)?;
    canonical_control(body.clone()).await
}
