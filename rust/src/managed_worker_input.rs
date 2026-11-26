// Direct port of src/managed-worker-input.ts: provider-neutral work-prompt
// assembly. The selected Agent Contract and Execution Context come from the
// caller's canonical resolver. No Relay state or GitHub discovery is performed.
use crate::agent_prompt_builder::{build_relay_work_prompt, PromptLayers};
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
) -> Result<PromptLayers, String>
where
    F: FnMut(&Value, &str) -> Result<Value, String>,
{
    let adapter = text(task, "adapter");
    if adapter != "codex" {
        return Err(format!("Unsupported managed Worker harness: {adapter}"));
    }
    if !truthy(&job["repository"]) {
        return Err("Managed Worker requires a Job repository".into());
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
    if mode == "evaluation" {
        // Remove event-emission instructions from evaluation-only prompts.
        let regex=Regex::new(r"(?m)^.*(?:task\.started|task\.completed|task\.failed|events__publish|EVENTS_BUS_EMIT).*\n?")
            .map_err(|e|e.to_string())?;
        let safe = regex.replace_all(agent, "");
        let policy = crate::declared_contract_loader::load(
            &selected["metadata"],
            package_root,
            "eval",
            None,
            false,
        )?;
        if !policy.provenance.iter().any(|r| {
            r["kind"] == "startup-contract"
                && r["path"]
                    .as_str()
                    .is_some_and(|p| p.ends_with("/evaluation-safety.md"))
        }) {
            return Err("Eval requires explicit evaluation-safety Contract declaration".into());
        }
        let system = format!("{safe}\n\n{}", policy.system);
        let user = format!(
            "[Isolated prompt evaluation mode]\nTask: {task_id}\n{}",
            text(task, "input")
        );
        return PromptLayers::new(system, user, vec![]);
    }
    let selected_refs = crate::agent_context::selected_references(
        &selected["metadata"],
        context,
        package_root,
        adapter,
    )?;
    let project_root = context
        .pointer("/project/gitRoot")
        .and_then(Value::as_str)
        .or_else(|| context.pointer("/project/path").and_then(Value::as_str))
        .unwrap_or("");
    let terminal = if task.get("dagNode").is_some_and(Value::is_object) {
        "dag"
    } else if task["gitDeliveryRequired"] == true {
        "source"
    } else {
        "event"
    };
    let output_kind = task
        .pointer("/output/kind")
        .and_then(Value::as_str)
        .unwrap_or("");
    let artifact = task["artifactChanging"] == true
        || task["gitDeliveryRequired"] == true
        || task.get("dagNode").is_some_and(Value::is_object)
        || matches!(
            output_kind,
            "file" | "artifact" | "media" | "video" | "image"
        );
    let policy = crate::declared_contract_loader::load(
        &selected["metadata"],
        package_root,
        "worker",
        Some(terminal),
        artifact,
    )?;
    let input = json!({
        "agentName":name,"suggestedSkills":selected["agent"]["suggestedSkills"],
        "agentContent":agent,"adapter":adapter,
        "references":selected_refs,
        "requiredSkillNames":crate::agent_context::required_skill_names(&selected["metadata"])?,
        "projectPath":project_root,
        "trustedRuntimePolicy":policy.system,
        "startupContracts":policy.provenance,
        "taskTitle":task["title"],
        "dagNode":task.get("dagNode"),"gitDeliveryRequired":task["gitDeliveryRequired"],
        "repository":job["repository"],
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
        let task = json!({"id":"23","adapter":"codex","input":"task"});
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
        let task = json!({"id":"23","adapter":"codex","input":"task","output":{"kind":"file"}});
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
        assert!(managed_worker_input(
            &job,
            &json!({"adapter":"script","input":"plain"}),
            None,
            "production",
            root,
            |_, _| panic!("not reached"),
            None
        )
        .unwrap_err()
        .contains("Unsupported managed Worker harness"));
    }
    #[test]
    fn evaluation_cannot_emit_events_or_use_tools() {
        let context = json!({"project":{"path":"/tmp"}});
        let selected = json!({"definition":"You are a worker.\ntask.completed should publish\nDo test.\n",
            "agent":{"runtime":"codex"},
            "metadata":{"eval_contracts":"[relay:skills/agents-relay/contracts/evaluation-safety.md]"}});
        let task = json!({"id":"23","adapter":"codex","input":"task",
            "output":{"kind":"file"},"executionId":"one"});
        let prompt = managed_worker_input(
            &json!({"repository":"local"}),
            &task,
            Some(&context),
            "evaluation",
            Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap(),
            |_, _| Ok(selected.clone()),
            None,
        )
        .unwrap();
        assert!(!prompt.system.contains("task.completed"));
        assert!(prompt
            .system
            .contains("Isolated Evaluation Safety Contract"));
    }
}

/// Bind the shared managed-input assembly to the same layered Rust Agent
/// resolver used by other execution-context consumers. No caller-supplied
/// fake selected Agent object is necessary.
pub fn resolve_agent_contract_native(
    context: &Value,
    name: &str,
    package_root: &Path,
) -> Result<Value, String> {
    let agent = context["agents"]
        .as_array()
        .and_then(|agents| agents.iter().find(|a| a["name"] == name))
        .ok_or_else(|| format!("Agent {name} is not visible in the resolved execution context"))?;
    if !agent["path"].as_str().is_some_and(|p| !p.is_empty()) {
        return Err(format!("Agent {name} has no readable Markdown contract"));
    }
    let project = context
        .pointer("/project/path")
        .and_then(Value::as_str)
        .unwrap_or("");
    let layers = crate::agent_content_resolver::agent_source_layers(project, &context["project"]);
    let builtin = package_root.join("skills/agents-relay/agents");
    let resolved = crate::agent_content_resolver::resolve_agent_markdown(
        name,
        &builtin.to_string_lossy(),
        project,
        Some(&layers),
    )?;
    let definition = resolved["content"].as_str().unwrap_or("");
    if definition.trim().is_empty() {
        return Err(format!("Agent {name} Markdown contract is empty"));
    }
    Ok(json!({"agent":agent,"definition":definition,
        "metadata":resolved["metadata"],
        "hash":resolved["hash"],"sources":resolved["sources"]}))
}

pub fn managed_worker_input_resolved(
    job: &Value,
    task: &Value,
    context: Option<&Value>,
    mode: &str,
    package_root: &Path,
    reference_directory: Option<&str>,
) -> Result<PromptLayers, String> {
    managed_worker_input(
        job,
        task,
        context,
        mode,
        package_root,
        |context, name| resolve_agent_contract_native(context, name, package_root),
        reference_directory,
    )
}

#[cfg(test)]
mod native_resolver_tests {
    use super::*;
    use std::fs;
    #[test]
    fn resolves_actual_layered_agent_and_fails_closed_for_invisible_contract() {
        let root =
            std::env::temp_dir().join(format!("rust2-wave3-resolver-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("agents")).unwrap();
        fs::write(
            root.join("agents/implementation.agent.md"),
             "---\nname: implementation\nextends: worker\n---\nYou are the fixture implementation agent.\n",
        )
        .unwrap();
        let context = json!({"project":{"path":root},"agents":[
            {"name":"implementation","path":root.join("agents/implementation.agent.md"),"runtime":"codex"}
        ]});
        let package = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let resolved = resolve_agent_contract_native(&context, "implementation", package).unwrap();
        assert!(resolved["definition"]
            .as_str()
            .unwrap()
            .contains("fixture implementation"));
        assert!(resolved["hash"].as_str().unwrap().len() >= 32);
        assert_eq!(
            resolve_agent_contract_native(&context, "missing", package).unwrap_err(),
            "Agent missing is not visible in the resolved execution context"
        );
        let task = json!({"id":"51","adapter":"codex","executionId":"e51","input":"evaluate locally",
            "output":{"kind":"file"}});
        let prompt = managed_worker_input_resolved(
            &json!({"repository":"myrepo"}),
            &task,
            Some(&context),
            "evaluation",
            package,
            None,
        )
        .unwrap();
        assert!(prompt.system.contains("fixture implementation"));
        assert!(prompt.system.contains("Do not use tools"));
        let _ = fs::remove_dir_all(root);
    }
}
