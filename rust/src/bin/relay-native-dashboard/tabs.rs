//! Additional native Rust Dashboard views: honest durable usage, embedded
//! canonical Graphs, and bounded operator settings. No Node Relay runtime.
use agents_relay_rust::store::RelayReader;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

const GRAPH_SOURCES: &[(&str, &str)] = &[
    (
        "authoritative-unblock.mmd",
        include_str!("../../../../workflow/authoritative-unblock.mmd"),
    ),
    (
        "blocker-recovery.mmd",
        include_str!("../../../../workflow/blocker-recovery.mmd"),
    ),
    (
        "blocker-resolution.mmd",
        include_str!("../../../../workflow/blocker-resolution.mmd"),
    ),
    (
        "browser-worker-pool.mmd",
        include_str!("../../../../workflow/browser-worker-pool.mmd"),
    ),
    (
        "dependency-revision.mmd",
        include_str!("../../../../workflow/dependency-revision.mmd"),
    ),
    (
        "escalation.mmd",
        include_str!("../../../../workflow/escalation.mmd"),
    ),
    (
        "force-restate-validation.mmd",
        include_str!("../../../../workflow/force-restate-validation.mmd"),
    ),
    (
        "interactive-invocation.mmd",
        include_str!("../../../../workflow/interactive-invocation.mmd"),
    ),
    (
        "job-lifecycle.mmd",
        include_str!("../../../../workflow/job-lifecycle.mmd"),
    ),
    ("main.mmd", include_str!("../../../../workflow/main.mmd")),
    (
        "orchestrator-rescue.mmd",
        include_str!("../../../../workflow/orchestrator-rescue.mmd"),
    ),
    (
        "planner-orchestration.mmd",
        include_str!("../../../../workflow/planner-orchestration.mmd"),
    ),
    (
        "planner-trigger.mmd",
        include_str!("../../../../workflow/planner-trigger.mmd"),
    ),
    (
        "projection-conflict.mmd",
        include_str!("../../../../workflow/projection-conflict.mmd"),
    ),
    (
        "review-lifecycle.mmd",
        include_str!("../../../../workflow/review-lifecycle.mmd"),
    ),
    (
        "revision-lifecycle.mmd",
        include_str!("../../../../workflow/revision-lifecycle.mmd"),
    ),
    (
        "task-lifecycle.mmd",
        include_str!("../../../../workflow/task-lifecycle.mmd"),
    ),
    (
        "task-related-action.mmd",
        include_str!("../../../../workflow/task-related-action.mmd"),
    ),
    (
        "task-resolution.mmd",
        include_str!("../../../../workflow/task-resolution.mmd"),
    ),
    (
        "troubleshooter.mmd",
        include_str!("../../../../workflow/troubleshooter.mmd"),
    ),
];

fn digest(contents: &[u8]) -> String {
    format!("{:x}", Sha256::digest(contents))
}

pub(super) fn graphs() -> Value {
    // Match the original Node DashboardWorkflowGraph shape. Every source is
    // embedded directly from the canonical workflow directory at build time.
    Value::Array(
        GRAPH_SOURCES
            .iter()
            .map(|(file, source)| {
                let id = file.trim_end_matches(".mmd");
                let metadata = source
                    .strip_prefix("---\n")
                    .and_then(|contents| contents.split_once("\n---"))
                    .map(|(header, _)| header)
                    .unwrap_or("");
                let field = |key: &str| -> String {
                    metadata
                        .lines()
                        .find_map(|line| {
                            line.trim()
                                .strip_prefix(&format!("{key}:"))
                                .map(str::trim)
                                .map(str::to_owned)
                        })
                        .unwrap_or_default()
                };
                let name = field("title");
                let name = if name.is_empty() {
                    if id == "main" {
                        "Main / Happy Path".to_owned()
                    } else {
                        id.split('-')
                            .map(|part| {
                                let mut chars = part.chars();
                                let first = chars
                                    .next()
                                    .map(|letter| letter.to_uppercase().collect::<String>())
                                    .unwrap_or_default();
                                first + chars.as_str()
                            })
                            .collect::<Vec<_>>()
                            .join(" ")
                    }
                } else {
                    name
                };
                json!({"id":id,"name":name,"description":field("description"),
            "path":format!("workflow/{file}"),"source":source})
            })
            .collect(),
    )
}

pub(super) fn graph_symbol(graph: &str, kind: &str, name: &str) -> Option<Value> {
    if name.len() > 128
        || name.is_empty()
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
    {
        return None;
    }
    let id = graph.strip_suffix(".mmd").unwrap_or(graph);
    let (file, source) = GRAPH_SOURCES
        .iter()
        .find(|(file, _)| file.trim_end_matches(".mmd") == id)?;
    let needle = if kind == "Event" {
        format!("on: {name}")
    } else if matches!(kind, "Guard" | "Action" | "State") {
        format!("{}: {name}", kind.to_ascii_lowercase())
    } else {
        return None;
    };
    let (index, _) = source
        .lines()
        .enumerate()
        .find(|(_, line)| line.contains(&needle))?;
    Some(
        json!({"graph":{"path":format!("workflow/{file}"),"line":index+1,
        "evidence":"exact-token"},"contracts":[],"implementation":[],"tests":[]}),
    )
}

