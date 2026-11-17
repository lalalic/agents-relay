// Node provenance: src/execution-process-tracker.ts. SQLite records correlate
// immutable execution generation with owned POSIX process identity.
use crate::process_identity::{
    active_relay_lease_owner, capture_process_record, probe_process_record,
    stop_orphaned_process_group,
};
use serde_json::Value;
use std::future::Future;
use std::time::Duration;

/// Register a newly started execution only after a verified POSIX process
/// identity has been captured. Caller owns the completion monitor.
pub async fn monitor_execution_process<Save, Fut>(
    job_id: &str, task_id: &str, execution_id: &str, owner: &str,
    pid: Option<i64>, mut save_record: Save,
) -> Result<Option<Value>, String>
where
    Save: FnMut(Value) -> Fut,
    Fut: Future<Output = Result<(), String>>,
{
    let record = pid.and_then(|pid|
        capture_process_record(job_id, task_id, execution_id, owner, pid));
    if let Some(ref record) = record { save_record(record.clone()).await?; }
    Ok(record)
}

/// Reaping requires a dead, reused, or safely cancellable *exact* process
/// generation, never matching by an executable name.
pub async fn reclaim_stale_execution_process<Load, Fut>(
    task: &Value, current_owner: Option<&str>, load: Load,
) -> Result<bool, String>
where
    Load: FnOnce(String, String, String) -> Fut,
    Fut: Future<Output = Result<Option<Value>, String>>,
{
    let execution_id = task.get("executionId").and_then(Value::as_str);
    let job_id = task.get("jobId").and_then(Value::as_str);
    let task_id = task.get("id").and_then(Value::as_str);
    let (Some(job_id), Some(task_id), Some(execution_id)) =
        (job_id, task_id, execution_id) else { return Ok(true); };
    let record = load(job_id.into(), task_id.into(), execution_id.into()).await?;
    let owner = task.get("leaseOwner").and_then(Value::as_str);
    if owner.is_some_and(|owner|
        Some(owner) != current_owner && active_relay_lease_owner(owner))
    { return Ok(false); }
    let Some(record) = record else { return Ok(true); };
    if record.get("endedAt").is_some_and(|value| !value.is_null()) { return Ok(true); }
    let state = probe_process_record(&record);
    if state == "gone" || state == "reused" { return Ok(true); }
    if state != "alive"
        || owner.is_some_and(|owner|
            Some(owner) != current_owner && active_relay_lease_owner(owner))
    { return Ok(false); }
    Ok(stop_orphaned_process_group(&record, Duration::from_millis(750)))
}
