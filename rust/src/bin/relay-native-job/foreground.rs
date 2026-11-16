//! Native, single-writer foreground Coordinator execution.
//! If the managed Rust daemon already holds the lock, attach read-only and
//! stream canonical SQLite progress; never start a second reconciler.
use agents_relay_rust::native_daemon::{isolated_store_root, NativeDaemonOptions};
use agents_relay_rust::native_job::activate_job;
use agents_relay_rust::single_node::SingleNodeDaemon;
use agents_relay_rust::store::RelayReader;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

fn parse(args: &[String]) -> Result<(HashMap<String, String>, HashSet<String>), String> {
    let options = [
        "--db",
        "--id",
        "--job-id",
        "--repo",
        "--task-id",
        "--manifest",
        "--helper",
        "--interval-ms",
        "--concurrency",
        "--max-ticks",
        "--project-path",
        "--workspace-root",
        "--shared-root",
    ];
    let flags = ["--foreground", "--no-github"];
    let mut values = HashMap::new();
    let mut toggles = HashSet::new();
    let mut i = 0;
    while i < args.len() {
        let name = args[i].as_str();
        if flags.contains(&name) {
            if !toggles.insert(name.to_owned()) {
                return Err(format!("duplicate flag {name}"));
            }
            i += 1;
        } else if options.contains(&name) {
            if values.contains_key(name) {
                return Err(format!("duplicate option {name}"));
            }
            let value = args
                .get(i + 1)
                .filter(|v| !v.starts_with("--") && !v.is_empty())
                .ok_or_else(|| format!("missing value for {name}"))?;
            values.insert(name.to_owned(), value.clone());
            i += 2;
        } else {
            return Err(format!(
                "unsupported job run option {name}; refusing to ignore an unported parameter"
            ));
        }
    }
    if values.contains_key("--id") && values.contains_key("--job-id") {
        return Err("use exactly one of --id or --job-id".into());
    }
    Ok((values, toggles))
}
fn positive_usize(
    values: &HashMap<String, String>,
    key: &str,
    default: usize,
    max: usize,
) -> Result<usize, String> {
    let value = values.get(key).map(String::as_str).unwrap_or("");
    let parsed = if value.is_empty() {
        default
    } else {
        value
            .parse::<usize>()
            .map_err(|_| format!("{key} must be a positive integer"))?
    };
    if !(1..=max).contains(&parsed) {
        return Err(format!("{key} must be between 1 and {max}"));
    }
    Ok(parsed)
}
fn current_job(db: &Path, id: &str) -> Result<Value, String> {
    let reader = RelayReader::open(db)?;
    reader
        .get_job(id)?
        .map(|s| s.job)
        .ok_or_else(|| format!("Job {id} not found"))
}
fn emit(value: Value) -> Result<(), String> {
    let mut out = io::stdout().lock();
    writeln!(out, "{}", value).map_err(|e| e.to_string())?;
    out.flush().map_err(|e| e.to_string())
}
fn changes(job: &Value, last: &mut HashMap<String, String>) -> Result<(), String> {
    if let Some(tasks) = job["tasks"].as_array() {
        for task in tasks {
            let id = task["id"].as_str().ok_or("Task id missing")?;
            let state = task["state"].as_str().ok_or("Task state missing")?;
            if last.get(id).is_some_and(|old| old == state) {
                continue;
            }
            last.insert(id.to_owned(), state.to_owned());
            emit(json!({
                "event":"task.state","jobId":job["id"],"taskId":id,
                "title":task["title"],"state":state
            }))?;
        }
    }
    Ok(())
}
fn is_terminal(state: &str) -> bool {
    matches!(state, "COMPLETED" | "CANCELLED" | "FAILED")
}
pub fn run(args: &[String]) -> Result<(), String> {
    let (values, flags) = parse(args)?;
    let get = |name: &str| values.get(name).map(String::as_str);
    let db = PathBuf::from(get("--db").ok_or("missing --db; Rust live namespace is explicit")?);
    if !db.is_absolute() {
        return Err("--db must be an absolute path".into());
    }
    let root = isolated_store_root(&db)?;
    let id = get("--id")
        .or_else(|| get("--job-id"))
        .ok_or("missing --id JOB")?;
    let task_id = get("--task-id").ok_or("missing --task-id COORDINATOR")?;
    let job = current_job(&db, id)?;
    if let Some(repo) = get("--repo") {
        if job["repository"].as_str() != Some(repo) {
            return Err("--repo does not match stored Job identity".into());
        }
    }
    if let Some(project) = get("--project-path") {
        let requested = Path::new(project)
            .canonicalize()
            .map_err(|e| format!("--project-path: {e}"))?;
        let stored = Path::new(
            job["projectRoot"]
                .as_str()
                .ok_or("Job projectRoot missing")?,
        )
        .canonicalize()
        .map_err(|e| format!("Job projectRoot: {e}"))?;
        if requested != stored {
            return Err("--project-path differs from canonical Job projectRoot".into());
        }
    }
    // Node's `neo project run --foreground` passes both execution-context
    // roots. Never discard them: verify against immutable Coordinator input.
    for (option, stored_field) in [
        ("--workspace-root", "workspaceRoot"),
        ("--shared-root", "sharedRoot"),
    ] {
        if let Some(value) = get(option) {
            let requested = Path::new(value)
                .canonicalize()
                .map_err(|e| format!("{option}: {e}"))?;
            let stored = Path::new(
                job["graphStartContext"][stored_field]
                    .as_str()
                    .ok_or_else(|| format!("Coordinator {stored_field} missing"))?,
            )
            .canonicalize()
            .map_err(|e| format!("stored {stored_field}: {e}"))?;
            if requested != stored {
                return Err(format!(
                    "{option} differs from canonical Coordinator {stored_field}"
                ));
            }
        }
    }
    let task = job["tasks"]
        .as_array()
        .ok_or("Job has no tasks")?
        .iter()
        .find(|task| task["id"].as_str() == Some(task_id))
        .ok_or("Coordinator Task not found for --task-id")?;
    if task.get("agentGraph").and_then(Value::as_str).is_none() {
        return Err("--task-id must identify the actual Coordinator DAG Task".into());
    }
    let state = job["state"].as_str().ok_or("Job state missing")?;
    if !matches!(state, "DRAFT" | "ACTIVE" | "COMPLETED") {
        return Err(format!("cannot run Job in state {state}"));
    }
    // Parse and validate all foreground arguments before activating a DRAFT Job.
    // Invalid option values must never leave a newly activated durable Job.
    if !flags.contains("--foreground")
        && [
            "--interval-ms",
            "--max-ticks",
            "--manifest",
            "--helper",
            "--concurrency",
        ]
        .iter()
        .any(|option| values.contains_key(*option))
    {
        return Err("foreground-only execution parameters require --foreground".into());
    }
    let interval = positive_usize(&values, "--interval-ms", 1000, 300_000)?;
    if interval < 100 {
        return Err("--interval-ms must be >= 100".into());
    }
    let max_tasks = positive_usize(&values, "--concurrency", 4, 100)?;
    let max_ticks = values
        .get("--max-ticks")
        .map(|_| positive_usize(&values, "--max-ticks", 1, 1_000_000))
        .transpose()?;

    let manifest = get("--manifest")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("manifest.json"));
    let helper = get("--helper").map(PathBuf::from).unwrap_or_else(|| {
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.join("relay-worker-helper")))
            .unwrap_or_default()
    });
    if flags.contains("--foreground") {
        let file = manifest
            .canonicalize()
            .map_err(|e| format!("--manifest: {e}"))?;
        if file.parent() != Some(root.as_path()) {
            return Err("--manifest must be in Rust authority DB root".into());
        }
        if !helper.is_file() {
            return Err("--helper executable does not exist".into());
        }
    }
    if state == "DRAFT" {
        activate_job(&db, id)?;
    }
    if !flags.contains("--foreground") {
        emit(json!({"jobId":id,"taskId":task_id,"state":"ACTIVE","foreground":false}))?;
        return Ok(());
    }
    let stop = Arc::new(AtomicBool::new(false));
    signal_hook::flag::register(signal_hook::consts::SIGINT, Arc::clone(&stop))
        .map_err(|e| e.to_string())?;
    signal_hook::flag::register(signal_hook::consts::SIGTERM, Arc::clone(&stop))
        .map_err(|e| e.to_string())?;
    let owner = match SingleNodeDaemon::acquire(NativeDaemonOptions {
        db: db.clone(),
        manifest,
        helper,
        max_tasks,
    }) {
        Ok(daemon) => Some(daemon),
        Err(e) if e.contains("already active or lock unavailable") => None,
        Err(e) => return Err(e),
    };
    emit(
        json!({"event":"job.foreground.started","jobId":id,"taskId":task_id,
        "mode":if owner.is_some(){"owner"}else{"attached-read-only"},"reviewEnabled":job["reviewEnabled"]}),
    )?;
    let mut observed = HashMap::<String, String>::new();
    let mut ticks = 0usize;
    let mut last_state = String::new();
    loop {
        if stop.load(Ordering::SeqCst) {
            emit(
                json!({"event":"job.foreground.interrupted","jobId":id,"durableStatePreserved":true}),
            )?;
            return Err("foreground interrupted; Job remains durable".into());
        }
        if let Some(ref daemon) = owner {
            let report = daemon.tick(Arc::clone(&stop))?;
            emit(json!({"event":"relay.tick","jobId":id,"report":report}))?;
        }
        ticks += 1;
        let current = current_job(&db, id)?;
        changes(&current, &mut observed)?;
        let state = current["state"].as_str().ok_or("Job state missing")?;
        if state != last_state {
            emit(json!({"event":"job.state","jobId":id,"state":state}))?;
            last_state = state.to_owned();
        }
        if is_terminal(state) {
            emit(json!({"event":"job.foreground.terminal","jobId":id,
                "state":state,"ticks":ticks}))?;
            return if state == "COMPLETED" {
                Ok(())
            } else {
                Err(format!("Job {id} ended in {state}"))
            };
        }
        if max_ticks.is_some_and(|n| ticks >= n) {
            return Err(format!(
                "Job {id} still {state} after {ticks} ticks; durable state preserved"
            ));
        }
        for _ in 0..interval.div_ceil(100) {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
    }
}