pub(super) fn usage(reader: &RelayReader) -> Result<Value, String> {
    let mut jobs_total = 0_u64;
    let mut tasks_total = 0_u64;
    let mut attempts = 0_u64;
    let mut states = BTreeMap::<String, u64>::new();
    let mut job_states = BTreeMap::<String, u64>::new();
    let mut routes = BTreeMap::<String, u64>::new();
    let mut executions = 0_u64;
    let mut offset = 0_u32;
    loop {
        let page = reader.list_jobs(1000, offset)?;
        let count = page.len();
        for snapshot in page {
            let job = snapshot.job;
            jobs_total += 1;
            let state = job["state"].as_str().unwrap_or("UNKNOWN").to_owned();
            *job_states.entry(state).or_default() += 1;
            for task in job["tasks"].as_array().into_iter().flatten() {
                tasks_total += 1;
                attempts += task["attempt"].as_u64().unwrap_or(0);
                let state = task["state"].as_str().unwrap_or("UNKNOWN").to_owned();
                *states.entry(state).or_default() += 1;
                if let Some(history) = task["executionHistory"].as_array() {
                    executions += history.len() as u64;
                }
                let route = &task["routing"];
                if let Some(model) = route["model"].as_str().filter(|v| !v.is_empty()) {
                    let provider = route["provider"].as_str().unwrap_or("unknown");
                    *routes.entry(format!("{provider} / {model}")).or_default() += 1;
                }
            }
        }
        if count < 1000 {
            break;
        }
        offset = offset
            .checked_add(count as u32)
            .ok_or("usage offset overflow")?;
    }
    Ok(json!({
        "backend":"rust-native",
        "source":"durable Rust Job snapshots",
        "jobs":jobs_total,"tasks":tasks_total,"attempts":attempts,
        "executionRecords":executions,
        "jobStates":job_states,"taskStates":states,"routes":routes,
        "providers":[{"label":"Rust durable execution",
            "usage":{"available":false,"reason":format!(
                "{jobs_total} Jobs · {tasks_total} Tasks · {attempts} Task attempts · {executions} recorded executions. Provider account quotas are not connected."
            )}}],
        "credits":[],
        "accountQuota":{"available":false,"reason":"Account credit balances and provider rate limits are not connected to the Rust Dashboard. Counts shown are durable Task records, not billed tokens."}
    }))
}

pub(super) fn audit(reader: &RelayReader) -> Result<Value, String> {
    let mut records = Vec::new();
    let mut offset = 0u32;
    loop {
        let page = reader.list_jobs(1000, offset)?;
        let count = page.len();
        for snapshot in page {
            let job = snapshot.job;
            for task in job["tasks"].as_array().into_iter().flatten() {
                if task["routing"].is_null() {
                    continue;
                }
                records.push(json!({"jobId":job["id"],"taskId":task["id"],
                    "title":task["title"],"state":task["state"],"at":task["updatedAt"],
                    "provider":task["routing"]["provider"],"model":task["routing"]["model"],
                    "reason":task["routing"]["reason"],"decidedBy":task["routing"]["decidedBy"]}));
            }
        }
        if count < 1000 {
            break;
        }
        offset = offset
            .checked_add(count as u32)
            .ok_or("audit offset overflow")?;
    }
    records.sort_by(|a, b| {
        b["at"]
            .as_str()
            .unwrap_or("")
            .cmp(a["at"].as_str().unwrap_or(""))
    });
    records.truncate(30);
    Ok(Value::Array(records))
}

pub(super) fn inspect_route(
    reader: &RelayReader,
    job_id: &str,
    task_id: &str,
) -> Result<Value, String> {
    if job_id.len() > 128
        || task_id.len() > 128
        || job_id.is_empty()
        || task_id.is_empty()
        || ![job_id, task_id].iter().all(|id| {
            id.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
        })
    {
        return Err("invalid Job or Task identity".into());
    }
    let snapshot = reader.get_job(job_id)?.ok_or("Job not found")?;
    let task = snapshot.job["tasks"]
        .as_array()
        .and_then(|tasks| tasks.iter().find(|t| t["id"] == task_id))
        .ok_or("Task not found")?;
    Ok(
        json!({"source":"durable Task routing decision (read-only; not a fresh model routing call)",
        "jobId":job_id,"taskId":task_id,"title":task["title"],
        "routing":task["routing"],"routingExclusions":task["routingExclusions"],
        "workerRequirements":task["workerRequirements"],"adapter":task["adapter"]}),
    )
}

