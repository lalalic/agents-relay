// Node provenance: src/cli-prompt.ts. Read-only, execution-bound prompt
// reconstruction, Plan/Task context, and bounded Task event history.
// Prompt builders are injected native adapters; no worker is launched here.
use crate::{
    agent_prompt_builder::PromptLayers,
    cli_core_support::{arg, has_arg, read_file_utf8},
    final_review_role::is_final_review_agent,
    local_merge_lock::iso8601_now,
    task_context::task_execution_context,
    workflow::entity_creation::{create_job_entity, create_task_entity},
};
use serde_json::{json, Value};
use std::{fs, path::Path};

fn field<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn task<'a>(job: &'a Value, task_id: &str) -> Option<&'a Value> {
    job.get("tasks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|t| field(t, "id") == task_id)
}
fn plan<'a>(job: &'a Value, plan_id: &str) -> Option<&'a Value> {
    job.get("plans")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|plan| field(plan, "id") == plan_id)
}
fn output(args: &[String], result: &str) -> Result<String, String> {
    let dest = arg(args, "--output", "");
    if dest.is_empty() {
        return Ok(result.into());
    }
    fs::write(dest, format!("{result}\n")).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dest, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    }
    Ok(String::new())
}
fn role_for_task(task: &Value) -> &'static str {
    if field(task, "agentName") == "troubleshooter" {
        "troubleshooter"
    } else if is_final_review_agent(task.get("agentName").and_then(Value::as_str)) {
        "reviewer"
    } else {
        "worker"
    }
}
pub fn eval_scenario_from_args(
    directory: &Path,
    args: &[String],
    scenario: &Value,
    adapter: &str,
) -> Result<(Value, Value), String> {
    for key in ["--id", "--repo", "--plan-id", "--task-id"] {
        if !arg(args, key, "").is_empty() {
            return Err("prompt --eval-file cannot bind a durable Job or Task".into());
        }
    }
    let project = field(scenario, "projectPath");
    let agent = field(scenario, "agentName");
    let input = field(scenario, "taskInput");
    if project.is_empty()
        || agent.is_empty()
        || input.trim().is_empty()
        || !agent
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err("prompt --eval-file requires projectPath, agentName and taskInput".into());
    }
    let case = field(scenario, "caseId");
    let case = if !case.is_empty()
        && case
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        case
    } else {
        "case"
    };
    let now = iso8601_now();
    let job = json!({
        "id":"EVAL_ONLY","title":"Isolated prompt quality evaluation",
        "repository":"eval/isolated","projectRoot":std::env::current_dir()
            .map_err(|e|e.to_string())?.to_string_lossy(),
        "prNumber":0,"continuation":null,"tasks":[],
        "createdAt":now,"updatedAt":now
    });
    let mut job = create_job_entity(directory, &job, false, &now)?;
    let id = format!("eval-{case}");
    let fields = json!({
        "id":id,"jobId":"EVAL_ONLY","title":case,
        "agentName":agent,"adapter":adapter,"input":input,
        "output":{"kind":"file","path":".evals/reports/evaluation-only.json"},
        "parentTaskId":null,"dependencies":[],"capabilities":[],
        "attempt":0,"maxAttempts":1,"executionId":format!("eval-{case}-isolated"),
        "threadId":null,"result":null,"error":null,"timeoutMs":0,
        "createdAt":now,"updatedAt":now
    });
    let task = create_task_entity(directory, &job, &fields, true, &now)?;
    job["tasks"]
        .as_array_mut()
        .ok_or("Synthetic eval Job missing tasks")?
        .push(task.clone());
    Ok((job, task))
}
/// The explicit `build_worker` callback invokes the native production
/// managedWorkerInput path; it is called twice for isolated evaluation,
/// preserving real production vs evaluation prompt differences.
pub fn run_prompt_command<Context, BuildWorker, BuildPlanner>(
    graph_dir: &Path,
    args: &[String],
    job: Option<&Value>,
    mut resolve_context: Context,
    mut build_worker: BuildWorker,
    mut build_planner: BuildPlanner,
) -> Result<String, String>
where
    Context: FnMut(&str, &str) -> Result<Value, String>,
    BuildWorker: FnMut(&Value, &Value, &Value, &str) -> Result<PromptLayers, String>,
    BuildPlanner: FnMut(&Value, &Value, &str) -> Result<PromptLayers, String>,
{
    let adapter = arg(args, "--adapter", "codex");
    if adapter != "codex" {
        return Err(
            "prompt --adapter must be codex; XChat uses neo bootstrap outside Relay".into(),
        );
    }
    let eval_file = arg(args, "--eval-file", "");
    if !eval_file.is_empty() {
        // Neo Eval is a real Codex Harness client. Run the same native
        // first-use setup/verification as a production Codex Worker before
        // returning its transport, never rely on a manually installed link.
        // Explicit opt-in avoids mutating native state for read-only plans.
        let global_status = if has_arg(args, "--prepare-harness") {
            Some(crate::codex_context_builder::ensure_host_global()?)
        } else {
            None
        };
        let parsed: Value =
            serde_json::from_str(&read_file_utf8(eval_file)?).map_err(|e| e.to_string())?;
        let (job, task) = eval_scenario_from_args(graph_dir, args, &parsed, adapter)?;
        let context = resolve_context(field(&parsed, "projectPath"), "worker")?;
        let production = build_worker(&job, &task, &context, "production")?;
        let evaluation = build_worker(&job, &task, &context, "evaluation")?;
        let result = json!({
            "builder":"managedWorkerInput","mode":"isolated-evaluation",
            "projectPath":context.pointer("/project/path"),
            "agentName":parsed.get("agentName"),"adapter":adapter,
            "productionPrompt":production,"evaluationPrompt":evaluation,
            "evaluationTransport":{"harness":"codex",
                "nativeGlobal":global_status.map(|state|format!("{state:?}")),
                "flags":crate::codex_context_builder::delivery_flags(&evaluation)?}
        });
        return output(
            args,
            &serde_json::to_string_pretty(&result).map_err(|e| e.to_string())?,
        );
    }
    if has_arg(args, "--prepare-harness") {
        return Err("--prepare-harness is restricted to isolated Codex Eval".into());
    }
    let plan_id = arg(args, "--plan-id", "");
    let task_id = arg(args, "--task-id", "");
    if plan_id.is_empty() == task_id.is_empty() {
        return Err("prompt requires exactly one of --plan-id or --task-id".into());
    }
    let job = job.ok_or("prompt requires a durable Job snapshot")?;
    if !arg(args, "--project-path", "").is_empty() {
        return Err(
            "Job --project-path is removed; use --project-root on the independent Git repository"
                .into(),
        );
    }
    let project_path = field(job, "projectRoot");
    let rendered = if !plan_id.is_empty() {
        let selected = plan(job, plan_id)
            .ok_or_else(|| format!("Plan {plan_id} not found in Job {}", field(job, "id")))?;
        let execution = selected
            .get("executionId")
            .and_then(Value::as_str)
            .or_else(|| selected.get("appliedExecutionId").and_then(Value::as_str))
            .filter(|id| !id.is_empty())
            .ok_or_else(|| format!("Plan {plan_id} has no recorded execution identity"))?;
        let boundary = field(selected, "createdAt");
        let history_tasks: Vec<Value> = job
            .get("tasks")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|t| field(t, "createdAt") < boundary)
            .cloned()
            .collect();
        let history_plans: Vec<Value> = job
            .get("plans")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|p| {
                p.get("round").and_then(Value::as_i64).unwrap_or(0)
                    <= selected.get("round").and_then(Value::as_i64).unwrap_or(0)
            })
            .map(|p| {
                if p.get("id") != selected.get("id") {
                    return p.clone();
                }
                let mut plan = p.clone();
                plan["status"] = json!("PLANNING");
                plan["executionId"] = json!(execution);
                plan["generatedTaskIds"] = json!([]);
                if let Some(map) = plan.as_object_mut() {
                    map.remove("appliedExecutionId");
                }
                plan
            })
            .collect();
        let mut historical = job.clone();
        historical["tasks"] = json!(history_tasks);
        historical["plans"] = json!(history_plans);
        let ctx = resolve_context(project_path, "planner")?;
        let mut plan_context = json!({
            "job":historical,"tasks":history_tasks,
            "objective":job.get("objective").or_else(||job.get("description"))
                .or_else(||job.get("title")),
            "previousPlannerTaskId":selected.get("previousPlanId"),
            "planExecution":{"planId":plan_id,"executionId":execution},
            "trigger":selected.get("trigger"),
            "executionContext":ctx
        });
        for key in [
            "guidance",
            "retryFeedback",
            "forceRestate",
            "restateTaskIds",
        ] {
            if let Some(v) = selected.get(key) {
                plan_context[key] = v.clone();
            }
        }
        build_planner(&plan_context, &ctx, adapter)?
    } else {
        let selected = task(job, task_id)
            .ok_or_else(|| format!("Task {task_id} not found in Job {}", field(job, "id")))?;
        if field(selected, "executionId").is_empty() {
            return Err(format!("Task {task_id} has no execution ID"));
        }
        let ctx = resolve_context(project_path, role_for_task(selected))?;
        let mut selected = selected.clone();
        selected["adapter"] = json!(adapter);
        build_worker(job, &selected, &ctx, "production")?
    };
    output(
        args,
        &serde_json::to_string_pretty(&rendered).map_err(|e| e.to_string())?,
    )
}
/// Read-only Plan context is fenced by current PLANNING identity, not merely
/// existence of a historical plan ID.
pub fn run_plan_context_command<Context, Planner>(
    args: &[String],
    job: &Value,
    mut resolve_context: Context,
    mut planner_input: Planner,
) -> Result<String, String>
where
    Context: FnMut(&str, &str) -> Result<Value, String>,
    Planner: FnMut(&Value) -> Result<String, String>,
{
    let plan_id = arg(args, "--plan-id", "");
    let execution = arg(args, "--execution-id", "");
    if plan_id.is_empty() || execution.is_empty() {
        return Err("plan context requires --plan-id and --execution-id".into());
    }
    let selected = plan(job, plan_id);
    if selected
        .is_none_or(|p| field(p, "status") != "PLANNING" || field(p, "executionId") != execution)
    {
        return Err(format!(
            "Stale Plan execution {plan_id}/{execution}; current state {}",
            selected.map(|p| field(p, "status")).unwrap_or("not-found")
        ));
    }
    if !arg(args, "--project-path", "").is_empty() {
        return Err(
            "Job --project-path is removed; use the independent Git repository root".into(),
        );
    }
    let selected = selected.expect("validated planning round");
    let context = resolve_context(field(job, "projectRoot"), "planner")?;
    let mut input = json!({
        "job":job,"tasks":job.get("tasks"),
        "objective":job.get("objective").or_else(||job.get("description"))
            .or_else(||job.get("title")),
        "planExecution":{"planId":plan_id,"executionId":execution},
        "executionContext":context
    });
    if let Some(value) = selected.get("previousPlanId") {
        input["previousPlannerTaskId"] = value.clone();
    }
    if let Some(value) = selected.get("trigger") {
        input["trigger"] = value.clone();
    }
    for key in [
        "guidance",
        "retryFeedback",
        "forceRestate",
        "restateTaskIds",
    ] {
        if let Some(v) = selected.get(key) {
            input[key] = v.clone();
        }
    }
    planner_input(&input)
}
pub fn run_task_context_command(args: &[String], job: &Value) -> Result<String, String> {
    let task_id = arg(args, "--task-id", "");
    if task_id.is_empty() {
        return Err("task context requires --task-id".into());
    }
    let result = task_execution_context(job, task_id, arg(args, "--execution-id", ""))?;
    serde_json::to_string_pretty(&result).map_err(|e| e.to_string())
}
pub fn task_event_page_parameters(args: &[String]) -> Result<Value, String> {
    for flag in ["--limit", "--order", "--after"] {
        let count = args.iter().filter(|item| item.as_str() == flag).count();
        if count > 1 {
            return Err(format!("task events {flag} may not be repeated"));
        }
        if count == 1 {
            let value = arg(args, flag, "");
            if value.is_empty() || value.starts_with("--") {
                return Err(format!("task events {flag} requires a value"));
            }
        }
    }
    let limit = arg(args, "--limit", "60")
        .parse::<u64>()
        .map_err(|_| "task events --limit must be an integer from 1 to 60")?;
    if !(1..=60).contains(&limit) {
        return Err("task events --limit must be an integer from 1 to 60".into());
    }
    let order = arg(args, "--order", "desc");
    if !matches!(order, "asc" | "desc") {
        return Err("task events --order must be asc or desc".into());
    }
    let after = arg(args, "--after", "0")
        .parse::<u64>()
        .map_err(|_| "task events --after must be a non-negative integer cursor")?;
    if has_arg(args, "--after") && order != "asc" {
        return Err("task events --after requires --order asc".into());
    }
    Ok(json!({"limit":limit,"order":order,"after":after}))
}
pub fn run_task_events_command<History>(
    args: &[String],
    job: &Value,
    mut history: History,
) -> Result<String, String>
where
    History: FnMut(&str, &str, usize, &str, u64) -> Result<Value, String>,
{
    let task_id = arg(args, "--task-id", "");
    if task_id.is_empty() {
        return Err("task events requires --task-id".into());
    }
    let job_id = field(job, "id");
    if task(job, task_id).is_none() {
        return Err(format!("Task {task_id} not found in Job {job_id}"));
    }
    let params = task_event_page_parameters(args)?;
    let order = field(&params, "order");
    let limit = params.get("limit").and_then(Value::as_u64).unwrap_or(60) as usize;
    let after = params.get("after").and_then(Value::as_u64).unwrap_or(0);
    let page = history(job_id, task_id, limit, order, after)?;
    let events = page
        .get("events")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut result = json!({
        "jobId":job_id,"taskId":task_id,
        "order":if order=="asc"{"oldest-first"}else{"newest-first"},
        "events":events
    });
    if order == "asc" {
        result["nextCursor"] = page.get("nextCursor").cloned().unwrap_or(Value::Null);
        result["morePossible"] = json!(
            page["rows"]
                .as_array()
                .map_or(events.len(), |rows| rows.len())
                == limit
        );
    }
    serde_json::to_string_pretty(&result).map_err(|e| e.to_string())
}
pub fn run_task_read_command(action: &str, args: &[String], job: &Value) -> Result<String, String> {
    let task_id = arg(args, "--task-id", "");
    if task_id.is_empty() {
        return Err(format!("task {action} requires --task-id"));
    }
    let selected = task(job, task_id)
        .ok_or_else(|| format!("Task {task_id} not found in Job {}", field(job, "id")))?;
    let value = match action {
        "show" => selected.clone(),
        "comments" => selected.get("comments").cloned().unwrap_or(json!([])),
        _ => return Err(format!("Unsupported Task read action {action}")),
    };
    serde_json::to_string_pretty(&value).map_err(|e| e.to_string())
}
