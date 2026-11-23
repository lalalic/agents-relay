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
    global_root: Option<&str>,
    foreground: bool,
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
        .and_then(Value::as_str).unwrap_or("").to_owned();
    let current_state = current.get("state").and_then(Value::as_str).unwrap_or("").to_owned();
    if !matches!(state.as_str(), "DRAFT" | "QUEUED" | "RUNNING")
        && !(foreground && current_state == "ACTIVE" && !existing.is_empty()) {
        return Err("Coordinator Task is not startable".into());
    }
    if existing.is_empty() {
        if !matches!(state.as_str(), "DRAFT" | "QUEUED") {
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
    });
    if let Some(root) = global_root { binding["globalRoot"] = json!(root); }
    if let Some(existing) = current.get("graphStartContext").filter(|v| !v.is_null()) {
        for key in ["projectRoot", "workspaceRoot", "globalRoot"] {
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

use crate::{
    agent_graph::parse_agent_graph,
    cli_core_support::{arg,has_arg,text_option},
    cli_support_events::{publish_wake,ServiceEventBusPort},
    local_merge_lock::iso8601_now,
    relay_store::SQLiteRelayStore,
    task_transitions::try_transition_task_event,
    workflow::lifecycle::dispatch_job_lifecycle_sync,
    workspace::{resolve_workspace_root,resolve_job_project_root},
};
use std::path::Path;

/// Public Coordinator CLI. No dedicated scheduler or Shortcut runtime:
/// validate the saved Agent Graph, bind immutable roots under a single SQLite
/// transaction, then optionally wake the ordinary daemon Reconciler.
pub fn run_coordinator_job_command(
    graph_directory:&Path,args:&[String],id:&str,store:&SQLiteRelayStore,
    job:&Value,local_file:Option<&Path>,
    env_global_root:Option<&str>,
    mut foreground:Option<&mut dyn FnMut(&SQLiteRelayStore,&str,&str)->Result<(),String>>,
    bus:Option<&dyn ServiceEventBusPort>,
)->Result<Option<Value>,String>{
    let in_foreground=has_arg(args,"--foreground");
    validate_coordinator_args(args,foreground.is_some())?;
    if local_file.is_some(){
        return Err("Job start requires authoritative SQLite".into());
    }
    let task_id=arg(args,"--task-id","");
    if task_id.is_empty(){return Err("job run requires --task-id".into());}
    let task=job.get("tasks").and_then(Value::as_array)
        .and_then(|tasks|tasks.iter().find(|task|
            task.get("id").and_then(Value::as_str)==Some(task_id)))
        .ok_or_else(||format!("Task {task_id} not found"))?;
    let override_graph=if has_arg(args,"--agent-graph-file"){
        let source=text_option(args,"--agent-graph","--agent-graph-file",None)?;
        if source.is_empty(){None}else{
            parse_agent_graph(&source)?;
            Some(source)
        }
    }else{None};
    let existing_graph=task.get("agentGraph").and_then(Value::as_str)
        .filter(|graph|!graph.is_empty());
    let graph=existing_graph.or(override_graph.as_deref())
        .ok_or("job run requires a durable Agent Graph Task")?;
    parse_agent_graph(graph)?;
    let workspace=resolve_workspace_root(
        Some(arg(args,"--workspace-root","")).filter(|s|!s.is_empty()))?;
    let project=resolve_job_project_root(job)?;
    if has_arg(args,"--project-path"){
        return Err("Job --project-path is removed; use the independent Git repository root".into());
    }
    if in_foreground && matches!(job.get("state").and_then(Value::as_str),
        Some("COMPLETED"|"CANCELLED")){
        foreground.as_mut().ok_or("Foreground runner not configured")?
            (store,id,task_id)?;
        return Ok(None);
    }
    let global_root=Some(arg(args,"--global-root",""))
        .filter(|value|!value.is_empty()).or(env_global_root);
    let now=iso8601_now();
    store.mutate_job(id,|current|{
        bind_coordinator_start(
            &current,task_id,graph,
            &project.to_string_lossy(),&workspace.to_string_lossy(),
            global_root,in_foreground,
            |task|try_transition_task_event(
                graph_directory,task,"queue",
                &json!({"dependenciesSatisfied":true}),&now)
                .is_ok_and(|decision|
                    decision["accepted"]==true&&decision["target"]=="QUEUED"),
            |job|dispatch_job_lifecycle_sync(
                graph_directory,job,"activate",&json!({}),&now)
                .is_ok_and(|decision|
                    decision["accepted"]==true&&decision["target"]=="ACTIVE"),
        )
    })?;
    let scheduled=store.load_job(id)?
        .ok_or_else(||format!("Local authoritative Job {id} not found"))?;
    if in_foreground {
        foreground.as_mut().ok_or("Foreground runner not configured")?
            (store,id,task_id)?;
        return Ok(None);
    }
    publish_wake(bus,&scheduled,task_id,"Coordinator Job activated");
    Ok(Some(json!({"jobId":id,"taskId":task_id,
        "scheduled":true,"state":scheduled.get("state"),
        "graphRuntime":"tasks"})))
}
