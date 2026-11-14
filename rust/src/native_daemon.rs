//! Isolated, native Script-only Relay reconciler/daemon. Graphs own transition
//! policy, the ordinary SQLite Job snapshot owns Tasks, and relay-worker-helper
//! owns OS process groups. The explicit test-store fence prevents this staged
//! backend from ever racing the production TypeScript daemon.
use crate::authority::{probe_process, RelayAuthority, ScriptClaimRequest};
use crate::recovery::inspect_expired_execution;
use crate::store::RelayReader;
use crate::supervised_script::{after_time, current_time, execute_supervised_script};
use crate::worker::WorkerSpec;
use chrono::{DateTime, Duration as ChronoDuration, SecondsFormat};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeScriptAdapter {
    pub executable: PathBuf,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScriptManifest {
    pub agents: BTreeMap<String, NativeScriptAdapter>,
}
#[derive(Debug, Clone)]
pub struct NativeDaemonOptions {
    pub db: PathBuf,
    pub manifest: PathBuf,
    pub helper: PathBuf,
    pub max_tasks: usize,
}
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeTick {
    pub jobs_seen: usize,
    pub tasks_queued: usize,
    pub tasks_claimed: usize,
    pub tasks_succeeded: usize,
    pub tasks_failed: usize,
    pub tasks_recovered: usize,
    pub blocked: Vec<String>,
}

fn stable_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}
/// Explicit disposable location and marker are mandatory. No live-store
/// option, home-store default, or environment override bypasses this gate.
pub fn isolated_store_root(db: &Path) -> Result<PathBuf, String> {
    if std::env::var("RELAY_RUST_EXPERIMENTAL_TEST_ONLY")
        .ok()
        .as_deref()
        != Some("isolated-test")
    {
        return Err("native daemon has no production authorization; isolated-test required".into());
    }
    let db = db
        .canonicalize()
        .map_err(|e| format!("explicit SQLite path required: {e}"))?;
    let root = db.parent().ok_or("missing isolated DB root")?;
    let temp = std::env::temp_dir()
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !root.starts_with(temp)
        || !root
            .file_name()
            .is_some_and(|n| n.to_string_lossy().starts_with("relay-rust-authority-"))
        || !root.join(".relay-rust-authority-isolated-test").is_file()
    {
        return Err("native daemon refuses non-disposable/unmarked SQLite authority".into());
    }
    Ok(root.to_path_buf())
}
fn manifest(opt: &NativeDaemonOptions, root: &Path) -> Result<ScriptManifest, String> {
    let file = opt
        .manifest
        .canonicalize()
        .map_err(|e| format!("Script manifest missing: {e}"))?;
    if file.parent() != Some(root) {
        return Err("native Script manifest must be in isolated DB root".into());
    }
    let info = fs::metadata(&file).map_err(|e| e.to_string())?;
    if !info.is_file() || info.len() > 65_536 {
        return Err("Script manifest must be a small file".into());
    }
    let contents = fs::read(&file).map_err(|e| e.to_string())?;
    let parsed: ScriptManifest = serde_json::from_slice(&contents).map_err(|e| e.to_string())?;
    for (name, agent) in &parsed.agents {
        if !stable_id(name) || !agent.executable.is_absolute() || !agent.executable.is_file() {
            return Err("native Script manifest contains invalid role/executable".into());
        }
        if agent
            .env
            .keys()
            .any(|key| key.starts_with("RELAY_") || key.is_empty())
        {
            return Err("native Script adapter cannot override Relay execution variables".into());
        }
    }
    Ok(parsed)
}
fn private_dir(root: &Path, path: &Path) -> Result<(), String> {
    // Reject pre-planted symlinks *before* creating any descendant. The
    // disposable root is mkdtemp-private, so no unrelated user can swap a
    // component while this test-only daemon works on it.
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "Script output escaped isolated root")?;
    let mut cursor = root.to_path_buf();
    for component in relative.components() {
        let std::path::Component::Normal(name) = component else {
            return Err("invalid Script output path component".into());
        };
        cursor.push(name);
        match fs::symlink_metadata(&cursor) {
            Ok(meta) => {
                if meta.file_type().is_symlink() || !meta.is_dir() {
                    return Err("unsafe symlink or file in Script output directory".into());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                use std::os::unix::fs::DirBuilderExt;
                fs::DirBuilder::new()
                    .mode(0o700)
                    .create(&cursor)
                    .map_err(|e| format!("private Script directory creation: {e}"))?;
            }
            Err(error) => return Err(format!("private Script output directory: {error}")),
        }
    }
    Ok(())
}
fn project_root(job: &Value, root: &Path) -> Result<PathBuf, String> {
    let project = job["projectRoot"]
        .as_str()
        .ok_or("Job projectRoot missing")?;
    let path = Path::new(project)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !path.starts_with(root) {
        return Err("native Script project outside isolated root".into());
    }
    Ok(path)
}
fn script_spec(
    root: &Path,
    job: &Value,
    task: &Value,
    execution_id: &str,
    adapter: &NativeScriptAdapter,
) -> Result<(WorkerSpec, PathBuf), String> {
    let id = job["id"].as_str().ok_or("Job id missing")?;
    let task_id = task["id"].as_str().ok_or("Task id missing")?;
    if ![id, task_id, execution_id]
        .iter()
        .all(|value| stable_id(value))
    {
        return Err("unsafe native Script output path identity".into());
    }
    let dir = root
        .join(".relay-rust-native-executions")
        .join(id)
        .join(task_id)
        .join(execution_id);
    private_dir(root, &dir)?;
    let evidence = dir.join("result.json");
    let project = project_root(job, root)?;
    let timeout = task["timeoutMs"]
        .as_u64()
        .filter(|value| *value >= 10 && *value <= 3_600_000)
        .ok_or("Task timeout missing or out of bounds for native Worker")?;
    let mut env = adapter.env.clone();
    env.insert("PATH".into(), "/usr/bin:/bin".into());
    env.insert("RELAY_JOB_ID".into(), id.into());
    env.insert("RELAY_TASK_ID".into(), task_id.into());
    env.insert("RELAY_EXECUTION_ID".into(), execution_id.into());
    env.insert(
        "RELAY_RESULT_PATH".into(),
        evidence.to_string_lossy().into_owned(),
    );
    Ok((
        WorkerSpec {
            executable: adapter.executable.clone(),
            args: adapter.args.clone(),
            cwd: project,
            env,
            stdout: dir.join("stdout.log"),
            stderr: dir.join("stderr.log"),
            timeout: Duration::from_millis(timeout),
            terminate_grace: Duration::from_millis(250),
        },
        evidence,
    ))
}

