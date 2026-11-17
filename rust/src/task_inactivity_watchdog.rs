// Direct port of Node src/task-inactivity-watchdog.ts: execution-scoped
// deadlines, source correlation and monotonic progress receipt guards.
// Durable Graph transition/persistence is owned by the caller, not this clock adapter.
use crate::execution_event_identity::{event_source_id, execution_event_source};
use chrono::{DateTime, NaiveDate, NaiveDateTime};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}
fn parse_ms(text: &str) -> Option<i64> {
    if let Ok(dt) = DateTime::parse_from_rfc3339(text) {
        return Some(dt.timestamp_millis());
    }
    if let Ok(dt) = NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M:%S%.f") {
        return Some(dt.and_utc().timestamp_millis());
    }
    NaiveDate::parse_from_str(text, "%Y-%m-%d")
        .ok()
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .map(|d| d.and_utc().timestamp_millis())
}
fn string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}
fn js_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::String(s) => !s.is_empty(),
        Value::Number(n) => n.as_f64() != Some(0.0),
        _ => true,
    }
}

pub fn requires_worker_inactivity_watchdog(task: &Value) -> bool {
    !(task.get("agentGraph").is_some_and(js_truthy)
        && task.get("executionId") == Some(&Value::Null))
}
pub fn is_recoverable_watchdog_failure(task: &Value) -> bool {
    if matches!(
        string(task, "failureReason"),
        Some(
            "worker_start_timeout"
                | "terminal_event_timeout"
                | "worker_exit_before_start"
                | "worker_exit_without_terminal_event"
                | "worker_delivery_after_start"
        )
    ) {
        return true;
    }
    let error = string(task, "error").unwrap_or("");
    [
        "worker_start_timeout",
        "timed out waiting for the mandatory terminal worker event",
        "exceeded its inactivity timeout",
        "exited before publishing task.started",
        "exited after task.started without publishing a terminal task event",
        "Worker delivery failed after task.started",
    ]
    .iter()
    .any(|fragment| error.contains(fragment))
}
pub fn is_correlated_worker_event(task: &Value, event: &Value) -> bool {
    let Some(execution_id) = string(task, "executionId") else {
        return false;
    };
    let Some(job_id) = string(event, "job_id") else {
        return false;
    };
    let Some(task_id) = string(task, "id") else {
        return false;
    };
    event_source_id(event).as_deref()
        == Some(execution_event_source(job_id, task_id, execution_id).as_str())
}

pub fn inactivity_deadline(
    task: &Value,
    execution_id: &str,
    post_exit_grace_ms: i64,
    now: i64,
) -> i64 {
    let history_start = task["executionHistory"]
        .as_array()
        .and_then(|items| {
            items
                .iter()
                .find(|item| string(item, "id") == Some(execution_id))
        })
        .and_then(|item| string(item, "startedAt"));
    // JS nullish-coalescing: invalid lastProgressAt takes precedence over valid history timestamps.
    let progress_at = string(task, "lastProgressAt")
        .or(history_start)
        .or_else(|| string(task, "updatedAt"))
        .and_then(parse_ms)
        .unwrap_or(now);
    let timeout_ms = task
        .get("timeoutMs")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        .max(1);
    let timeout_at = progress_at.saturating_add(timeout_ms);
    let exit_at = if !matches!(string(task, "adapter"), Some("chatgpt" | "z")) {
        string(task, "processExitedAt").and_then(parse_ms)
    } else {
        None
    };
    exit_at.map_or(timeout_at, |ms| {
        timeout_at.min(ms.saturating_add(post_exit_grace_ms))
    })
}
pub fn arm_deadline(
    task: &Value,
    execution_id: &str,
    post_exit_grace_ms: i64,
    now: i64,
) -> Option<i64> {
    if !task.get("jobId").is_some_and(js_truthy)
        || string(task, "executionId") != Some(execution_id)
        || !matches!(string(task, "state"), Some("QUEUED" | "RUNNING"))
    {
        return None;
    }
    Some((inactivity_deadline(task, execution_id, post_exit_grace_ms, now) - now).max(1))
}
/// Timers use generation-specific cancellation flags; a superseded timer may never expire a new execution.
#[derive(Default)]
pub struct WatchdogTimers {
    timers: HashMap<String, Arc<AtomicBool>>,
}
impl WatchdogTimers {
    pub fn cancel(&mut self, task_id: &str) {
        if let Some(flag) = self.timers.remove(task_id) {
            flag.store(true, Ordering::Release);
        }
    }
    pub fn arm(
        &mut self,
        task: &Value,
        execution_id: &str,
        post_exit_grace_ms: i64,
        on_expire: impl FnOnce() + Send + 'static,
    ) -> Option<i64> {
        let task_id = string(task, "id")?.to_string();
        self.cancel(&task_id);
        let delay = arm_deadline(task, execution_id, post_exit_grace_ms, now_ms())?;
        let cancelled = Arc::new(AtomicBool::new(false));
        self.timers.insert(task_id, Arc::clone(&cancelled));
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(delay as u64));
            if !cancelled.load(Ordering::Acquire) {
                on_expire();
            }
        });
        Some(delay)
    }
}
impl Drop for WatchdogTimers {
    fn drop(&mut self) {
        for flag in self.timers.values() {
            flag.store(true, Ordering::Release);
        }
    }
}
/// Equivalent to acceptTaskProgress eligibility plus mutation. A durable transition adapter must
/// apply the returned Task atomically through the Task Graph before publishing success.
pub fn task_progress_mutation(task: &Value, event: &Value, now: i64) -> Option<Value> {
    if string(task, "state") != Some("RUNNING") || !is_correlated_worker_event(task, event) {
        return None;
    }
    let parsed = parse_ms(string(event, "timestamp")?)?;
    if parsed > now {
        return None;
    }
    if string(task, "lastProgressEventAt")
        .and_then(parse_ms)
        .is_some_and(|prior| parsed <= prior)
    {
        return None;
    }
    // In JS, invalid previous Date.parse becomes NaN and therefore rejects the new event.
    if string(task, "lastProgressEventAt").is_some_and(|previous| parse_ms(previous).is_none()) {
        return None;
    }
    let mut next = task.clone();
    let received = DateTime::<chrono::Utc>::from_timestamp_millis(now)?
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    next["lastProgressAt"] = json!(received);
    next["lastProgressEventAt"] = event["timestamp"].clone();
    next["updatedAt"] = json!(received);
    Some(next)
}
