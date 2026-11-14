//! Isolated, single-host Script/Model-port Relay reconciler/daemon. Graphs own transition
//! policy, the ordinary SQLite Job snapshot owns Tasks, and relay-worker-helper
//! owns OS process groups. The explicit test-store fence prevents this staged
//! backend from ever racing the production TypeScript daemon.
mod adapter;
use crate::authority::{probe_process, RelayAuthority, ScriptClaimRequest};
use crate::recovery::inspect_expired_execution;
use crate::store::RelayReader;
use crate::supervised_script::{after_time, current_time, execute_supervised_script};
use adapter::{manifest, script_spec};
use chrono::{DateTime, Duration as ChronoDuration, SecondsFormat};
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

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