#[derive(Clone, Copy)]
pub(super) enum Settings {
    Router,
    TroubleshooterQa,
}

fn settings_path(kind: Settings) -> Result<PathBuf, String> {
    match kind {
        Settings::Router => {
            if let Ok(path) = std::env::var("AGENTS_RELAY_EXECUTION_ROUTER_RULES") {
                return Ok(PathBuf::from(path));
            }
            let home = std::env::var_os("HOME").ok_or("HOME not set")?;
            Ok(PathBuf::from(home).join(".agents-relay/execution-router-rules.md"))
        }
        Settings::TroubleshooterQa => {
            let root = std::env::var_os("AGENTS_RELAY_SOURCE_ROOT")
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    Path::new(env!("CARGO_MANIFEST_DIR"))
                        .parent()
                        .expect("Cargo manifest has parent")
                        .to_path_buf()
                });
            Ok(root.join("skills/agents-relay/troubleshooter-qa.md"))
        }
    }
}

fn read_settings_bytes(kind: Settings) -> Result<Vec<u8>, String> {
    let path = settings_path(kind)?;
    match fs::symlink_metadata(&path) {
        Ok(meta) => {
            if meta.file_type().is_symlink() || !meta.is_file() {
                return Err("Settings file must be a regular file, not a symlink".into());
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && matches!(kind, Settings::Router) => {
            return Ok(Vec::new())
        }
        Err(e) => return Err(format!("Settings file unavailable: {e}")),
    }
    let max = match kind {
        Settings::Router => 65_536,
        Settings::TroubleshooterQa => 131_072,
    };
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    if bytes.len() > max {
        return Err("Settings file too large".into());
    }
    Ok(bytes)
}

pub(super) fn read_settings(kind: Settings) -> Result<Value, String> {
    let bytes = read_settings_bytes(kind)?;
    let text = String::from_utf8(bytes.clone()).map_err(|_| "Settings not UTF-8")?;
    Ok(json!({"text":text,"hash":digest(&bytes),"editableLocally":true}))
}

#[derive(Debug)]
pub(super) enum SaveFailure {
    Invalid(String),
    Conflict,
    Storage(String),
}

pub(super) fn save_settings(kind: Settings, raw: &[u8]) -> Result<Value, SaveFailure> {
    let max = match kind {
        Settings::Router => 65_536,
        Settings::TroubleshooterQa => 131_072,
    };
    if raw.len() > max + 512 {
        return Err(SaveFailure::Invalid("Settings payload too large".into()));
    }
    let body: Value = serde_json::from_slice(raw)
        .map_err(|_| SaveFailure::Invalid("JSON payload required".into()))?;
    let text = body["text"]
        .as_str()
        .ok_or_else(|| SaveFailure::Invalid("text must be a string".into()))?;
    let expected = body["hash"]
        .as_str()
        .ok_or_else(|| SaveFailure::Invalid("hash must be a string".into()))?;
    if text.len() > max || text.contains('\0') {
        return Err(SaveFailure::Invalid("Invalid settings text or size".into()));
    }
    let current = read_settings_bytes(kind).map_err(SaveFailure::Storage)?;
    if digest(&current) != expected {
        return Err(SaveFailure::Conflict);
    }
    if current == text.as_bytes() {
        return Ok(json!({"text":text,"hash":expected,"unchanged":true}));
    }
    let path = settings_path(kind).map_err(SaveFailure::Storage)?;
    let parent = path
        .parent()
        .ok_or_else(|| SaveFailure::Storage("Settings file parent missing".into()))?;
    if matches!(kind, Settings::Router) {
        fs::create_dir_all(parent).map_err(|e| SaveFailure::Storage(e.to_string()))?;
    }
    if !parent.is_dir() {
        return Err(SaveFailure::Storage("Settings directory missing".into()));
    }
    let temporary = parent.join(format!(".relay-dashboard-{}.tmp", uuid::Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(|e| SaveFailure::Storage(e.to_string()))?;
    let result = (|| {
        file.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        // Recheck before rename; reject concurrent edits rather than overwriting.
        if read_settings_bytes(kind)? != current {
            return Err("Concurrent settings change".into());
        }
        fs::rename(&temporary, &path).map_err(|e| e.to_string())?;
        Ok::<(), String>(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary);
        if error == "Concurrent settings change" {
            return Err(SaveFailure::Conflict);
        }
        return Err(SaveFailure::Storage(error));
    }
    Ok(json!({"text":text,"hash":digest(text.as_bytes()),"saved":true}))
}

pub(super) fn configured_views() -> Value {
    json!({"views":["jobs","usage","rules","qa","graphs"],
        "backend":"rust-native","jobsBackend":"rust-live"})
}
