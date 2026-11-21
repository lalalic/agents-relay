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


// In production the ordinary daemon owns all Task/Graph/SQLite mutations.
// This is strictly a foreground CLI attachment: it invokes the SAME daemon
// reconciler route and reads durable events, never starts a parallel Worker.
#[derive(Debug,Clone)]
pub struct ForegroundAttachResult{
    pub job:Value,
    pub interrupted_signal:Option<i32>,
}
/// Synchronous daemon attachment. Callbacks are the actual HTTP control
/// endpoints in the native CLI; also injectible for isolation/replay tests.
pub fn attach_foreground_daemon<Load,Reconcile,Events,Report>(
    job_id:&str,task_id:&str,
    mut load:Load,mut reconcile:Reconcile,mut events:Events,
    mut report:Report,poll:Duration,interrupted:&std::sync::atomic::AtomicI32,
)->Result<ForegroundAttachResult,String>
where
    Load:FnMut()->Result<Value,String>,
    Reconcile:FnMut()->Result<(),String>,
    Events:FnMut()->Result<Vec<Value>,String>,
    Report:FnMut(String),
{
    let mut reporter=ForegroundReporter::default();
    let mut paused_reported=false;
    report(format!("Coordinator job {job_id}, task {task_id}: foreground daemon attachment (Ctrl+C detaches CLI; daemon-owned Workers continue and Job remains durable)"));
    loop{
        let signal=interrupted.load(Ordering::SeqCst);
        if signal!=0{
            report(format!("Leaving foreground for Job {job_id}; daemon-owned Workers continue and the durable Job remains active unless independently completed or cancelled."));
            return Ok(ForegroundAttachResult{
                job:load()?,interrupted_signal:Some(signal),
            });
        }
        let job=load()?;
        reporter.refresh_names(&job);
        // Polling the authoritative daemon event history is the CLI
        // replacement for Node's local Reconciler/EventBus subscription.
        // Duplicate and foreign-Job event IDs are suppressed across polls.
        for event in events()?{
            if let Some(line)=reporter.on_event(job_id,&event){report(line);}
        }
        let state=job.get("state").and_then(Value::as_str).unwrap_or("");
        if matches!(state,"COMPLETED"|"CANCELLED"){
            report(format!("Job {job_id}: {state}"));
            return Ok(ForegroundAttachResult{
                job,interrupted_signal:None,
            });
        }
        let paused=job.get("pause").is_some_and(|value|!value.is_null());
        if paused&&!paused_reported{
            report(format!("Job {job_id}: PAUSED (waiting for resume)"));
            paused_reported=true;
        }
        if !paused{paused_reported=false;}
        reconcile()?;
        let updated=load()?;
        let state=updated.get("state").and_then(Value::as_str).unwrap_or("");
        if matches!(state,"COMPLETED"|"CANCELLED"){continue;}
        // Do not sleep uninterruptibly. A SIGINT/SIGTERM must not wait an
        // entire watchdog interval, nor mutate/abandon the durable Task.
        let mut remaining=poll;
        while !remaining.is_zero(){
            if interrupted.load(Ordering::SeqCst)!=0{break;}
            let slice=remaining.min(Duration::from_millis(40));
            std::thread::sleep(slice);
            remaining=remaining.saturating_sub(slice);
        }
    }
}
