//! Native Task CLI mutations. Parsing and identity checks finish before the
//! single RelayAuthority writer is opened.
use agents_relay_rust::authority::{NativeTaskSpec, RelayAuthority};
use agents_relay_rust::graph::{Decision, Graph, GraphInput};
use agents_relay_rust::native_daemon::isolated_store_root;
use agents_relay_rust::native_job::{cancel_queued_task, retry_failed_task};
use agents_relay_rust::supervised_script::after_time;
use serde_json::{json, Value};
use std::collections::HashMap;
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
        ],
        &[],
    )?;
    let (db, jid) = identify(&o)?;
    let tid = o.get("--task-id").ok_or("task update requires --task-id")?;
    if ![
        "--title",
        "--input",
        "--input-file",
        "--priority",
        "--story-size",
    ]
    .iter()
    .any(|k| o.contains_key(*k))
    {
        return Err("task update requires a mutable field".into());
    }
    if o.contains_key("--input") && o.contains_key("--input-file") {
        return Err("task update accepts only one of --input or --input-file".into());
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
        let root = isolated_store_root(&db)?;
        let p = PathBuf::from(f)
            .canonicalize()
            .map_err(|e| format!("input file: {e}"))?;
        if !p.is_file() || !p.starts_with(root) {
            return Err("Task input file must be inside isolated store root".into());
        }
        Some(std::fs::read_to_string(p).map_err(|e| format!("Task input file: {e}"))?)
    } else {
        None
    };
    if input
        .as_ref()
        .is_some_and(|s| s.trim().is_empty() || s.len() > 1_048_576)
    {
        return Err("Task input must be non-empty and at most 1 MB".into());
    }
    let mut a = RelayAuthority::open_existing(&db)?;
    let job = verify_job(&a, &jid, o.get("--repo"))?;
    let current = task(&job, tid)?;
    if !matches!(current["state"].as_str(), Some("DRAFT" | "QUEUED")) {
        return Err(format!(
            "Task {tid} is {}; durable execution fields are immutable in this state",
            current["state"]
        ));
    }
    if current.get("kind").and_then(Value::as_str) == Some("planner")
        || current.get("agentGraph").is_some()
        || current.get("dagNode").is_some()
    {
        return Err("native Task update does not support Planner or DAG Tasks".into());
    }
    if ["executionId", "leaseOwner", "leaseExpiresAt"]
        .iter()
        .any(|k| current.get(*k).is_some_and(|v| !v.is_null()))
    {
        return Err("Task update requires an unleased Task".into());
    }
    let at = after_time(job["updatedAt"].as_str().ok_or("Job timestamp missing")?)?;
    let committed = a.commit_job(&jid, &at, |prior| {
        let mut next = prior.clone();
        let t = next["tasks"]
            .as_array_mut()
            .and_then(|ts| ts.iter_mut().find(|t| t["id"] == *tid))
            .ok_or("Task not found")?;
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
        if let Some(v) = size.as_ref() {
            t["storySize"] = json!(v)
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
pub fn run(args: &[String]) -> Result<Value, String> {
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
    match action{"create"=>create(args),"update"=>update(args),"cancel"=>{let o=parse(args,&["--db","--id","--job-id","--repo","--task-id","--reason"],&[])?;let (db,jid)=identify(&o)?;let tid=o.get("--task-id").ok_or("task cancel requires --task-id")?;let reason=o.get("--reason").ok_or("task cancel requires --reason")?;let mut a=RelayAuthority::open_existing(&db)?;verify_job(&a,&jid,o.get("--repo"))?;cancel_queued_task(&mut a,&jid,tid,reason)},"retry"=>{let o=parse(args,&["--db","--id","--job-id","--repo","--task-id"],&[])?;let(db,jid)=identify(&o)?;let tid=o.get("--task-id").ok_or("task retry requires --task-id")?;let mut a=RelayAuthority::open_existing(&db)?;verify_job(&a,&jid,o.get("--repo"))?;retry_failed_task(&mut a,&jid,tid)},"unblock"=>unblock(args),"recover"|"classify"|"complete"|"revise"|"supersede"|"comment"=>Err(format!("native task {action} is not safely supported: refusing mutation without matching Graph/action authority and execution/review binding")),_=>Err(format!("unsupported native Task action {action}"))}
}
