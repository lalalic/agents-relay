// Node provenance: src/cli-review.ts. Validate review CLI admission and
// produce the exact Graph/host-bound control arguments, not review decisions.
use crate::cli_core_support::{arg, has_arg};
use crate::reviewer_thread::normalize_thread_id;
use serde_json::{json, Value};
use std::path::Path;

pub fn review_request_thread_override(args: &[String]) -> Result<Option<String>, String> {
    if !has_arg(args, "--thread-id") {return Ok(None);}
    normalize_thread_id(&json!(arg(args, "--thread-id", "")), "--thread-id")
}
pub fn interactive_review_request(argv: &[String]) -> Result<Value, String> {
    let Some(action) = argv.first().map(String::as_str) else {
        return Err("review interactive requires --path or begin|wait|fail|abort".into());
    };
    let flags = if action == "request" { &argv[1..] } else { argv };
    if action == "request" || action == "--path" {
        let path = arg(flags, "--path", "");
        let job_id = arg(flags, "--id", "");
        let task_id = arg(flags, "--task-id", "");
        let execution_id = arg(flags, "--execution-id", "");
        if path.is_empty() || !Path::new(path).is_absolute()
            || job_id.is_empty() || task_id.is_empty() || execution_id.is_empty() {
            return Err("review interactive requires --path ABS --id JOB --task-id TASK --execution-id EXEC".into());
        }
        return Ok(json!({
            "path": path,
            "relay": {"jobId":job_id,"taskId":task_id,"executionId":execution_id},
        }));
    }
    if !matches!(action, "begin" | "wait" | "fail" | "abort") {
        return Err("review interactive requires --path or begin|wait|fail|abort".into());
    }
    let args = &argv[1..];
    let job_id = arg(args, "--id", "");
    let task_id = arg(args, "--task-id", "");
    let execution_id = arg(args, "--execution-id", "");
    if job_id.is_empty() || task_id.is_empty() || execution_id.is_empty() {
        return Err("review interactive requires --id --task-id --execution-id".into());
    }
    let reason = arg(args, "--reason", "");
    if action == "fail" && reason.trim().is_empty() {
        return Err("review interactive fail requires --reason".into());
    }
    let mut body = json!({
        "command":format!("review.interactive.{action}"),
        "jobId":job_id, "taskId":task_id, "executionId":execution_id,
    });
    if action == "fail" { body["reason"] = json!(reason); }
    Ok(body)
}
pub fn review_job_request(args: &[String]) -> Result<Value, String> {
    let job_id = arg(args, "--id", "");
    if arg(args, "--repo", "").is_empty() || job_id.is_empty() {
        return Err("review job requires --repo and --id".into());
    }
    let mut body = json!({"command":"review.request","jobId":job_id});
    if let Some(thread_id) = review_request_thread_override(args)? {
        body["threadId"] = json!(thread_id);
    }
    Ok(body)
}
pub fn review_job_response(job: &Value) -> Value {
    json!({
        "jobId":job.get("id"),
        "pr":job.get("prNumber").filter(|value| !value.is_null()).cloned().unwrap_or(json!(0)),
        "reviewerThreadId":job.get("reviewerThreadId"),
        "status":"requested",
        "note":"Relay graph will create the review Task once eligible; this is not a delivery receipt."
    })
}
