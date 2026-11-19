// Node provenance: src/execution-recovery.ts. Reconcile only stale immutable
// execution generations, with a guarded process-group recovery fence.
use chrono::DateTime;
use serde_json::Value;
use std::future::Future;

fn task_id(task: &Value) -> Option<&str> {
    task.get("id").and_then(Value::as_str)
}
fn is_work_execution(task: &Value) -> bool {
    if task.get("kind").and_then(Value::as_str) == Some("planner") { return false; }
    let state = task.get("state").and_then(Value::as_str).unwrap_or("");
    state == "RUNNING"
        || (state == "QUEUED" && task.get("executionId").is_some_and(|v| !v.is_null()))
}
fn generation_equal(stale: &Value, current: &Value) -> bool {
    ["executionId", "leaseOwner", "leaseExpiresAt"].iter().all(|key|
        stale.get(key) == current.get(key))
}
fn lease_expired(task: &Value, now_ms: i64) -> bool {
    let Some(stamp) = task.get("leaseExpiresAt").and_then(Value::as_str) else { return false; };
    // Node compares new Date(stamp).getTime() > now: invalid dates
    // produce NaN, which is not greater than now, so the lease is
    // conservatively eligible for generation-fenced recovery.
    DateTime::parse_from_rfc3339(stamp)
        .map(|value| value.timestamp_millis() <= now_ms).unwrap_or(true)
}
fn owner_mismatch(task: &Value, current_owner: &str) -> bool {
    task.get("leaseOwner").and_then(Value::as_str)
        .is_some_and(|owner| !owner.is_empty() && owner != current_owner)
}

/// The recover callback performs the canonical Graph transition and persists
/// it after the generation/reaping fences. No second policy is implemented.
pub async fn recover_expired_executions<Load, LFut, Reclaim, RFut, Recover, OFut>(
    job: &Value, now_ms: i64,
    mut load: Load, mut reclaim: Reclaim, mut recover: Recover,
) -> Result<(), String>
where
    Load: FnMut() -> LFut, LFut: Future<Output = Result<Value, String>>,
    Reclaim: FnMut(Value) -> RFut, RFut: Future<Output = Result<bool, String>>,
    Recover: FnMut(Value, String, String) -> OFut,
    OFut: Future<Output = Result<(), String>>,
{
    let initial = job.get("tasks").and_then(Value::as_array)
        .ok_or("Job missing Tasks")?;
    for stale in initial.iter().filter(|task| is_work_execution(task) && lease_expired(task, now_ms)) {
        let Some(id) = task_id(stale) else {continue;};
        let fresh = load().await?;
        let task = fresh.get("tasks").and_then(Value::as_array)
            .and_then(|tasks| tasks.iter().find(|task| task_id(task) == Some(id)));
        let Some(task) = task else {continue;};
        if !generation_equal(stale, task) || !is_work_execution(task)
            || !lease_expired(task, now_ms) {continue;}
        if !reclaim(task.clone()).await? { continue; }
        recover(task.clone(), "lease.expired".into(), "lease_expired".into()).await?;
    }
    Ok(())
}
pub async fn recover_startup_orphans<Load, LFut, Reclaim, RFut, Recover, OFut>(
    job: &Value, owner: &str,
    mut load: Load, mut reclaim: Reclaim, mut recover: Recover,
) -> Result<(), String>
where
    Load: FnMut() -> LFut, LFut: Future<Output = Result<Value, String>>,
    Reclaim: FnMut(Value) -> RFut, RFut: Future<Output = Result<bool, String>>,
    Recover: FnMut(Value, String, String) -> OFut,
    OFut: Future<Output = Result<(), String>>,
{
    let initial = job.get("tasks").and_then(Value::as_array)
        .ok_or("Job missing Tasks")?;
    for stale in initial {
        let state = stale.get("state").and_then(Value::as_str).unwrap_or("");
        let adapter = stale.get("adapter").and_then(Value::as_str).unwrap_or("");
        if stale.get("kind").and_then(Value::as_str) == Some("planner")
            || !matches!(state, "RUNNING" | "QUEUED")
            || matches!(adapter, "chatgpt" | "z")
            // Node startup orphan filtering requires a TRUTHY execution ID,
            // not merely a non-null JSON value. Empty-string generations are
            // not real leases and cannot authorize OS process reclaim.
            || !stale.get("executionId").and_then(Value::as_str)
                .is_some_and(|id|!id.is_empty())
            || !owner_mismatch(stale, owner) {continue;}
        let Some(id) = task_id(stale) else {continue;};
        let fresh = load().await?;
        let task = fresh.get("tasks").and_then(Value::as_array)
            .and_then(|tasks| tasks.iter().find(|task| task_id(task) == Some(id)));
        let Some(task) = task else {continue;};
        let state = task.get("state").and_then(Value::as_str).unwrap_or("");
        let adapter = task.get("adapter").and_then(Value::as_str).unwrap_or("");
        if !generation_equal(stale, task)
            || !matches!(state, "RUNNING" | "QUEUED")
            || matches!(adapter, "chatgpt" | "z")
            || !task.get("executionId").and_then(Value::as_str)
                .is_some_and(|id|!id.is_empty())
            || !owner_mismatch(task, owner) {continue;}
        if !reclaim(task.clone()).await? {continue;}
        recover(task.clone(), "execution.orphaned".into(), "startup_orphaned".into()).await?;
    }
    Ok(())
}
