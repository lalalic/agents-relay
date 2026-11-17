// Direct port of src/managed-worker-input.ts: provider-neutral work-prompt
// assembly. The selected Agent Contract and Execution Context come from the
// caller's canonical resolver. No Relay state or GitHub discovery is performed.
use crate::{
    agent_prompt_builder::{build_agent_prompt, build_relay_work_prompt, render_agent_prompt},
    final_review_role::is_final_review_agent,
};
use regex::Regex;
use serde_json::{json, Value};
use std::path::Path;

fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null | Value::Bool(false) => false,
        Value::String(s) => !s.is_empty(),
        Value::Number(n) => n.as_f64() != Some(0.0),
        _ => true,
    }
}
pub fn managed_worker_input<F>(
    job: &Value,
    task: &Value,
    context: Option<&Value>,
    mode: &str,
    package_root: &Path,
    mut resolve_agent: F,
    reference_directory: Option<&str>,
) -> Result<String, String>
where
    F: FnMut(&Value, &str) -> Result<Value, String>,
{
    let adapter = text(task, "adapter");
    if !matches!(adapter, "codex" | "chatgpt" | "z") || !truthy(&job["repository"]) {
        return Ok(text(task, "input").into());
    }
    let task_id = text(task, "id");
    if !truthy(&task["output"]) {
        return Err(format!(
            "Task {task_id} requires an explicit output contract"
        ));
    }
    if !truthy(&task["executionId"]) {
        return Err(format!(
            "Task {task_id} requires an executionId before worker input is built"
        ));
    }
    let context =
        context.ok_or_else(|| format!("Task {task_id} requires resolved execution context"))?;
    let name = task["agentName"]
        .as_str()
        .filter(|v| !v.is_empty())
        .unwrap_or("implementation");
    let selected = resolve_agent(context, name)?;
    if mode == "production" {
        let task_runtime = task
            .pointer("/workerRequirements/runtime")
            .and_then(Value::as_str)
            .filter(|runtime| !runtime.is_empty());
        let selected_runtime = selected
            .pointer("/agent/runtime")
            .and_then(Value::as_str)
            .filter(|runtime| !runtime.is_empty());
        if let Some(required) = task_runtime.or(selected_runtime) {
            if required != adapter {
                return Err(format!(
                    "Agent {name} requires {required} runtime; {adapter} cannot launch this Task"
                ));
            }
        }
    }
    let agent = text(&selected, "definition");
    let role = if is_final_review_agent(Some(name)) {
        "reviewer"
    } else if matches!(name, "planner" | "troubleshooter") {
        name
    } else {
        "worker"
    };
    if mode == "evaluation" {
        // Remove event-emission instructions from evaluation-only prompts.
        let regex=Regex::new(r"(?m)^.*(?:task\.started|task\.completed|task\.failed|events__publish|EVENTS_BUS_EMIT).*\n?")
            .map_err(|e|e.to_string())?;
        let safe = regex.replace_all(agent, "");
        let system=format!("{safe}\n\n[Read-only evaluation safety boundary]\nDo not use tools, files, events or external services. Evaluate the role instructions as criteria only.");
        let user = format!(
            "[Isolated prompt evaluation mode]\nTask: {task_id}\n{}",
            text(task, "input")
        );
        let prompt = build_agent_prompt(&json!({"role":role,"system":system,"user":user}))?;
        return Ok(render_agent_prompt(&prompt, adapter));
    }
    let skills = context["skills"].as_array().cloned().unwrap_or_default();
    let event = skills.iter().find(|v| text(v, "name") == "events-bus");
    let ponytail = skills.iter().find(|v| text(v, "name") == "ponytail");
    let mut contracts = Vec::<String>::new();
    if let Some(event) = event {
        let path = Path::new(text(event, "path"));
        let protocol = path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("references/protocol.md");
        if protocol.exists() {
            contracts.push(protocol.to_string_lossy().into_owned());
        }
    }
    let contract = |name: &str| {
        package_root
            .join("skills/agents-relay/contracts")
            .join(name)
            .to_string_lossy()
            .into_owned()
    };
    contracts.extend(
        ["task-job-contract.md", "event-contract.md"]
            .into_iter()
            .map(contract),
    );
    if role == "troubleshooter" {
        contracts.extend(
            ["task-recovery-flows.md", "blocker-job-recovery.md"]
                .into_iter()
                .map(contract),
        );
    }
    if role == "worker" {
        if let Some(ponytail) = ponytail {
            contracts.push(text(ponytail, "path").into());
        }
        if !truthy(&task["review"]) && name != "review-chair" {
            contracts.push(contract("worker-self-review.md"));
        }
    }
    let contexts = context["instructions"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|item| text(item, "path").ends_with("/AGENTS.md"))
        .collect::<Vec<_>>();
    let project_root = context
        .pointer("/project/gitRoot")
        .and_then(Value::as_str)
        .or_else(|| context.pointer("/project/path").and_then(Value::as_str))
        .unwrap_or("");
    let provider = context
        .pointer(&format!("/providerInstructions/{adapter}"))
        .cloned()
        .unwrap_or(Value::Null);
    let input = json!({
        "agentName":name,"suggestedSkills":selected["agent"]["suggestedSkills"],
        "agentContent":agent,"adapter":adapter,
        "contracts":contracts,"contexts":contexts,"projectPath":project_root,
        "providerInstructions":provider,
        "skillPath":package_root.join("skills/agents-relay/SKILL.md").to_string_lossy().to_string(),
        "taskTitle":task["title"],"workerSelfReview":role=="worker",
        "jobId":job["id"],"taskId":task["id"],"executionId":task["executionId"]
    });
    build_relay_work_prompt(&input, reference_directory)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_missing_execution_binding_before_resolution() {
        let job = json!({"repository":"local"});
        let task = json!({"id":"23","adapter":"chatgpt","input":"task"});
        let root = Path::new("/tmp/none");
        assert_eq!(
            managed_worker_input(
                &job,
                &task,
                None,
                "production",
                root,
                |_, _| panic!("not reached"),
                None
            )
            .unwrap_err(),
            "Task 23 requires an explicit output contract"
        );
        let task = json!({"id":"23","adapter":"chatgpt","input":"task","output":{"kind":"file"}});
        assert_eq!(
            managed_worker_input(
                &job,
                &task,
                None,
                "production",
                root,
                |_, _| panic!("not reached"),
                None
            )
            .unwrap_err(),
            "Task 23 requires an executionId before worker input is built"
        );
        assert_eq!(
            managed_worker_input(
                &job,
                &json!({"adapter":"shell","input":"plain"}),
                None,
                "production",
                root,
                |_, _| panic!("not reached"),
                None
            )
            .unwrap(),
            "plain"
        );
    }
    #[test]
    fn evaluation_cannot_emit_events_or_use_tools() {
        let context = json!({"project":{"path":"/tmp"}});
        let selected = json!({"definition":"You are a worker.\ntask.completed should publish\nDo test.\n",
            "agent":{"runtime":"chatgpt"}});
        let task = json!({"id":"23","adapter":"chatgpt","input":"task",
            "output":{"kind":"file"},"executionId":"one"});
        let prompt = managed_worker_input(
            &json!({"repository":"local"}),
            &task,
            Some(&context),
            "evaluation",
            Path::new("/tmp"),
            |_, _| Ok(selected.clone()),
            None,
        )
        .unwrap();
        assert!(!prompt.contains("task.completed"));
        assert!(prompt.contains("Read-only evaluation safety boundary"));
    }
}
