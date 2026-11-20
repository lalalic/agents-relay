// Original task-actions.ts public API differential: snapshot appliers and
// dispatch over real lifecycle/resolution Graph state, comparing task state
// transitions, errors, and mutated fields for all exported actions.
use agents_relay_rust2::task_actions::{
    apply_task_cancel_action, apply_task_hold_action, apply_task_queue_action,
    apply_task_release_action, apply_task_retry_action,
    apply_task_unblock_retry_action, dispatch_task_action_snapshot,
};
use serde_json::{json, Value};
use std::path::PathBuf;

fn graph() -> PathBuf {
    // The real lifecycle/resolution Graph definitions live in the repo
    // workflow directory; the appliers parse them like production.
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../workflow")
}
fn normalize(task: &Value) -> Value {
    let mut out = task.clone();
    if let Some(map) = out.as_object_mut() {
        if let Some(slot) = map.get_mut("updatedAt") {
            if slot.as_str().is_some() {
                *slot = json!("<now>");
            }
        }
        // Materialized resolutions carry their own generated timestamp.
        if let Some(slot) = map.get_mut("resolution") {
            if let Some(updated) = slot.get_mut("updatedAt") {
                if updated.as_str().is_some() {
                    *updated = json!("<now>");
                }
            }
        }
    }
    out
}

pub fn invoke(request: &Value) -> Option<Result<String, String>> {
    if request["op"] != "certTaskActions" {
        return None;
    }
    Some((|| {
        let directory = graph();
        let result = (|| {
            let method = request["method"].as_str().unwrap_or("");
            // All appliers mutate in place and return Result<(), String>.
            let run = |task: &mut Value| -> Result<(), String> {
                match method {
                    "retry" => apply_task_retry_action(
                        &directory, task,
                        request["extendBudget"].as_bool().unwrap_or(false),
                        ""),
                    "unblockRetry" => apply_task_unblock_retry_action(
                        &directory, task, ""),
                    "tryCancel" => apply_task_cancel_action(
                        &directory, task,
                        request["reason"].as_str().unwrap_or(""),
                        ""),
                    "release" => apply_task_release_action(
                        &directory, task, ""),
                    "hold" => apply_task_hold_action(
                        &directory, task, ""),
                    "queue" => apply_task_queue_action(
                        &directory,
                        &mut request["job"].clone(), task, ""),
                    value => Err(format!(
                        "Unknown task action method {value}")),
                }
            };
            if method == "dispatch" {
                return match dispatch_task_action_snapshot(
                    &directory,
                    &request["job"].clone(),
                    &request["request"].clone(),
                    None,
                ) {
                    Ok((job, task)) => {
                        // Normalize generated timestamps inside the job's
                        // task list as well as the returned task.
                        let mut job = job;
                        if let Some(tasks) = job.get_mut("tasks")
                            .and_then(Value::as_array_mut) {
                            for task in tasks.iter_mut() {
                                for key in ["updatedAt", "createdAt"] {
                                    if let Some(slot) = task.get_mut(key) {
                                        if slot.as_str().is_some() {
                                            *slot = json!("<now>");
                                        }
                                    }
                                }
                                if let Some(resolution) =
                                    task.get_mut("resolution")
                                {
                                    if let Some(updated) =
                                        resolution.get_mut("updatedAt")
                                    {
                                        if updated.as_str().is_some() {
                                            *updated = json!("<now>");
                                        }
                                    }
                                }
                            }
                        }
                        Ok(json!({"ok":true,
                            "job":job,
                            "task":normalize(&task)}).to_string())
                    }
                    Err(error) => {
                        Ok(json!({"ok":false,"error":error}).to_string())
                    }
                };
            }
            let mut task = request["task"].clone();
            match run(&mut task) {
                Ok(()) => Ok(json!({"ok":true,
                    "task":normalize(&task)}).to_string()),
                Err(error) => Ok(json!({"ok":false,"error":error}).to_string()),
            }
        })();
        result
    })())
}
