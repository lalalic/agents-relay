// Node provenance: src/execution-process-tracker.ts. SQLite records correlate
// immutable execution generation with owned POSIX process identity.
use crate::process_identity::{
    capture_process_record, probe_process_record,
};
use serde_json::Value;
use std::future::Future;

/// Register a newly started execution only after a verified POSIX process
/// identity has been captured. Caller owns the completion monitor.
pub async fn monitor_execution_process<Save, Fut>(
    job_id: &str, task_id: &str, execution_id: &str,
    pid: Option<i64>, mut save_record: Save,
) -> Result<Option<Value>, String>
where
    Save: FnMut(Value) -> Fut,
    Fut: Future<Output = Result<(), String>>,
{
    let record = pid.and_then(|pid|
        capture_process_record(job_id, task_id, execution_id, pid));
    if let Some(ref record) = record { save_record(record.clone()).await?; }
    Ok(record)
}

/// Reaping requires a dead, reused, or safely cancellable *exact* process
/// generation, never matching by an executable name.
pub async fn reclaim_stale_execution_process<Load, Fut>(
    task: &Value, load: Load,
) -> Result<bool, String>
where
    Load: FnOnce(String, String, String) -> Fut,
    Fut: Future<Output = Result<Option<Value>, String>>,
{
    // Node's if (!task.executionId || !task.jobId) treats empty strings as
    // absent; never load or reclaim a process for an empty generation.
    let execution_id = task.get("executionId").and_then(Value::as_str)
        .filter(|value|!value.is_empty());
    let job_id = task.get("jobId").and_then(Value::as_str)
        .filter(|value|!value.is_empty());
    let task_id = task.get("id").and_then(Value::as_str);
    let (Some(job_id), Some(task_id), Some(execution_id)) =
        (job_id, task_id, execution_id) else { return Ok(true); };
    let record = load(job_id.into(), task_id.into(), execution_id.into()).await?;
    // Claim may be committed before the child has been spawned and recorded.
    // Missing proof must never mark a just-starting Worker as dead.
    let Some(record) = record else { return Ok(false); };
    if record.get("endedAt").is_some_and(|value| !value.is_null()) { return Ok(true); }
    // Never kill a live process based on elapsed time or a vanished daemon.
    // A matching PID + PGID + process start token is the source of truth.
    Ok(matches!(probe_process_record(&record),"gone"|"reused"))
}
