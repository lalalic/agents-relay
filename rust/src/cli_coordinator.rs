// Node provenance: src/cli-coordinator.ts. Validate an ordinary DAG
// Coordinator start and bind immutable execution roots without another scheduler.
use serde_json::{json, Value};

pub fn validate_coordinator_args(
    args: &[String], foreground_configured: bool,
) -> Result<(), String> {
    let has = |name: &str| args.iter().any(|item| item == name);
    if ["--shortcut-local", "--legacy-shortcut-runtime", "--event-json", "--mode"]
        .iter().any(|flag| has(flag)) {
        return Err("Legacy Shortcut runners and execution modes are removed".into());
    }
    if has("--foreground") && !foreground_configured {
        return Err("Foreground runner not configured".into());
    }
    Ok(())
}
/// For use *inside* an authoritative mutateJob transaction. The caller owns
/// Graph parsing and invokes the canonical Graph transition callback.
pub fn bind_coordinator_start<Queue, Activate>(
    job: &Value, task_id: &str, agent_graph: &str,
    project_root: &str, workspace_root: &str,
    shared_root: Option<&str>, global_root: Option<&str>,
    no_github: bool, foreground: bool,
    mut queue_task: Queue, mut activate_job: Activate,
) -> Result<Value, String>
where
    Queue: FnMut(&mut Value) -> bool,
    Activate: FnMut(&mut Value) -> bool,
{
    let mut current = job.clone();
    let index = current.get("tasks").and_then(Value::as_array)
        .and_then(|tasks| tasks.iter().position(|task|
            task.get("id").and_then(Value::as_str) == Some(task_id)))
        .ok_or("Coordinator Task disappeared")?;
    let existing = current["tasks"][index].get("agentGraph").and_then(Value::as_str).unwrap_or("");
    if !existing.is_empty() && existing != agent_graph {
        return Err("Coordinator Graph changed after creation".into());
    }
    let state = current["tasks"][index].get("state")
        .and_then(Value::as_str).unwrap_or("");
    let current_state = current.get("state").and_then(Value::as_str).unwrap_or("");
    if !matches!(state, "DRAFT" | "QUEUED" | "RUNNING")
        && !(foreground && current_state == "ACTIVE" && !existing.is_empty()) {
        return Err("Coordinator Task is not startable".into());
    }
    if existing.is_empty() {
        if !matches!(state, "DRAFT" | "QUEUED") {
            return Err("Graph cannot change after execution started".into());
        }
        current["tasks"][index]["agentGraph"] = json!(agent_graph);
    }
    if state == "DRAFT" {
        if current["tasks"][index].get("dependencies")
            .and_then(Value::as_array).is_some_and(|dependencies| !dependencies.is_empty())
        { return Err("Coordinator has unmet dependencies".into()); }
        if !queue_task(&mut current["tasks"][index]) {
            return Err("Coordinator Task queue denied".into());
        }
    }
    let mut binding = json!({
        "projectRoot": project_root, "workspaceRoot": workspace_root,
        "noGitHub": no_github,
    });
    if let Some(root) = shared_root { binding["sharedRoot"] = json!(root); }
    if let Some(root) = global_root { binding["globalRoot"] = json!(root); }
    if let Some(existing) = current.get("graphStartContext").filter(|v| !v.is_null()) {
        for key in ["projectRoot", "workspaceRoot", "sharedRoot", "globalRoot", "noGitHub"] {
            if existing.get(key) != binding.get(key) {
                return Err("Coordinator start context differs from original binding".into());
            }
        }
    } else { current["graphStartContext"] = binding; }
    if current_state == "DRAFT" {
        if !activate_job(&mut current) { return Err("Job Lifecycle rejected activation".into()); }
    } else if current_state != "ACTIVE" {
        return Err(format!("Job is not runnable: {current_state}"));
    }
    Ok(current)
}
