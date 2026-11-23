// Direct port of Node src/runtime-summary.ts: only genuinely leased LIVE executions contribute to worker/model totals.
use chrono::{DateTime, NaiveDate, NaiveDateTime};
use serde_json::{json, Value};
use std::collections::HashMap;

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64() != Some(0.0),
        _ => true,
    }
}
fn parse_date_ms(raw: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|timestamp| timestamp.timestamp_millis())
        .or_else(|| {
            NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M:%S")
                .ok()
                .map(|date| date.and_utc().timestamp_millis())
        })
        .or_else(|| {
            NaiveDate::parse_from_str(raw, "%Y-%m-%d")
                .ok()
                .and_then(|date| date.and_hms_opt(0, 0, 0))
                .map(|date| date.and_utc().timestamp_millis())
        })
}
fn effective_adapter(task: &Value) -> Value {
    task.pointer("/workerSelection/adapter")
        .filter(|value| !value.is_null())
        .or_else(|| task.get("adapter"))
        .cloned()
        .unwrap_or(Value::Null)
}
pub fn running_worker(task: &Value) -> Option<&'static str> {
    if text(task, "state") != Some("RUNNING") {
        return None;
    }
    match effective_adapter(task).as_str() {
        Some("chatgpt") => Some("chatgpt"),
        Some("codex") => Some("codex"),
        _ => None,
    }
}
pub fn has_live_execution(job: &Value, task: &Value, now_ms: i64) -> bool {
    if text(job, "state") != Some("ACTIVE") || text(task, "state") != Some("RUNNING") {
        return false;
    }
    truthy(task.get("executionId"))
}
pub fn summarize_runtime(jobs: &[Value], now_ms: i64) -> Value {
    let mut active_jobs = 0usize;
    let mut running_tasks = 0usize;
    let mut chatgpt = 0usize;
    let mut codex = 0usize;
    let mut models: HashMap<String, usize> = HashMap::new();
    let mut running = Vec::new();
    for job in jobs {
        if text(job, "state") == Some("ACTIVE") {
            active_jobs += 1;
        }
        for task in job
            .get("tasks")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if !has_live_execution(job, task, now_ms) {
                continue;
            }
            running_tasks += 1;
            match running_worker(task) {
                Some("chatgpt") => chatgpt += 1,
                Some("codex") => codex += 1,
                _ => {}
            }
            if let Some(model) = task
                .pointer("/routing/model")
                .and_then(Value::as_str)
                .filter(|model| !model.is_empty())
            {
                *models.entry(model.to_string()).or_default() += 1;
            }
            running.push(json!({
                "repository":job["repository"],"prNumber":job["prNumber"],"jobId":job["id"],
                "jobTitle":job["title"],"taskId":task["id"],"agentName":task["agentName"],
                "worker":effective_adapter(task),"provider":task.pointer("/routing/provider").unwrap_or(&Value::Null),
                "model":task.pointer("/routing/model").unwrap_or(&Value::Null),
                "executionId":task["executionId"],
            }));
        }
    }
    let mut ordered = models.into_iter().collect::<Vec<_>>();
    ordered.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let models = ordered
        .into_iter()
        .map(|(model, count)| json!({"model":model,"count":count}))
        .collect::<Vec<_>>();
    json!({"activeJobs":active_jobs,"runningTasks":running_tasks,
        "workers":{"chatgpt":chatgpt,"codex":codex},"models":models,"running":running})
}
