//! Native Task CLI mutations. Parsing and identity checks finish before the
//! single RelayAuthority writer is opened.
use agents_relay_rust::agent_graph::AgentGraph;
use agents_relay_rust::authority::{NativeTaskSpec, RelayAuthority};
use agents_relay_rust::graph::{Decision, Graph, GraphInput};
use agents_relay_rust::native_daemon::isolated_store_root;
use agents_relay_rust::native_job::{cancel_queued_task, retry_failed_task};
use agents_relay_rust::supervised_script::after_time;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;

fn parse(
    args: &[String],
    allowed: &[&str],
    flags: &[&str],
) -> Result<HashMap<String, String>, String> {
    let mut out = HashMap::new();
    let mut i = 2;
    while i < args.len() {
        let key = args[i].as_str();
        if !allowed.contains(&key) && !flags.contains(&key) {
            return Err(format!("unrecognized task {} option {key}", args[1]));
        }
        if out.contains_key(key) {
            return Err(format!("duplicate option {key}"));
        }
        if flags.contains(&key) {
            out.insert(key.into(), "true".into());
            i += 1;
            continue;
        }
        let v = args
            .get(i + 1)
            .filter(|s| !s.starts_with("--"))
            .ok_or_else(|| format!("missing value for {key}"))?;
        out.insert(key.into(), v.clone());
        i += 2;
    }
    Ok(out)
}
fn identify(o: &HashMap<String, String>) -> Result<(PathBuf, String), String> {
    let db = PathBuf::from(o.get("--db").ok_or("missing --db")?);
    if !db.is_absolute() {
        return Err("absolute DB path required".into());
    }
    isolated_store_root(&db)?;
    let id = o
        .get("--id")
        .or_else(|| o.get("--job-id"))
        .ok_or("missing --id")?;
    if o.get("--id")
        .is_some_and(|v| o.get("--job-id").is_some_and(|j| j != v))
    {
        return Err("--id and --job-id mismatch".into());
    }
    Ok((db, id.clone()))
}
fn verify_job(a: &RelayAuthority, id: &str, repo: Option<&String>) -> Result<Value, String> {
    let job = a.read_job(id)?.ok_or("unknown Job")?;
    if repo.is_some_and(|r| job["repository"].as_str() != Some(r.as_str())) {
        return Err("repository identity mismatch".into());
    }
    Ok(job)
}
fn task<'a>(job: &'a Value, id: &str) -> Result<&'a Value, String> {
    job["tasks"]
        .as_array()
        .and_then(|ts| ts.iter().find(|t| t["id"] == id))
        .ok_or_else(|| format!("Task {id} not found"))
}
fn result(job: &Value, id: &str) -> Result<Value, String> {
    Ok(json!({"jobId":job["id"],"taskId":id,"task":task(job,id)?}))
}
fn comma_list(value: &str) -> Vec<String> {
    value
        .split(',')
        .filter(|item| !item.is_empty())
        .map(str::to_owned)
        .collect()
}
fn set_optional(task: &mut Value, key: &str, value: &str) {
    if value.is_empty() {
        task.as_object_mut().map(|map| map.remove(key));
    } else {
        task[key] = json!(value);
    }
}
fn story_timeout(size: &str, reasoning: Option<&str>) -> Result<i64, String> {
    let base = match size {
        "S" => 300_000,
        "M" => 900_000,
        "L" => 2_700_000,
        _ => return Err("invalid Task story size".into()),
    };
    Ok(
        if reasoning.is_some_and(|value| value.eq_ignore_ascii_case("high")) {
            base * 2
        } else {
            base
        },
    )
}
fn read_task_text(path: &str, db: &std::path::Path, label: &str) -> Result<String, String> {
    let mut bytes = Vec::new();
    if path == "-" {
        std::io::stdin()
            .take(1_048_577)
            .read_to_end(&mut bytes)
            .map_err(|e| format!("{label} stdin: {e}"))?;
    } else {
        let root = isolated_store_root(db)?;
        let file = PathBuf::from(path)
            .canonicalize()
            .map_err(|e| format!("{label} file: {e}"))?;
        if !file.is_file() || !file.starts_with(root) {
            return Err(format!("{label} file must be inside isolated store root"));
        }
        std::fs::File::open(file)
            .map_err(|e| format!("{label} file: {e}"))?
            .take(1_048_577)
            .read_to_end(&mut bytes)
            .map_err(|e| format!("{label} file: {e}"))?;
    }
    if bytes.len() > 1_048_576 {
        return Err(format!("{label} must be at most 1 MB"));
    }
    String::from_utf8(bytes).map_err(|e| format!("{label} is not UTF-8: {e}"))
}
fn validate_task_links(
    job: &Value,
    task_id: &str,
    parent: Option<&str>,
    deps: &[String],
    validity: Option<&Value>,
) -> Result<(), String> {
    if parent.is_some_and(|value| value == task_id) {
        return Err("Task cannot be its own parent".into());
    }
    if let Some(parent_id) = parent.filter(|value| !value.is_empty()) {
        if !job["tasks"]
            .as_array()
            .is_some_and(|tasks| tasks.iter().any(|item| item["id"] == parent_id))
        {
            return Err(format!("unknown parent Task {parent_id}"));
        }
    }
    if deps.iter().any(String::is_empty) {
        return Err("dependency Task IDs must be non-empty".into());
    }
    if deps.iter().any(|value| value == task_id) {
        return Err("Task cannot depend on itself".into());
    }
    let mut seen = std::collections::HashSet::new();
    if deps.iter().any(|value| !seen.insert(value)) {
        return Err("duplicate dependency Task ID".into());
    }
    for dep in deps {
        if !job["tasks"].as_array().is_some_and(|tasks| {
            tasks
                .iter()
                .any(|item| item["id"].as_str() == Some(dep.as_str()))
        }) {
            return Err(format!("unknown dependency Task {dep}"));
        }
    }
    if let Some(value) = validity {
        let object = value
            .as_object()
            .ok_or("--dependency-validity must be a JSON object")?;
        for (id, policy) in object {
            if !deps.iter().any(|dependency| dependency == id) {
                return Err(format!(
                    "dependency-validity key {id} must identify a declared dependency"
                ));
            }
            if !matches!(policy.as_str(), Some("order-only" | "revalidate" | "rerun")) {
                return Err(format!(
                    "dependency-validity[{id}] must be order-only, revalidate, or rerun"
                ));
            }
        }
    }
    Ok(())
}
fn apply_task_graph_transition(
    graph: &Graph,
    task: &mut Value,
    event: &str,
    guards: &HashMap<String, bool>,
) -> Result<(), String> {
    let source = task["state"].as_str().ok_or("Task state missing")?;
    let decision = graph.decide(
        source,
        GraphInput {
            transport: "event".into(),
            id: event.into(),
            payload: json!({"taskId":task["id"]}),
        },
        guards,
    )?;
    let Decision::Accepted {
        target, actions, ..
    } = decision
    else {
        return Err(format!("canonical Task Graph denied {event}"));
    };
    for action in actions {
        match action.id.as_str() {
            "mutation.clearError" => task["error"] = Value::Null,
            "mutation.clearFailureReason" => {
                task.as_object_mut()
                    .map(|object| object.remove("failureReason"));
            }
            _ => return Err(format!("unsupported Task Graph action {}", action.id)),
        }
    }
    task["state"] = json!(target);
    Ok(())
}

