// Node provenance: src/single-job-task-control.ts. Admit only the six
// daemon Graph-backed Task commands within the exact bound local Job.
// The command admission mirrors the original JS `String(body.command ?? '')`
// coercion and the bound-Job fence is a strict string equality.
use serde_json::Value;
use std::future::Future;

const ALLOWED_COMMANDS: [&str; 6] = [
    "task.unblock", "task.recover", "task.escalate",
    "task.resume-troubleshooter", "task.classify", "task.revise",
];

/// JS String(value ?? '') coercion: null/undefined take the empty-string
/// default; numbers, booleans, arrays and objects convert like String().
fn js_command_string(value:&Value)->String{
    let Some(value)=value.as_str() else{
        return match value{
            Value::Null=>String::new(),
            Value::Bool(v)=>v.to_string(),
            Value::Number(n)=>n.to_string(),
            Value::String(s)=>s.clone(),
            Value::Array(items)=>items.iter()
                .map(|item|match item{
                    Value::Null=>String::new(),
                    Value::Bool(v)=>v.to_string(),
                    Value::Number(n)=>n.to_string(),
                    Value::String(s)=>s.clone(),
                    _=>String::new(),
                }).collect::<Vec<_>>().join(","),
            Value::Object(_)=>"[object Object]".into(),
        };
    };
    value.to_string()
}

pub fn validate_single_job_control(job_id: &str, body: &Value) -> Result<(), String> {
    let command=body.get("command")
        .map(js_command_string)
        .unwrap_or_default();
    if !ALLOWED_COMMANDS.contains(&command.as_str()) {
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
