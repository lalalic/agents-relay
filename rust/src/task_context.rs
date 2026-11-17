// Direct port of Node src/task-context.ts: execution-bound Task read context, historic comments and managed reference-only prompts.
use crate::{final_review_role::is_final_review_agent, observability::json_wire};
use serde_json::{json, Map, Value};
fn string<'a>(input: &'a Value, key: &str) -> &'a str {
    input.get(key).and_then(Value::as_str).unwrap_or("")
}
fn field(input: &Value, key: &str, output: &mut Map<String, Value>) {
    if let Some(value) = input.get(key) {
        output.insert(key.to_string(), value.clone());
    }
}
fn related_task(item: &Value) -> Value {
    let mut out = Map::new();
    for key in ["id", "title", "state", "attempt", "executionId"] {
        field(item, key, &mut out);
    }
    out.insert(
        "resolution".into(),
        item.get("resolution").cloned().unwrap_or(Value::Null),
    );
    out.insert(
        "escalation".into(),
        item.get("escalation").cloned().unwrap_or(Value::Null),
    );
    out.insert(
        "comments".into(),
        item.get("comments").cloned().unwrap_or(json!([])),
    );
    for key in ["result", "error", "failureReason"] {
        field(item, key, &mut out);
    }
    Value::Object(out)
}
fn current_task_history(item: &Value) -> Value {
    let mut out = Map::new();
    for key in ["id", "state", "attempt", "executionId"] {
        field(item, key, &mut out);
    }
    out.insert(
        "resolution".into(),
        item.get("resolution").cloned().unwrap_or(Value::Null),
    );
    out.insert(
        "escalation".into(),
        item.get("escalation").cloned().unwrap_or(Value::Null),
    );
    out.insert(
        "comments".into(),
        item.get("comments").cloned().unwrap_or(json!([])),
    );
    Value::Object(out)
}
fn related<'a>(job: &'a Value, task: &'a Value) -> Vec<&'a Value> {
    let tasks = job
        .get("tasks")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    if string(task, "agentName") == "troubleshooter" {
        return tasks
            .iter()
            .filter(|item| item.get("id") == task.get("parentTaskId"))
            .collect();
    }
    if is_final_review_agent(task.get("agentName").and_then(Value::as_str)) {
        return task
            .get("dependencies")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|id| tasks.iter().find(|item| item.get("id") == Some(id)))
            .collect();
    }
    Vec::new()
}
pub fn task_execution_context(
    job: &Value,
    task_id: &str,
    execution_id: &str,
) -> Result<Value, String> {
    if execution_id.is_empty() {
        return Err("task context requires --execution-id".into());
    }
    let task = job
        .get("tasks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|item| item.get("id").and_then(Value::as_str) == Some(task_id))
        .ok_or_else(|| format!("Task {task_id} not found"))?;
    let state = string(task, "state");
    if string(task, "executionId") != execution_id || !matches!(state, "QUEUED" | "RUNNING") {
        return Err(format!(
            "Stale Task execution {task_id}/{execution_id}; current state {state}"
        ));
    }
    let mut job_summary = Map::new();
    for key in ["id", "repository", "title", "objective", "state"] {
        field(job, key, &mut job_summary);
    }
    let dependencies = task
        .get("dependencies")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|id| {
            job.get("tasks")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .find(|item| item.get("id") == Some(id))
                .cloned()
                .unwrap_or_else(|| json!({"id":id,"missing":true}))
        })
        .collect::<Vec<_>>();
    let plan = job
        .get("plans")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|plan| plan.get("id") == task.get("planningDecisionId"))
        .cloned()
        .unwrap_or(Value::Null);
    let mut output = Map::new();
    output.insert("job".into(), Value::Object(job_summary));
    output.insert("task".into(), task.clone());
    output.insert("currentState".into(), json!(state));
    output.insert(
        "resolution".into(),
        task.get("resolution").cloned().unwrap_or(Value::Null),
    );
    output.insert(
        "escalation".into(),
        task.get("escalation").cloned().unwrap_or(Value::Null),
    );
    output.insert(
        "comments".into(),
        task.get("comments").cloned().unwrap_or(json!([])),
    );
    output.insert(
        "relevantTasks".into(),
        json!(related(job, task)
            .iter()
            .map(|item| related_task(item))
            .collect::<Vec<_>>()),
    );
    output.insert("dependencies".into(), json!(dependencies));
    output.insert("plan".into(), plan);
    Ok(Value::Object(output))
}
pub fn task_agent_history_context(job: &Value, task: &Value) -> String {
    if string(task, "agentName") != "troubleshooter"
        && !is_final_review_agent(task.get("agentName").and_then(Value::as_str))
    {
        return String::new();
    }
    let history = json!({"currentTask":current_task_history(task),
        "relatedTasks":related(job,task).iter().map(|item|related_task(item)).collect::<Vec<_>>()});
    // Node uses JSON.stringify with two-space indentation and the exact
    // currently-present property list; absent optionals must not be emitted.
    let body = serde_json::to_string_pretty(&history).unwrap_or_default();
    format!("\n\n[Authoritative task state and append-only comments]\n{body}\nTreat comments as supplementary history. Re-evaluate historical conditions using evidence from the original failing execution; a human response or prior condition alone does not prove recovery.")
}
pub fn task_reference_prompt(
    repository: &str,
    job_id: &str,
    task_id: &str,
    execution_id: &str,
    managed_input: Option<&str>,
) -> Result<String, String> {
    if managed_input.is_some_and(|input| !input.contains("[Required event contracts]")) {
        return Err(format!(
            "Missing required event contract references for {job_id}/{task_id}/{execution_id}"
        ));
    }
    let source = format!("job/{job_id}/task/{task_id}/execution/{execution_id}");
    Ok(format!("[Agents Relay managed task]\nRepository: {repository}\nJob ID: {job_id}\nTask ID: {task_id}\nExecution ID: {execution_id}\nExecution source: {source}\n\n[Required event contracts]\nThe required Relay event contracts are supplied in the managed task input.\nRead those pinned contracts before execution.\n\nRetrieve the authoritative Task Context:\n  agents-relay task context --repo {repository} --id {job_id} --task-id {task_id} --execution-id {execution_id}\nVerify the execution identity and follow the durable Task context. Relay owns completion and review."))
}
// Ensure this Node JSON wire serializer is exercised by direct fixture adapters.
pub fn task_agent_history_json_wire(job: &Value, task: &Value) -> String {
    json_wire(&json!(task_agent_history_context(job, task)))
}
