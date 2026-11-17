// Direct port of Node src/execution-event-identity.ts: execution-scoped source IDs and short-lived terminal-event claims.
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

const TERMINAL_CLAIM_TTL: Duration = Duration::from_secs(60);

pub fn execution_event_source(job_id: &str, task_id: &str, execution_id: &str) -> String {
    format!("job/{job_id}/task/{task_id}/execution/{execution_id}")
}
pub fn event_source_id(event: &Value) -> Option<String> {
    event.get("source")?.get("id")?.as_str().map(str::to_string)
}
pub fn execution_id_from_source(
    source_id: Option<&str>,
    job_id: &str,
    task_id: &str,
) -> Option<String> {
    let prefix = format!("job/{job_id}/task/{task_id}/execution/");
    source_id?
        .strip_prefix(&prefix)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}
fn claims() -> &'static Mutex<HashMap<String, Instant>> {
    static CLAIMS: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    CLAIMS.get_or_init(|| Mutex::new(HashMap::new()))
}
/// Preserve the first deadline: JS Set.add does not extend an earlier timer.
pub fn claim_terminal_execution(source_id: &str) {
    let now = Instant::now();
    let mut claims = claims().lock().expect("terminal claim lock");
    claims.retain(|_, expires| *expires > now);
    claims
        .entry(source_id.to_string())
        .or_insert(now + TERMINAL_CLAIM_TTL);
}
pub fn terminal_execution_claimed(job_id: &str, task_id: &str, execution_id: &str) -> bool {
    let now = Instant::now();
    let mut claims = claims().lock().expect("terminal claim lock");
    claims.retain(|_, expires| *expires > now);
    claims.contains_key(&execution_event_source(job_id, task_id, execution_id))
}
