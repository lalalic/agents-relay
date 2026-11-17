// Direct port of Node src/workflow/task-action-policy.ts: selects original-Task-related cancellation
// only after the canonical Task Related Action Mermaid graph authorizes it.
use super::task_related_action_v2::decide_related_task_action;
use serde_json::{json, Value};
use std::path::Path;
pub fn select_related_task_mutations(
    directory: &Path,
    job: &Value,
    task: &Value,
    action_id: &str,
) -> Result<Vec<Value>, String> {
    let mut selected = Vec::new();
    for candidate in job["tasks"].as_array().into_iter().flatten() {
        let decision = decide_related_task_action(directory, task, candidate, action_id)?;
        if decision["accepted"] != true || decision["target"] != "selected" {
            continue;
        }
        selected.push(json!({"taskId":candidate["id"],"mutation":"cancel",
            "reason":format!("Superseded by manual retry of {}",task["id"].as_str().unwrap_or("undefined"))}));
    }
    Ok(selected)
}