fn create(args: &[String]) -> Result<Value, String> {
    if std::env::var("RELAY_RUST_LIVE_MODE").ok().as_deref() == Some("pilot-live") {
        return Err("native Task creation is isolated-test only".into());
    }
    let allowed = [
        "--db",
        "--id",
        "--job-id",
        "--repo",
        "--input",
        "--input-file",
        "--output",
        "--output-path",
        "--title",
        "--priority",
        "--story-size",
        "--parent",
        "--deps",
        "--dependency-validity",
    ];
    let o = parse(args, &allowed, &["--draft"])?;
    let (db, jid) = identify(&o)?;
    let inline = o.get("--input");
    let file = o.get("--input-file");
    if inline.is_some() == file.is_some() {
        return Err("task create requires exactly one of --input or --input-file".into());
    }
    let input = if let Some(s) = inline {
        s.clone()
    } else {
        let p = PathBuf::from(file.unwrap());
        let root = isolated_store_root(&db)?;
        let p = p.canonicalize().map_err(|e| format!("input file: {e}"))?;
        if !p.is_file() || !p.starts_with(root) {
            return Err("Task input file must be inside isolated store root".into());
        }
        std::fs::read_to_string(p).map_err(|e| format!("Task input file: {e}"))?
    };
    let deps = o
        .get("--deps")
        .map(String::as_str)
        .unwrap_or("")
        .split(',')
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let validity = o
        .get("--dependency-validity")
        .map(|s| {
            serde_json::from_str::<Value>(s).map_err(|e| format!("--dependency-validity: {e}"))
        })
        .transpose()?;
    let size = o
        .get("--story-size")
        .map(String::as_str)
        .unwrap_or("M")
        .to_ascii_uppercase();
    let mut a = RelayAuthority::open_existing(&db)?;
    let job = verify_job(&a, &jid, o.get("--repo"))?;
    if matches!(job["state"].as_str(), Some("COMPLETED" | "CANCELLED")) {
        return Err(format!(
            "Cannot create task on terminal job {jid} ({})",
            job["state"]
        ));
    }
    let at = after_time(job["updatedAt"].as_str().ok_or("Job timestamp missing")?)?;
    let c = a.create_native_task(NativeTaskSpec {
        job_id: &jid,
        title: o.get("--title").map(String::as_str),
        input: &input,
        output_kind: o
            .get("--output")
            .map(String::as_str)
            .ok_or("missing --output")?,
        output_path: o.get("--output-path").map(String::as_str),
        priority: o.get("--priority").map(String::as_str).unwrap_or("P2"),
        story_size: &size,
        parent_task_id: o
            .get("--parent")
            .filter(|v| !v.is_empty())
            .map(String::as_str),
        dependencies: &deps,
        dependency_validity: validity.as_ref(),
        draft: o.contains_key("--draft"),
        at: &at,
        agent_name: None,
        review_head_sha: None,
        routing: None,
        worker_selection: None,
    })?;
    Ok(json!({"jobId":jid,"taskId":c.task_id,"created":c.created,"task":c.task}))
}
fn update(args: &[String]) -> Result<Value, String> {
    let o = parse(
        args,
        &[
            "--db",
            "--id",
            "--job-id",
            "--repo",
            "--task-id",
            "--title",
            "--input",
            "--input-file",
            "--priority",
            "--story-size",
            "--adapter",
            "--agent",
            "--agent-graph",
            "--agent-graph-file",
            "--attachments",
            "--capabilities",
            "--chatgpt-project",
            "--chatgpt-tab-close-policy",
            "--cwd",
            "--dependency-validity",
            "--deps",
            "--max-attempts",
            "--model",
            "--parent",
            "--profile",
            "--project",
            "--provider",
            "--reasoning",
            "--store-dir",
            "--timeout",
        ],
        &["--draft", "--queue", "--clear-routing"],
    )?;
    let (db, jid) = identify(&o)?;
    if let Some(store_dir) = o.get("--store-dir") {
        let supplied = PathBuf::from(store_dir)
            .canonicalize()
            .map_err(|e| format!("--store-dir: {e}"))?;
        let expected = isolated_store_root(&db)?;
        if supplied != expected {
            return Err("--store-dir must match the isolated store root for --db".into());
        }
    }
    let tid = o.get("--task-id").ok_or("task update requires --task-id")?;
    let mutable = [
        "--title",
        "--input",
        "--input-file",
        "--priority",
        "--story-size",
        "--adapter",
        "--agent",
        "--agent-graph",
        "--agent-graph-file",
        "--attachments",
        "--capabilities",
        "--chatgpt-project",
        "--chatgpt-tab-close-policy",
        "--cwd",
        "--dependency-validity",
        "--deps",
        "--draft",
        "--max-attempts",
        "--model",
        "--parent",
        "--profile",
        "--project",
        "--provider",
        "--reasoning",
        "--timeout",
        "--queue",
        "--clear-routing",
    ];
    if !mutable.iter().any(|k| o.contains_key(*k)) {
        return Err("task update requires a mutable field".into());
    }
    if o.contains_key("--input") && o.contains_key("--input-file") {
        return Err("task update accepts only one of --input or --input-file".into());
    }
    if o.contains_key("--agent-graph") && o.contains_key("--agent-graph-file") {
        return Err("--agent-graph and --agent-graph-file are mutually exclusive".into());
    }
    if o.contains_key("--draft") && o.contains_key("--queue") {
        return Err("--draft and --queue are mutually exclusive".into());
    }
    let routing_flags = [
        "--provider",
        "--model",
        "--profile",
        "--reasoning",
        "--cwd",
        "--chatgpt-project",
    ];
    if o.contains_key("--clear-routing") && routing_flags.iter().any(|flag| o.contains_key(*flag)) {
        return Err("--clear-routing cannot be combined with routing fields".into());
    }
    if let Some(t) = o.get("--title") {
        if t.trim().is_empty() || t.len() > 200 {
            return Err("--title must be nonempty and at most 200 bytes".into());
        }
    }
    if let Some(p) = o.get("--priority") {
        if !matches!(p.as_str(), "P0" | "P1" | "P2" | "P3") {
            return Err("--priority must be P0, P1, P2, or P3".into());
        }
    }
    if let Some(adapter) = o.get("--adapter") {
        if !matches!(adapter.as_str(), "codex" | "chatgpt" | "z") {
            return Err("--adapter must be codex, chatgpt, or z".into());
        }
    }
    if let Some(policy) = o.get("--chatgpt-tab-close-policy") {
        if !matches!(policy.as_str(), "after-start" | "never" | "after-terminal") {
            return Err(
                "--chatgpt-tab-close-policy must be after-start, never, or after-terminal".into(),
            );
        }
    }
    let nonnegative = |flag: &str| -> Result<Option<i64>, String> {
        o.get(flag)
            .map(|raw| {
                let n = raw
                    .parse::<i64>()
                    .map_err(|_| format!("{flag} must be a non-negative integer"))?;
                if n < 0 {
                    return Err(format!("{flag} must be a non-negative integer"));
                }
                Ok(n)
            })
            .transpose()
    };
    let timeout = nonnegative("--timeout")?;
    let max_attempts = nonnegative("--max-attempts")?;
    if max_attempts == Some(0) {
        return Err("--max-attempts must be a positive integer".into());
    }
    let size = o.get("--story-size").map(|s| s.to_ascii_uppercase());
    if size
        .as_deref()
        .is_some_and(|s| !matches!(s, "S" | "M" | "L"))
    {
        return Err("--story-size must be S, M, or L".into());
    }
    let input = if let Some(s) = o.get("--input") {
        Some(s.clone())
    } else if let Some(f) = o.get("--input-file") {
        Some(read_task_text(f, &db, "Task input")?)
    } else {
        None
    };
    let agent_graph = if let Some(s) = o.get("--agent-graph") {
        Some(s.clone())
    } else if let Some(file) = o.get("--agent-graph-file") {
        Some(read_task_text(file, &db, "agent graph")?)
    } else {
        None
    };
    if agent_graph
        .as_ref()
        .is_some_and(|s| s.trim().is_empty() || s.len() > 1_048_576)
    {
        return Err("Agent graph must be non-empty and at most 1 MB".into());
    }
    if let Some(graph) = agent_graph.as_ref() {
        AgentGraph::parse(graph).map_err(|error| format!("--agent-graph: {error}"))?;
    }
    if input
        .as_ref()
        .is_some_and(|s| s.trim().is_empty() || s.len() > 1_048_576)
    {
        return Err("Task input must be non-empty and at most 1 MB".into());
    }
    let mut a = RelayAuthority::open_existing(&db)?;
    let job = verify_job(&a, &jid, o.get("--repo"))?;
    let current = task(&job, tid)?;
    let expected_updated_at = current["updatedAt"]
        .as_str()
        .ok_or("Task timestamp missing")?
        .to_owned();
    if !matches!(current["state"].as_str(), Some("DRAFT" | "QUEUED")) {
        return Err(format!(
            "Task {tid} is {}; durable execution fields are immutable in this state",
            current["state"]
        ));
    }
    if current.get("kind").and_then(Value::as_str) == Some("planner")
        || current
            .get("agentGraph")
            .is_some_and(|value| !value.is_null())
        || current.get("dagNode").is_some_and(|value| !value.is_null())
    {
        return Err("native Task update does not support Planner or DAG Tasks".into());
    }
    if current.get("revision").is_some_and(|v| !v.is_null()) {
        return Err("native Task update does not support revision Tasks".into());
    }
    if o.get("--adapter")
        .is_some_and(|adapter| current["adapter"].as_str() != Some(adapter.as_str()))
        && current["attempt"].as_i64().unwrap_or(0) > 0
    {
        return Err("Cannot replace adapter after an execution attempt".into());
    }
    let adapter_changed = o
        .get("--adapter")
        .is_some_and(|adapter| current["adapter"].as_str() != Some(adapter.as_str()));
    if ["executionId", "leaseOwner", "leaseExpiresAt"]
        .iter()
        .any(|k| current.get(*k).is_some_and(|v| !v.is_null()))
    {
        return Err("Task update requires an unleased Task".into());
    }
    let at = after_time(job["updatedAt"].as_str().ok_or("Job timestamp missing")?)?;
    let parsed_validity = o
        .get("--dependency-validity")
        .map(|raw| {
            serde_json::from_str::<Value>(raw).map_err(|e| format!("--dependency-validity: {e}"))
        })
        .transpose()?;
    let requested_dependencies = o.get("--deps").map(|raw| {
        raw.split(',')
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect::<Vec<_>>()
    });
    let dependencies_were_supplied = requested_dependencies.is_some();
    let dependencies = requested_dependencies.clone().unwrap_or_else(|| {
        current["dependencies"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect()
    });
    let dependency_validity = if let Some(v) = parsed_validity {
        Some(v)
    } else if dependencies_were_supplied {
        current
            .get("dependencyValidity")
            .filter(|v| !v.is_null())
            .cloned()
    } else {
        None
    };
    validate_task_links(
        &job,
        tid,
        o.get("--parent").map(String::as_str),
        &dependencies,
        dependency_validity.as_ref(),
    )?;
    if max_attempts.is_some_and(|n| n < current["attempt"].as_i64().unwrap_or(0)) {
        return Err("--max-attempts cannot be less than the current attempt count".into());
    }
    let computed_timeout = if let Some(timeout) = timeout {
        Some(timeout)
    } else if size.is_some() || o.contains_key("--reasoning") {
        let effective_size = size
            .as_deref()
            .or_else(|| current["storySize"].as_str())
            .unwrap_or("M");
        let effective_reasoning = o
            .get("--reasoning")
            .map(String::as_str)
            .or_else(|| current["routing"]["reasoning"].as_str());
        Some(story_timeout(effective_size, effective_reasoning)?)
    } else {
        None
    };
    let routing_requested = routing_flags.iter().any(|flag| o.contains_key(*flag));
    let routing = if o.contains_key("--clear-routing") {
        Some(None)
    } else if routing_requested {
        let old = current.get("routing").filter(|v| !v.is_null());
        let model = o
            .get("--model")
            .map(String::as_str)
            .or_else(|| old.and_then(|r| r["model"].as_str()));
        let model = model
            .filter(|value| !value.is_empty())
            .ok_or("task routing update requires --model when no existing routing is present")?;
        Some(Some(json!({
            "provider":o.get("--provider").map(String::as_str).or_else(||old.and_then(|r|r["provider"].as_str())).unwrap_or("openai"),
            "model":model,
            "profile":o.get("--profile").map(String::as_str).or_else(||old.and_then(|r|r["profile"].as_str())).filter(|s|!s.is_empty()),
            "reasoning":o.get("--reasoning").map(String::as_str).or_else(||old.and_then(|r|r["reasoning"].as_str())).filter(|s|!s.is_empty()),
            "cwd":o.get("--cwd").map(String::as_str).or_else(||old.and_then(|r|r["cwd"].as_str())).filter(|s|!s.is_empty()),
            "projectId":o.get("--chatgpt-project").map(String::as_str).or_else(||old.and_then(|r|r["projectId"].as_str())).filter(|s|!s.is_empty()),
            "decidedBy":"cli:update","decidedAt":at
        })))
    } else {
        None
    };
    let graph = Graph::parse(include_str!("../../../../workflow/task-lifecycle.mmd"))?;
    let committed = a.commit_job(&jid, &at, |prior| {
        let mut next = prior.clone();
        let t = next["tasks"]
            .as_array_mut()
            .and_then(|ts| ts.iter_mut().find(|t| t["id"] == *tid))
            .ok_or("Task not found")?;
        if t["updatedAt"].as_str() != Some(expected_updated_at.as_str()) {
            return Err("Task changed since update preflight; refresh and retry".into());
        }
        if !matches!(t["state"].as_str(), Some("DRAFT" | "QUEUED"))
            || ["executionId", "leaseOwner", "leaseExpiresAt"]
                .iter()
                .any(|k| t.get(*k).is_some_and(|v| !v.is_null()))
        {
            return Err(
                "Task changed before update; it must remain unleased DRAFT or QUEUED".into(),
            );
        }
        if let Some(v) = o.get("--title") {
            t["title"] = json!(v)
        }
        if let Some(v) = input.as_ref() {
            t["input"] = json!(v)
        }
        if let Some(v) = o.get("--priority") {
            t["priority"] = json!(v)
        }
        if let Some(v) = o.get("--adapter") {
            t["adapter"] = json!(v);
        }
        if let Some(v) = size.as_ref() {
            t["storySize"] = json!(v)
        }
        if let Some(v) = o.get("--agent") {
            set_optional(t, "agentName", v);
        }
        if let Some(v) = agent_graph.as_ref() {
            set_optional(t, "agentGraph", v);
        }
        if let Some(v) = o.get("--project") {
            set_optional(t, "projectName", v);
        }
        if let Some(v) = o.get("--parent") {
            t["parentTaskId"] = if v.is_empty() { Value::Null } else { json!(v) };
        }
        t["dependencies"] = json!(dependencies);
        if let Some(v) = dependency_validity.as_ref() {
            t["dependencyValidity"] = v.clone();
        } else if dependencies_were_supplied {
            t.as_object_mut().map(|m| m.remove("dependencyValidity"));
        }
        if let Some(v) = o.get("--capabilities") {
            t["capabilities"] = json!(comma_list(v));
        }
        if let Some(v) = o.get("--attachments") {
            t["attachments"] = json!(comma_list(v));
        }
        if let Some(v) = o.get("--chatgpt-tab-close-policy") {
            t["chatgptTabClosePolicy"] = json!(v);
        }
        if let Some(Some(route)) = routing.as_ref() {
            t["routing"] = route.clone();
            t.as_object_mut().map(|m| m.remove("workerSelection"));
        }
        if matches!(&routing, Some(None)) {
            t.as_object_mut().map(|m| m.remove("routing"));
            t.as_object_mut().map(|m| m.remove("workerSelection"));
        }
        if adapter_changed {
            t.as_object_mut().map(|m| m.remove("workerSelection"));
        }
        if let Some(n) = computed_timeout {
            t["timeoutMs"] = json!(n);
        }
        if let Some(n) = max_attempts {
            t["maxAttempts"] = json!(n);
        }
        if o.contains_key("--draft") && t["state"] == "QUEUED" {
            apply_task_graph_transition(&graph, t, "hold", &HashMap::new())?;
        }
        if o.contains_key("--queue") {
            let satisfied = dependencies.iter().all(|id| {
                prior["tasks"].as_array().is_some_and(|tasks| {
                    tasks
                        .iter()
                        .any(|dep| dep["id"] == *id && dep["state"] == "SUCCEEDED")
                })
            });
            apply_task_graph_transition(
                &graph,
                t,
                "queue",
                &HashMap::from([("dependenciesSatisfied".to_owned(), satisfied)]),
            )?;
            t["executionId"] = Value::Null;
            t["leaseOwner"] = Value::Null;
            t["leaseExpiresAt"] = Value::Null;
        }
        t["updatedAt"] = json!(at);
        next["updatedAt"] = json!(at);
        Ok((next, vec![]))
    })?;
    result(&committed.job, tid)
}
fn unblock(args: &[String]) -> Result<Value, String> {
    let o = parse(
        args,
        &[
            "--db",
            "--id",
            "--job-id",
            "--repo",
            "--task-id",
            "--reason",
            "--response",
        ],
        &[],
    )?;
    let (db, jid) = identify(&o)?;
    let tid = o
        .get("--task-id")
        .ok_or("task unblock requires --task-id")?;
    let reason = o.get("--reason").map(String::as_str).unwrap_or("");
    let response = o.get("--response").map(String::as_str).unwrap_or("");
    if reason.trim().is_empty() && response.trim().is_empty() {
        return Err("task unblock requires --reason or --response".into());
    }
    let mut a = RelayAuthority::open_existing(&db)?;
    let job = verify_job(&a, &jid, o.get("--repo"))?;
    let current = task(&job, tid)?;
    if current["agentName"] == "troubleshooter" && current["escalation"]["status"] == "pending" {
        return Err(
            "native task unblock cannot impersonate an authorized human escalation response".into(),
        );
    }
    if current["state"] != "BLOCKED"
        || current["agentName"] != "troubleshooter"
        || current["kind"] == "planner"
    {
        return Err("native unblock requires an effective BLOCKED Troubleshooter Task".into());
    }
    if job["state"] != "ACTIVE" || job.get("pause").is_some_and(|v| !v.is_null()) {
        return Err("native unblock requires an active, unpaused Job".into());
    }
    if ["executionId", "leaseOwner", "leaseExpiresAt"]
        .iter()
        .any(|k| current.get(*k).is_some_and(|v| !v.is_null()))
    {
        return Err("native unblock requires an inactive Task without a lease".into());
    }
    let at = after_time(job["updatedAt"].as_str().ok_or("Job timestamp missing")?)?;
    let graph = Graph::parse(include_str!("../../../../workflow/task-lifecycle.mmd"))?;
    let c = a.commit_job(&jid, &at, |prior| {
        if prior["state"] != "ACTIVE" || prior.get("pause").is_some_and(|v| !v.is_null()) {
            return Err("Job changed before unblock; it must remain active and unpaused".into());
        }
        let mut next = prior.clone();
        let t = next["tasks"].as_array_mut().and_then(|ts| ts.iter_mut().find(|t| t["id"] == *tid)).ok_or("Task not found")?;
        if t["state"] != "BLOCKED" || t["agentName"] != "troubleshooter" || t["escalation"]["status"] == "pending"
            || ["executionId", "leaseOwner", "leaseExpiresAt"].iter().any(|k| t.get(*k).is_some_and(|v| !v.is_null())) {
            return Err("Task changed before unblock or is awaiting an authorized human response".into());
        }
        let d = graph.decide("BLOCKED", GraphInput { transport: "event".into(), id: "task.unblocked".into(), payload: json!({}) }, &HashMap::from([("troubleshooterTask".into(), true)]))?;
        let Decision::Accepted { target, actions, .. } = d else { return Err("canonical Task Graph denied unblock".into()) };
        if target != "QUEUED" { return Err("canonical Task Graph selected unexpected unblock state".into()) }
        for action in actions { match action.id.as_str() { "mutation.clearError" => t["error"] = Value::Null, "mutation.clearFailureReason" => { if let Some(m)=t.as_object_mut(){m.shift_remove("failureReason");} }, _ => return Err(format!("unsupported unblock action {}", action.id)) } }
        t["state"] = json!(target); t["attempt"] = json!(0); t["maxAttempts"] = json!(t["maxAttempts"].as_i64().unwrap_or(3).max(3));
        t["executionId"] = Value::Null; t["leaseOwner"] = Value::Null; t["leaseExpiresAt"] = Value::Null; t["blockedBy"] = Value::Null;
        t["unblock"] = json!({"event":"task.unblocked","at":at,"source":"cli","reason":if reason.trim().is_empty(){response}else{reason}});
        t["updatedAt"] = json!(at); next["updatedAt"] = json!(at); Ok((next, vec![]))
    })?;
    result(&c.job, tid)
}
fn comment(args: &[String]) -> Result<Value, String> {
    let options = parse(
        args,
        &[
            "--db",
            "--id",
            "--job-id",
            "--repo",
            "--task-id",
            "--message",
            "--message-file",
        ],
        &[],
    )?;
    if options.contains_key("--message") == options.contains_key("--message-file") {
        return Err("task comment requires exactly one of --message or --message-file".into());
    }
    let (db, id) = identify(&options)?;
    let repo = options
        .get("--repo")
        .filter(|s| !s.trim().is_empty())
        .ok_or("task comment requires --repo")?;
    let task_id = options
        .get("--task-id")
        .filter(|s| !s.trim().is_empty())
        .ok_or("task comment requires --task-id")?;
    let text = if let Some(message) = options.get("--message") {
        message.clone()
    } else {
        let source = options
            .get("--message-file")
            .expect("validated message file");
        let mut bytes = Vec::new();
        if source == "-" {
            std::io::stdin()
                .take(60_001)
                .read_to_end(&mut bytes)
                .map_err(|e| format!("read --message-file -: {e}"))?;
        } else {
            let file = std::fs::File::open(source).map_err(|e| format!("message file: {e}"))?;
            file.take(60_001)
                .read_to_end(&mut bytes)
                .map_err(|e| format!("message file: {e}"))?;
        }
        String::from_utf8(bytes).map_err(|_| "message file must be UTF-8")?
    };
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed.len() > 60_000 {
        return Err("task comment requires nonempty message of at most 60000 bytes".into());
    }
    let request = agents_relay_rust::native_control::ControlRequest {
        version: 1,
        operation: "task.comment".into(),
        repository: repo.clone(),
        id,
        title: String::new(),
        objective: String::new(),
        project_root: String::new(),
        project_path: None,
        priority: String::new(),
        review_enabled: false,
        auto_merge: false,
        changes: None,
        reason: None,
        task_id: Some(task_id.clone()),
        message: Some(trimmed.into()),
    };
    let live = std::env::var("RELAY_RUST_LIVE_MODE").ok().as_deref() == Some("pilot-live");
    if live {
        agents_relay_rust::native_control::request(&db, &request)
    } else {
        agents_relay_rust::native_control::append_task_comment_isolated(&db, &request)
    }
}

pub fn run(args: &[String]) -> Result<Value, String> {
    if args.get(1).is_some_and(|action| action == "comment") {
        return comment(args);
    }
    // All direct Task mutations must be handled by the Rust Daemon's authenticated
    // single-writer ingress once it owns the live namespace. Never allow an
    // unrelated CLI process to race the durable worker/Review reconciler.
    if std::env::var("RELAY_RUST_LIVE_MODE").ok().as_deref() == Some("pilot-live") {
        return Err("native Task mutations require daemon-owned control in Rust live mode; refusing competing SQLite writer".into());
    }
    let action = args
        .get(1)
        .map(String::as_str)
        .ok_or("task action required")?;
    match action{"create"=>create(args),"update"=>update(args),"cancel"=>{let o=parse(args,&["--db","--id","--job-id","--repo","--task-id","--reason"],&[])?;let (db,jid)=identify(&o)?;let tid=o.get("--task-id").ok_or("task cancel requires --task-id")?;let reason=o.get("--reason").ok_or("task cancel requires --reason")?;let mut a=RelayAuthority::open_existing(&db)?;verify_job(&a,&jid,o.get("--repo"))?;cancel_queued_task(&mut a,&jid,tid,reason)},"retry"=>{let o=parse(args,&["--db","--id","--job-id","--repo","--task-id"],&[])?;let(db,jid)=identify(&o)?;let tid=o.get("--task-id").ok_or("task retry requires --task-id")?;let mut a=RelayAuthority::open_existing(&db)?;verify_job(&a,&jid,o.get("--repo"))?;retry_failed_task(&mut a,&jid,tid)},"unblock"=>unblock(args),"recover"|"classify"|"complete"|"revise"|"supersede"=>Err(format!("native task {action} is not safely supported: refusing mutation without matching Graph/action authority and execution/review binding")),_=>Err(format!("unsupported native Task action {action}"))}
}
