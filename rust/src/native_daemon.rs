//! Isolated, single-host Script/Model-port Relay reconciler/daemon. Graphs own transition
//! policy, the ordinary SQLite Job snapshot owns Tasks, and relay-worker-helper
//! owns OS process groups. The explicit test-store fence prevents this staged
//! backend from ever racing the production TypeScript daemon.
mod adapter;
mod dag;
mod local_merge;
mod planner;
mod review;
mod troubleshooter;
use crate::authority::{probe_process, RelayAuthority, ScriptClaimRequest};
use crate::native_job::{complete_approved_local_job, complete_no_review_job};
use crate::recovery::inspect_expired_execution;
use crate::store::RelayReader;
use crate::supervised_script::{after_time, current_time, execute_supervised_script};
use adapter::{manifest, script_spec};
use chrono::{DateTime, Duration as ChronoDuration, SecondsFormat};
use dag::{complete_native_dag, reconcile_native_dag};
pub(crate) use review::{
    apply_native_reviewer_result, reconcile_native_final_review,
    reconcile_native_review_revision_routes, resume_accepted_native_reviews,
};
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use troubleshooter::reconcile_native_troubleshooters;

#[derive(Debug, Clone)]
pub struct NativeDaemonOptions {
    pub db: PathBuf,
    pub manifest: PathBuf,
    pub helper: PathBuf,
    pub max_tasks: usize,
}

/// Keep the daemon-owned peer-credential-checked Unix control socket alive
/// while a physical Worker is executing. Polling control only *after* tick()
/// deadlocked any Troubleshooter calling `task recover` from inside that tick.
/// The OS daemon lock still guarantees a single owner, and every socket write
/// goes through the canonical Graph and SQLite IMMEDIATE transaction guards.
#[cfg(unix)]
pub struct NativeControlLoop {
    running: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}