pub fn tick(opt: &NativeDaemonOptions) -> Result<NativeTick, String> {
    tick_with_stop(opt, Arc::new(AtomicBool::new(false)))
}
pub fn tick_with_stop(
    opt: &NativeDaemonOptions,
    stopped: Arc<AtomicBool>,
) -> Result<NativeTick, String> {
    let root = isolated_store_root(&opt.db)?;
    if !opt.helper.is_absolute() || !opt.helper.is_file() {
        return Err("absolute native worker-helper required".into());
    }
    if opt.max_tasks == 0 || opt.max_tasks > 100 {
        return Err("max_tasks must be 1..100".into());
    }
    let agents = manifest(opt, &root)?;
    let reader = RelayReader::open(&opt.db)?;
    let mut authority = RelayAuthority::open_existing(&opt.db)?;
    let mut report = NativeTick::default();
    let mut offset = 0;
    // Inventory before any mutation, then re-read each Job's authoritative
    // state. Store pagination is stable only while this single isolated daemon
    // owns its marked fixture; competing ticks are safe through SQLite CAS.
    let mut jobs = vec![];
    loop {
        let batch = reader.list_jobs(1000, offset)?;
        let size = batch.len();
        jobs.extend(batch.into_iter().map(|j| j.job_id));
        if size < 1000 {
            break;
        }
        offset += 1000;
    }
    let mut scanned = HashSet::new();
    for id in jobs {
        if stopped.load(Ordering::SeqCst) {
            break;
        }
        if !scanned.insert(id.clone()) {
            continue;
        }
        let Some(mut job) = authority.read_job(&id)? else {
            continue;
        };
        report.jobs_seen += 1;
        if job["state"] != "ACTIVE" || job.get("pause").is_some_and(|v| !v.is_null()) {
            continue;
        }
        let changed = authority.reconcile_native_dependencies(
            &id,
            &after_time(job["updatedAt"].as_str().ok_or("Job timestamp missing")?)?,
        )?;
        report.tasks_queued += changed.len();
        job = authority
            .read_job(&id)?
            .ok_or("Job lost after dependency reconciliation")?;
        for task in job["tasks"].as_array().ok_or("Job Tasks invalid")? {
            let Some(task_id) = task["id"].as_str() else {
                continue;
            };
            let Some(execution) = task["executionId"].as_str() else {
                continue;
            };
            if !matches!(task["state"].as_str(), Some("RUNNING" | "QUEUED")) {
                continue;
            }
            let Some(expiry) = task["leaseExpiresAt"].as_str() else {
                continue;
            };
            let Ok(deadline) = DateTime::parse_from_rfc3339(expiry) else {
                continue;
            };
            if deadline
                > DateTime::parse_from_rfc3339(&current_time()).map_err(|e| e.to_string())?
            {
                continue;
            }
            let Some(process) = authority.process_record(&id, task_id, execution)? else {
                report.blocked.push(format!(
                    "{id}/{task_id}: expired, no durable PID; manual reconciliation"
                ));
                continue;
            };
            let probe = probe_process(Some(&process));
            let assessment =
                inspect_expired_execution(&job, task_id, &current_time(), probe, false)?;
            if assessment
                .as_ref()
                .is_some_and(|assessment| assessment.status == "eligible")
            {
                match authority.fail_proven_expired_lease(
                    &id,
                    task_id,
                    &after_time(job["updatedAt"].as_str().ok_or("Job timestamp")?)?,
                ) {
                    Ok(Some(_)) => report.tasks_recovered += 1,
                    Ok(None) => {}
                    Err(error) => report
                        .blocked
                        .push(format!("{id}/{task_id}: recovery blocked: {error}")),
                }
            } else {
                report
                    .blocked
                    .push(format!("{id}/{task_id}: process unresolved: {probe:?}"));
            }
        }
        job = authority.read_job(&id)?.ok_or("Job lost after recovery")?;
        let tasks = job["tasks"].as_array().ok_or("Job Tasks missing")?.clone();
        for task in tasks {
            if stopped.load(Ordering::SeqCst) {
                break;
            }
            if report.tasks_claimed >= opt.max_tasks {
                break;
            }
            if task["state"] != "QUEUED"
                || task["adapter"] != "script"
                || task.get("executionId").is_some_and(|v| !v.is_null())
            {
                continue;
            }
            let Some(task_id) = task["id"].as_str() else {
                continue;
            };
            let Some(name) = task["agentName"].as_str() else {
                report
                    .blocked
                    .push(format!("{id}/{task_id}: missing Script agentName"));
                continue;
            };
            let Some(agent) = agents.agents.get(name) else {
                report.blocked.push(format!(
                    "{id}/{task_id}: no trusted Script adapter for {name}"
                ));
                continue;
            };
            let execution_id = uuid::Uuid::new_v4().to_string();
            let (spec, evidence) = match script_spec(&root, &job, &task, &execution_id, agent) {
                Ok(spec) => spec,
                Err(error) => {
                    report.blocked.push(format!("{id}/{task_id}: {error}"));
                    continue;
                }
            };
            let now = after_time(job["updatedAt"].as_str().ok_or("Job timestamp missing")?)?;
            let now_parsed = DateTime::parse_from_rfc3339(&now).map_err(|e| e.to_string())?;
            let duration = ChronoDuration::milliseconds(
                i64::try_from(spec.timeout.as_millis()).map_err(|_| "Worker timeout overflow")?
                    + 30_000,
            );
            let expiry = (now_parsed + duration).to_rfc3339_opts(SecondsFormat::Millis, true);
            let claim = match authority.claim_queued_script(&ScriptClaimRequest {
                job_id: &id,
                task_id,
                execution_id: &execution_id,
                owner: "rust-native-isolated",
                at: &now,
                lease_expires_at: &expiry,
            }) {
                Ok(Some(claim)) => claim,
                Ok(None) => {
                    if let Some(path) = evidence.parent() {
                        let _ = fs::remove_dir(path);
                    }
                    continue;
                }
                Err(error) => {
                    // A lost SQLite claim must not leak an unbounded
                    // per-attempt output directory on every daemon tick.
                    if let Some(path) = evidence.parent() {
                        let _ = fs::remove_dir(path);
                    }

                    report
                        .blocked
                        .push(format!("{id}/{task_id}: claim refused: {error}"));
                    continue;
                }
            };
            report.tasks_claimed += 1;
            match execute_supervised_script(
                &mut authority,
                &claim,
                &spec,
                &evidence,
                &opt.helper,
                Arc::clone(&stopped),
            ) {
                Ok(result) if result.verified => report.tasks_succeeded += 1,
                Ok(_) => report.tasks_failed += 1,
                Err(error) => report
                    .blocked
                    .push(format!("{id}/{task_id}: launch/receipt uncertain: {error}")),
            }
            job = authority.read_job(&id)?.ok_or("Job lost after Script")?;
        }
    }
    Ok(report)
}
