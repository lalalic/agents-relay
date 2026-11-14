//! Native pilot intake and Graph-governed Job transitions. One SQLite Job
//! store; no alternative scheduler or invented Final Review/merge receipts.
use crate::agent_graph::AgentGraph;
use crate::authority::{NativeJobSpec, RelayAuthority};
use crate::graph::{Decision, Graph, GraphInput};
use crate::native_daemon::isolated_store_root;
use crate::supervised_script::after_time;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

const JOB_GRAPH: &str = include_str!("../../workflow/job-lifecycle.mmd");

fn root_before_create(db: &Path) -> Result<PathBuf, String> {
    if std::env::var("RELAY_RUST_EXPERIMENTAL_TEST_ONLY")
        .ok()
        .as_deref()
        != Some("isolated-test")
    {
        return Err("native Job intake has no production authorization".into());
    }
    let root = db
        .parent()
        .ok_or("database parent missing")?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let temp = std::env::temp_dir()
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !root.starts_with(temp)
        || !root
            .file_name()
            .is_some_and(|n| n.to_string_lossy().starts_with("relay-rust-authority-"))
        || !root.join(".relay-rust-authority-isolated-test").is_file()
        || db.file_name().is_none_or(|name| name != "relay.sqlite")
    {
        return Err("native Job database must be marked isolated temporary store".into());
    }
    if db.exists() || db.symlink_metadata().is_ok() {
        return Err("native Job init refuses existing database or symlink".into());
    }
    Ok(root)
}
/// Only the isolated bootstrap initializes SQLite; later writes use the same
/// job_snapshot schema and connection as the TypeScript-backed authority.
pub fn init_isolated_store(db: &Path) -> Result<(), String> {
    root_before_create(db)?;
    let conn = Connection::open(db).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(db, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    }
    conn.execute_batch("PRAGMA journal_mode=WAL;
        CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE TABLE relay_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);")
        .map_err(|e|e.to_string())?;
    Ok(())
}
fn bounded_file(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let canonical = path.canonicalize().map_err(|e| e.to_string())?;
    if !canonical.is_file() || !canonical.starts_with(root) {
        return Err("native Job input/graph outside isolated root".into());
    }
    Ok(canonical)
}
pub struct DagJobRequest<'a> {
    pub db: &'a Path,
    pub project: &'a Path,
    pub graph_file: &'a Path,
    pub input_file: &'a Path,
    pub output_file: &'a Path,
    pub title: &'a str,
    pub repository: &'a str,
    pub request_key: &'a str,
}
pub fn create_dag_job(request: DagJobRequest<'_>) -> Result<Value, String> {
    let DagJobRequest {
        db,
        project,
        graph_file,
        input_file,
        output_file,
        title,
        repository,
        request_key,
    } = request;
    let root = isolated_store_root(db)?;
    let project = project.canonicalize().map_err(|e| e.to_string())?;
    if !project.starts_with(&root) || !project.is_dir() {
        return Err("native project outside isolated root".into());
    }
    let graph = fs::read_to_string(bounded_file(&root, graph_file)?).map_err(|e| e.to_string())?;
    let parsed = AgentGraph::parse(&graph)?;
    if parsed.nodes.is_empty() {
        return Err("empty Coordinator graph".into());
    }
    let input = fs::read_to_string(bounded_file(&root, input_file)?).map_err(|e| e.to_string())?;
    let parent = output_file
        .parent()
        .ok_or("output parent missing")?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !parent.starts_with(&root)
        || output_file
            .symlink_metadata()
            .is_ok_and(|m| m.file_type().is_symlink())
    {
        return Err("native Coordinator output must be a new file inside isolated root".into());
    }
    let output = parent.join(output_file.file_name().ok_or("output filename missing")?);
    let now = crate::supervised_script::current_time();
    let mut authority = RelayAuthority::open_existing(db)?;
    let created = authority.create_native_dag_job(NativeJobSpec {
        repository,
        title,
        project_root: &project.to_string_lossy(),
        input: &input,
        graph: &graph,
        output_path: &output.to_string_lossy(),
        request_key,
        at: &now,
    })?;
    Ok(
        json!({"jobId":created.job_id,"coordinatorTaskId":created.coordinator_task_id,
        "created":created.created,"state":"DRAFT"}),
    )
}
pub fn activate_job(db: &Path, job_id: &str) -> Result<Value, String> {
    isolated_store_root(db)?;
    let mut authority = RelayAuthority::open_existing(db)?;
    let snapshot = authority.read_job(job_id)?.ok_or("unknown Job")?;
    if snapshot["state"] == "ACTIVE" {
        return Ok(json!({"jobId":job_id,"activated":false,"state":"ACTIVE"}));
    }
    let at = after_time(
        snapshot["updatedAt"]
            .as_str()
            .ok_or("Job timestamp missing")?,
    )?;
    let graph = Graph::parse(JOB_GRAPH)?;
    let transitioned = authority.commit_job(job_id, &at, |prior| {
        if prior["state"] != "DRAFT" {
            return Err("Job activation requires DRAFT".into());
        }
        let decision = graph.decide(
            "DRAFT",
            GraphInput {
                transport: "event".into(),
                id: "activate".into(),
                payload: json!({}),
            },
            &HashMap::new(),
        )?;
        if !matches!(decision,Decision::Accepted{ref target,..} if target=="ACTIVE") {
            return Err("canonical Job Graph denied activation".into());
        }
        let mut next = prior.clone();
        next["state"] = json!("ACTIVE");
        next["runtimeStatus"] = json!("RUNNING");
        next["updatedAt"] = json!(at);
        Ok((next, vec![]))
    })?;
    Ok(json!({"jobId":job_id,"activated":true,"state":transitioned.job["state"]}))
}
fn no_review_completion_ready(job: &Value) -> bool {
    // These are deliberately conservative *facts*. JOB_GRAPH decides the
    // transition. Never infer approval from a worker's exit status.
    if job["state"] != "ACTIVE"
        || job["reviewEnabled"] != false
        || job["autoMerge"] != false
        || job.get("review").is_some_and(|r| !r.is_null())
        || job.get("publication").is_some_and(|p| !p.is_null())
        || job.get("pause").is_some_and(|p| !p.is_null())
        || job
            .get("plans")
            .and_then(Value::as_array)
            .is_some_and(|a| !a.is_empty())
    {
        return false;
    }
    let Some(tasks) = job["tasks"].as_array() else {
        return false;
    };
    !tasks.is_empty()
        && tasks.iter().all(|t| {
            t["state"] == "SUCCEEDED"
                && t.get("resolution").is_none_or(|r| r.is_null())
                && t.get("interactiveInvocation").is_none_or(|r| r.is_null())
        })
}
/// Returns true only if canonical Job Graph reaches COMPLETED. Review-enabled
/// and merge-enabled jobs must use their own legitimate production gates.
pub fn complete_no_review_job(
    authority: &mut RelayAuthority,
    job_id: &str,
) -> Result<bool, String> {
    let Some(snapshot) = authority.read_job(job_id)? else {
        return Err("Unknown Job".into());
    };
    if snapshot["state"] == "COMPLETED" {
        return Ok(false);
    }
    if !no_review_completion_ready(&snapshot) {
        return Ok(false);
    }
    let at = after_time(
        snapshot["updatedAt"]
            .as_str()
            .ok_or("Job timestamp missing")?,
    )?;
    let graph = Graph::parse(JOB_GRAPH)?;
    authority.commit_job(job_id,&at,|current|{
        if !no_review_completion_ready(current) {
            return Err("Job facts changed before completion".into());
        }
        let decision=graph.decide("ACTIVE",
            GraphInput{transport:"event".into(),id:"local.completed".into(),payload:json!({})},
            &HashMap::from([("localCompletionAllowed".to_owned(),true)]))?;
        if !matches!(decision,Decision::Accepted{ref target,ref actions,..} if target=="COMPLETED" && actions.is_empty()){
            return Err("canonical Job Graph denied local completion".into());
        }
        let mut next=current.clone();
        next["state"]=json!("COMPLETED");next["runtimeStatus"]=json!("COMPLETED");
        next["closedAt"]=json!(at);next["updatedAt"]=json!(at);
        Ok((next,vec![]))
    })?;
    Ok(true)
}
