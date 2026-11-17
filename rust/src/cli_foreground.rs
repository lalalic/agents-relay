// Node provenance: src/cli-foreground.ts. Foreground CLI is an observer
// of one durable Job and the canonical Reconciler, not another execution mode.
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

pub fn foreground_event_line(event: &Value, names: &HashMap<String, String>) -> String {
    let timestamp = event.get("timestamp").and_then(Value::as_str).unwrap_or("");
    let stamp: String = timestamp.chars().skip(11).take(8).collect();
    let task_id = event.get("task_id").and_then(Value::as_str).unwrap_or("undefined");
    let actor = names.get(task_id).map(String::as_str).unwrap_or(task_id);
    let kind = event.get("type").and_then(Value::as_str).unwrap_or("undefined");
    let message = event.get("message").and_then(Value::as_str).unwrap_or("undefined");
    format!("{stamp}  {actor}  {kind} {message}").trim_end().to_string()
}
pub struct ForegroundReporter {
    pub names: HashMap<String, String>,
    seen: HashSet<String>,
}
impl Default for ForegroundReporter {
    fn default() -> Self { Self { names: HashMap::new(), seen: HashSet::new() } }
}
impl ForegroundReporter {
    pub fn refresh_names(&mut self, job: &Value) {
        if let Some(tasks) = job.get("tasks").and_then(Value::as_array) {
            for task in tasks {
                let Some(id) = task.get("id").and_then(Value::as_str) else {continue;};
                let name = task.get("agentName").and_then(Value::as_str)
                    .filter(|name| !name.is_empty())
                    .or_else(|| task.get("title").and_then(Value::as_str).filter(|s| !s.is_empty()))
                    .unwrap_or(id);
                self.names.insert(id.to_string(), name.to_string());
            }
        }
    }
    /// Suppress duplicate event IDs before printing; bound memory at 4096.
    pub fn on_event(&mut self, job_id: &str, event: &Value) -> Option<String> {
        if event.get("job_id").and_then(Value::as_str) != Some(job_id) { return None; }
        let event_id = event.get("event_id").and_then(Value::as_str)?.to_string();
        if !self.seen.insert(event_id) { return None; }
        if self.seen.len() > 4096 { self.seen.clear(); }
        Some(foreground_event_line(event, &self.names))
    }
}
pub async fn run_foreground_coordinator<Load, LFut, Reconcile, RFut, Report>(
    job_id: &str, task_id: &str,
    mut load: Load, mut reconcile: Reconcile, mut report: Report,
    poll: Duration, cancelled: &AtomicBool,
) -> Result<Value, String>
where
    Load: FnMut() -> LFut, LFut: Future<Output = Result<Value, String>>,
    Reconcile: FnMut() -> RFut, RFut: Future<Output = Result<(), String>>,
    Report: FnMut(String),
{
    let mut paused_reported = false;
    report(format!("Coordinator job {job_id}, task {task_id}: foreground execution (Ctrl+C stops local execution; durable Job stays recoverable)"));
    loop {
        if cancelled.load(Ordering::SeqCst) {
            report(format!("Leaving foreground for Job {job_id}; in-flight local workers are interrupted and Relay recovers their durable Tasks."));
            return load().await;
        }
        let job = load().await?;
        let state = job.get("state").and_then(Value::as_str).unwrap_or("");
        if state == "COMPLETED" || state == "CANCELLED" {
            report(format!("Job {job_id}: {state}"));
            return Ok(job);
        }
        let paused = job.get("pause").is_some_and(|v| !v.is_null());
        if paused && !paused_reported {
            report(format!("Job {job_id}: PAUSED (waiting for resume)"));
            paused_reported = true;
        }
        if !paused { paused_reported = false; }
        reconcile().await?;
        let updated = load().await?;
        let state = updated.get("state").and_then(Value::as_str).unwrap_or("");
        if state == "COMPLETED" || state == "CANCELLED" { continue; }
        std::thread::sleep(poll);
    }
}