#[cfg(unix)]
impl NativeControlLoop {
    pub fn bind(db: &Path) -> Result<Self, String> {
        let server = crate::native_control::NativeControlServer::bind(db)?;
        let path = db.to_path_buf();
        let running = Arc::new(AtomicBool::new(true));
        let flag = Arc::clone(&running);
        let thread = std::thread::Builder::new()
            .name("rust-relay-authority-control".into())
            .spawn(move || {
                while flag.load(Ordering::SeqCst) {
                    match server.serve_one(&path) {
                        Ok(_) => {}
                        Err(error) => eprintln!("Rust Relay native control: {error}"),
                    }
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
                // Drop of server securely removes the owned socket path.
            })
            .map_err(|e| format!("native control thread: {e}"))?;
        Ok(Self {
            running,
            thread: Some(thread),
        })
    }
}
#[cfg(unix)]
impl Drop for NativeControlLoop {
    fn drop(&mut self) {
        self.running.store(false, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
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
    pub tasks_reopened: usize,
    pub troubleshooters_created: usize,
    pub reviews_resumed: usize,
    pub review_revision_routes: usize,
    pub planner_routes_bound: usize,
    pub local_merges_succeeded: usize,
    pub local_merges_failed: usize,
    pub review_results_applied: usize,
    pub reviews_queued: usize,
    pub jobs_completed: usize,
    pub blocked: Vec<String>,
}

/// This LIVE namespace is permanently separate from TypeScript production Job
/// stores. A deliberate mode and exact on-disk owner marker are mandatory.
/// No existing production SQLite file or guessed path can pass this fence.
pub fn live_store_root(db: &Path) -> Result<PathBuf, String> {
    if std::env::var("RELAY_RUST_LIVE_MODE").ok().as_deref() != Some("pilot-live") {
        return Err("Rust live namespace is not enabled".into());
    }
    let home = PathBuf::from(std::env::var("HOME").map_err(|_| "HOME not set")?)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let expected = home.join(".local/state/agents-relay/rust-live");
    let root = expected.canonicalize().map_err(|e| e.to_string())?;
    if root != expected || !root.is_dir() || db.file_name().is_none_or(|n| n != "relay.sqlite") {
        return Err("invalid Rust live namespace path".into());
    }
    if db
        .parent()
        .ok_or("database parent missing")?
        .canonicalize()
        .map_err(|e| e.to_string())?
        != root
    {
        return Err("Rust live namespace refuses production or alias paths".into());
    }
    let marker = root.join(".relay-rust-live-namespace-v1");
    if !marker.is_file()
        || std::fs::read_to_string(&marker).map_err(|e| e.to_string())?
            != "rust-relay-owned-standalone-namespace-v1\n"
    {
        return Err("Rust live namespace requires an exact operator marker".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let meta = std::fs::metadata(&root).map_err(|e| e.to_string())?;
        if meta.uid() != unsafe { nix::libc::geteuid() } || meta.permissions().mode() & 0o077 != 0 {
            return Err("Rust live namespace must be private and user-owned".into());
        }
    }
    Ok(root)
}

/// The production DB is an explicit, operator-authorized, *shared* SQLite
/// authority. Runtime locks, sockets, and execution requests live in a private
/// companion directory; there is never a second Job database or ID sequence.
/// Only the canonical, non-symlinked HOME/.agents-relay/relay.sqlite is eligible.
pub fn canonical_live_mode() -> bool {
    std::env::var("RELAY_RUST_LIVE_MODE").ok().as_deref() == Some("canonical-live")
}

pub fn canonical_store_root(db: &Path) -> Result<PathBuf, String> {
    if !canonical_live_mode() {
        return Err("canonical Relay mode is not enabled".into());
    }
    let home = PathBuf::from(std::env::var("HOME").map_err(|_| "HOME not set")?)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let expected = home.join(".agents-relay/relay.sqlite");
    let parent = expected.parent().ok_or("canonical DB parent missing")?;
    if db != expected
        || db.canonicalize().map_err(|e| e.to_string())? != expected
        || !parent.is_dir()
    {
        return Err(
            "Rust canonical mode requires the real, non-aliased ~/.agents-relay/relay.sqlite"
                .into(),
        );
    }
    let root = home.join(".local/state/agents-relay/canonical-rust");
    if !root.is_dir() || root.canonicalize().map_err(|e| e.to_string())? != root {
        return Err("canonical runtime directory must be pre-provisioned, not a symlink".into());
    }
    if std::fs::read_to_string(root.join(".canonical-relay-owner-v1")).map_err(|e| e.to_string())?
        != "canonical-rust-operator-approved-v1\n"
    {
        return Err("canonical Rust requires explicit operator ownership marker".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let runtime = std::fs::metadata(&root).map_err(|e| e.to_string())?;
        let database = std::fs::symlink_metadata(&expected).map_err(|e| e.to_string())?;
        let uid = unsafe { nix::libc::geteuid() };
        if runtime.uid() != uid
            || runtime.permissions().mode() & 0o777 != 0o700
            || database.uid() != uid
            || !database.file_type().is_file()
            || database.permissions().mode() & 0o022 != 0
        {
            return Err("canonical Relay database/runtime ownership or permissions invalid".into());
        }
    }
    Ok(root)
}

/// Project access is bound to Neo's configured, independent Git repositories.
/// Isolated test and pilot-live modes keep their existing stricter root fence.
pub fn authorized_project(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let project = path.canonicalize().map_err(|e| e.to_string())?;
    if !project.is_dir() {
        return Err("Job project root must be a directory".into());
    }
    if !canonical_live_mode() {
        return project
            .starts_with(root)
            .then_some(project)
            .ok_or_else(|| "native project outside isolated root".into());
    }
    let home = PathBuf::from(std::env::var("HOME").map_err(|_| "HOME not set")?);
    let neo = if let Ok(value) = std::env::var("NEO_ROOT") {
        PathBuf::from(value)
    } else {
        let cfg = home.join(".config/neo/workspace.json");
        if cfg.is_file() {
            let contents: serde_json::Value =
                serde_json::from_slice(&std::fs::read(cfg).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            if contents["schemaVersion"] != 1 {
                return Err("invalid Neo workspace configuration".into());
            }
            PathBuf::from(
                contents["neoRoot"]
                    .as_str()
                    .ok_or("Neo root not configured")?,
            )
        } else {
            home.join("Workspace")
        }
    };
    let neo = neo
        .canonicalize()
        .map_err(|e| format!("Neo root unavailable: {e}"))?;
    if project == neo || !project.starts_with(&neo) || !project.join(".git").exists() {
        return Err("canonical Job must use an independent Git repository under Neo root".into());
    }
    Ok(project)
}

pub fn authorized_context_root(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let context = path.canonicalize().map_err(|e| e.to_string())?;
    if !context.is_dir() {
        return Err("Coordinator context root must be a directory".into());
    }
    if !canonical_live_mode() {
        return context
            .starts_with(root)
            .then_some(context)
            .ok_or_else(|| "native Coordinator context outside isolated root".into());
    }
    let home = PathBuf::from(std::env::var("HOME").map_err(|_| "HOME not set")?)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    // Node's Neo Project harness shares the Workspace tree, plus trusted
    // per-user ~/.agents context. Neither path is supplied by the HTTP client.
    if context.starts_with(home.join("Workspace")) || context.starts_with(home.join(".agents")) {
        Ok(context)
    } else {
        Err("canonical Coordinator context is outside trusted user workspace".into())
    }
}

/// Isolated and pilot stores remain fenced from the existing Node namespace.
/// Canonical Relay mode is a separate explicit, operator-marked SQLite owner
/// that does not claim preexisting Node Jobs without native intake authority.
pub fn isolated_store_root(db: &Path) -> Result<PathBuf, String> {
    if canonical_live_mode() {
        return canonical_store_root(db);
    }
    if std::env::var("RELAY_RUST_LIVE_MODE").ok().as_deref() == Some("pilot-live") {
        let root = live_store_root(db)?;
        if !db.is_file()
            || db.canonicalize().map_err(|e| e.to_string())? != root.join("relay.sqlite")
        {
            return Err("live namespace database is not the canonical store file".into());
        }
        return Ok(root);
    }
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
fn cleanup_unclaimed_request(root: &Path, evidence: &Path) {
    let Some(dir) = evidence.parent() else {
        return;
    };
    // This path was minted by script_spec from a validated stable ID and a
    // fresh UUID. Never perform generalized recursive deletion.
    if !dir.starts_with(root.join(".relay-rust-native-executions")) {
        return;
    }
    let _ = fs::remove_file(dir.join("request.json"));
    let _ = fs::remove_dir(dir);
}

pub(crate) fn tick_with_stop(
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
        // The canonical file contains legacy Node Jobs whose running leases
        // and Graph state are not yet certified for native takeover. Never
        // execute these from a second scheduler or infer Rust ownership.
        if canonical_live_mode() && job["nativeIntakeHash"].as_str().is_none() {
            continue;
        }
        resume_accepted_native_reviews(&mut authority, &id, &mut report)?;
        reconcile_native_review_revision_routes(&mut authority, &id, &agents, &mut report)?;
        let reopen_at = after_time(job["updatedAt"].as_str().ok_or("Job timestamp missing")?)?;
        report.tasks_reopened += authority
            .reconcile_troubleshooter_reopens(&id, &reopen_at)?
            .len();
        reconcile_native_troubleshooters(&mut authority, &id, &agents, &mut report)?;
        reconcile_native_dag(&mut authority, &id, &root, &agents, &mut report)?;
        job = authority
            .read_job(&id)?
            .ok_or("Job lost after DAG reconciliation")?;
        let changed = authority.reconcile_native_dependencies(
            &id,
            &after_time(job["updatedAt"].as_str().ok_or("Job timestamp missing")?)?,
        )?;
        report.tasks_queued += changed.len();
        planner::reconcile_planner_routes(&mut authority, &id, &agents, &mut report)?;
        job = authority
            .read_job(&id)?
            .ok_or("Job lost after Planner routing")?;
        let mut launches = Vec::new();
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
                || !matches!(task["adapter"].as_str(), Some("script" | "codex"))
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
            let request = ScriptClaimRequest {
                job_id: &id,
                task_id,
                execution_id: &execution_id,
                owner: "rust-native-isolated",
                at: &now,
                lease_expires_at: &expiry,
            };
            let claim = match if task["adapter"] == "codex" {
                authority.claim_queued_codex(&request)
            } else {
                authority.claim_queued_script(&request)
            } {
                Ok(Some(claim)) => claim,
                Ok(None) => {
                    cleanup_unclaimed_request(&root, &evidence);
                    continue;
                }
                Err(error) => {
                    // A denied SQLite claim must not leak private model
                    // request files on every single-node daemon tick.
                    cleanup_unclaimed_request(&root, &evidence);

                    report
                        .blocked
                        .push(format!("{id}/{task_id}: claim refused: {error}"));
                    continue;
                }
            };
            report.tasks_claimed += 1;
            launches.push((claim, spec, evidence));
        }
        // Claims are committed one Task at a time through the Graph-authorized
        // SQLite action ledger above. Run those independent leased executions
        // concurrently, each with its own SQLite connection. max_tasks bounds
        // this batch; the per-Task lease and generation remain the fence.
        std::thread::scope(|scope| -> Result<(), String> {
            let handles: Vec<_> = launches
                .into_iter()
                .map(|(claim, spec, evidence)| {
                    let worker_stop = Arc::clone(&stopped);
                    scope.spawn(move || {
                        let task_id = claim.task_id.clone();
                        let mut worker_authority = RelayAuthority::open_existing(&opt.db)
                            .map_err(|error| (task_id.clone(), error))?;
                        execute_supervised_script(
                            &mut worker_authority,
                            &claim,
                            &spec,
                            &evidence,
                            &opt.helper,
                            &opt.db,
                            worker_stop,
                        )
                        .map(|result| (claim.task_id, result.verified))
                        .map_err(|error| (task_id, error))
                    })
                })
                .collect();
            for handle in handles {
                match handle.join() {
                    Ok(Ok((_task_id, true))) => report.tasks_succeeded += 1,
                    Ok(Ok((_task_id, false))) => report.tasks_failed += 1,
                    Ok(Err((task_id, error))) => report
                        .blocked
                        .push(format!("{id}/{task_id}: launch/receipt uncertain: {error}")),
                    Err(_) => report.blocked.push(format!(
                        "{id}: worker thread panicked; claimed execution requires recovery"
                    )),
                }
            }
            Ok(())
        })?;
        complete_native_dag(&mut authority, &id, &mut report)?;
        match apply_native_reviewer_result(&mut authority, &id) {
            Ok(true) => report.review_results_applied += 1,
            Ok(false) => {}
            Err(error) => report
                .blocked
                .push(format!("{id}: reviewer result not accepted: {error}")),
        }
        if let Err(error) =
            reconcile_native_final_review(&mut authority, &id, &root, &agents, &mut report)
        {
            report
                .blocked
                .push(format!("{id}: Final Review scheduling failed: {error}"));
        }
        if let Err(error) =
            local_merge::reconcile_local_merge(&mut authority, &id, &root, &mut report)
        {
            report
                .blocked
                .push(format!("{id}: local merge delivery blocked: {error}"));
        }
        if complete_approved_local_job(&mut authority, &id)?
            || complete_no_review_job(&mut authority, &id)?
        {
            report.jobs_completed += 1;
        }
    }
    Ok(report)
}
