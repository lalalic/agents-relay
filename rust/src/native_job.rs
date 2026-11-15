//! Native pilot intake and Graph-governed Job transitions. One SQLite Job
//! store; no alternative scheduler or invented Final Review/merge receipts.
use crate::agent_graph::AgentGraph;
use crate::authority::{NativeJobSpec, RelayAuthority};
use crate::graph::{Decision, Graph, GraphInput};
use crate::native_daemon::isolated_store_root;
use crate::supervised_script::after_time;
use rusqlite::{Connection, OptionalExtension, Transaction};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

const JOB_GRAPH: &str = include_str!("../../workflow/job-lifecycle.mmd");

fn root_before_create(db: &Path) -> Result<PathBuf, String> {
    if std::env::var("RELAY_RUST_LIVE_MODE").ok().as_deref() == Some("pilot-live") {
        let root = crate::native_daemon::live_store_root(db)?;
        if db.exists() || db.symlink_metadata().is_ok() {
            return Err("native Job init refuses existing database or symlink".into());
        }
        return Ok(root);
    }
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
        CREATE TABLE relay_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE agent_snapshot(agent_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL);")
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
    pub project_path: Option<&'a str>,
    pub graph_file: &'a Path,
    pub input_file: &'a Path,
    pub output_file: &'a Path,
    pub title: &'a str,
    pub priority: &'a str,
    pub repository: &'a str,
    pub request_key: &'a str,
    pub id: Option<&'a str>,
    pub graph: Option<&'a str>,
    pub input: Option<&'a str>,
    pub workspace_root: Option<&'a Path>,
    pub shared_root: Option<&'a Path>,
    pub github_repo: Option<&'a str>,
    pub tag: Option<&'a Value>,
    pub creator_thread_id: Option<&'a str>,
    pub reviewer_thread_id: Option<&'a str>,
    pub implementation_thread_id: Option<&'a str>,
    pub continuation: Option<&'a Value>,
    pub no_github: bool,
    pub review_enabled: bool,
    pub auto_merge: bool,
}
pub fn create_dag_job(request: DagJobRequest<'_>) -> Result<Value, String> {
    let DagJobRequest {
        db,
        project,
        project_path,
        graph_file,
        input_file,
        output_file,
        title,
        priority,
        repository,
        request_key,
        id,
        graph: inline_graph,
        input: inline_input,
        workspace_root,
        shared_root,
        github_repo,
        tag,
        creator_thread_id,
        reviewer_thread_id,
        implementation_thread_id,
        continuation,
        no_github,
        review_enabled,
        auto_merge,
    } = request;
    let root = isolated_store_root(db)?;
    let project = project.canonicalize().map_err(|e| e.to_string())?;
    if !project.starts_with(&root) || !project.is_dir() {
        return Err("native project outside isolated root".into());
    }
    if let Some(relative) = project_path {
        let candidate = project
            .join(relative)
            .canonicalize()
            .map_err(|e| e.to_string())?;
        if !candidate.starts_with(&project) {
            return Err("--project-path must resolve inside --coordinator-project-root".into());
        }
    }
    let graph = match inline_graph {
        Some(value) => value.to_owned(),
        None => fs::read_to_string(bounded_file(&root, graph_file)?).map_err(|e| e.to_string())?,
    };
    let parsed = AgentGraph::parse(&graph)?;
    if parsed.nodes.is_empty() {
        return Err("empty Coordinator graph".into());
    }
    let input = match inline_input {
        Some(value) => value.to_owned(),
        None => fs::read_to_string(bounded_file(&root, input_file)?).map_err(|e| e.to_string())?,
    };
    let workspace = workspace_root
        .map(|p| canonical_root(&root, p))
        .transpose()?;
    let shared = shared_root.map(|p| canonical_root(&root, p)).transpose()?;
    let workspace_string = workspace.as_ref().map(|p| p.to_string_lossy().into_owned());
    let shared_string = shared.as_ref().map(|p| p.to_string_lossy().into_owned());
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
        id,
        title,
        priority,
        project_root: &project.to_string_lossy(),
        project_path,
        input: &input,
        graph: &graph,
        output_path: &output.to_string_lossy(),
        request_key,
        workspace_root: workspace_string.as_deref(),
        shared_root: shared_string.as_deref(),
        github_repo,
        tag,
        creator_thread_id,
        reviewer_thread_id,
        implementation_thread_id,
        continuation,
        no_github,
        review_enabled,
        auto_merge,
        at: &now,
    })?;
    Ok(
        json!({"jobId":created.job_id,"coordinatorTaskId":created.coordinator_task_id,
        "created":created.created,"state":"DRAFT"}),
    )
}
fn canonical_root(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let path = path.canonicalize().map_err(|e| e.to_string())?;
    if !path.starts_with(root) || !path.is_dir() {
        return Err(
            "native Coordinator context root must be a directory inside isolated root".into(),
        );
    }
    Ok(path)
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

/// Cancel a dependency-gated Task before any Worker lease exists. This is a
/// deliberately narrow native CLI slice: running execution cancellation still
/// requires the production owned-process effect and remains unsupported here.
pub fn cancel_queued_task(
    authority: &mut RelayAuthority,
    job_id: &str,
    task_id: &str,
    reason: &str,
) -> Result<Value, String> {
    if reason.trim().is_empty() || reason.len() > 2048 {
        return Err("cancellation reason must be nonempty and at most 2048 bytes".into());
    }
    let snapshot = authority.read_job(job_id)?.ok_or("Unknown Job")?;
    let at = after_time(
        snapshot["updatedAt"]
            .as_str()
            .ok_or("Job timestamp missing")?,
    )?;
    let graph = Graph::parse(include_str!("../../workflow/task-lifecycle.mmd"))?;
    let transitioned = authority.commit_job(job_id, &at, |current| {
        if current["state"] != "ACTIVE"
            || current.get("pause").is_some_and(|value| !value.is_null())
        {
            return Err("native Task cancellation requires an active, unpaused Job".into());
        }
        let mut next = current.clone();
        let task = next["tasks"]
            .as_array_mut()
            .and_then(|tasks| tasks.iter_mut().find(|task| task["id"] == task_id))
            .ok_or("Unknown Task")?;
        if task["kind"] == "planner"
            || task.get("agentGraph").is_some()
            || task.get("dagNode").is_some()
        {
            return Err("native Task cancellation does not support Planner or DAG Tasks".into());
        }
        if !matches!(task["state"].as_str(), Some("DRAFT" | "QUEUED"))
            || task
                .get("executionId")
                .is_some_and(|value| !value.is_null())
            || task.get("leaseOwner").is_some_and(|value| !value.is_null())
            || task
                .get("leaseExpiresAt")
                .is_some_and(|value| !value.is_null())
        {
            return Err(
                "native Task cancellation requires an unleased DRAFT or QUEUED Task".into(),
            );
        }
        let state = task["state"].as_str().ok_or("Task state missing")?;
        let decision = graph.decide(
            state,
            GraphInput {
                transport: "event".into(),
                id: "cancel".into(),
                payload: json!({}),
            },
            &HashMap::new(),
        )?;
        let Decision::Accepted { target, .. } = decision else {
            return Err("canonical Task Graph denied cancellation".into());
        };
        if target != "CANCELLED" {
            return Err("canonical Task Graph selected an unexpected cancellation state".into());
        }
        task["state"] = json!(target);
        task["error"] = json!(reason);
        task["leaseOwner"] = Value::Null;
        task["leaseExpiresAt"] = Value::Null;
        task["executionId"] = Value::Null;
        task["updatedAt"] = json!(at);
        next["updatedAt"] = json!(at);
        Ok((next, vec![]))
    })?;
    let task = transitioned.job["tasks"]
        .as_array()
        .and_then(|tasks| tasks.iter().find(|task| task["id"] == task_id))
        .ok_or("Cancelled Task missing from committed Job")?;
    Ok(json!({"jobId":job_id,"taskId":task_id,"task":task}))
}

/// Requeue a failed, inactive ordinary Task through the canonical lifecycle
/// Graph. Recovery-owned, Planner, DAG, and currently leased work is excluded.
pub fn retry_failed_task(
    authority: &mut RelayAuthority,
    job_id: &str,
    task_id: &str,
) -> Result<Value, String> {
    let snapshot = authority.read_job(job_id)?.ok_or("Unknown Job")?;
    let at = after_time(
        snapshot["updatedAt"]
            .as_str()
            .ok_or("Job timestamp missing")?,
    )?;
    let graph = Graph::parse(include_str!("../../workflow/task-lifecycle.mmd"))?;
    let transitioned = authority.commit_job(job_id, &at, |current| {
        if current["state"] != "ACTIVE"
            || current.get("pause").is_some_and(|value| !value.is_null())
        {
            return Err("native Task retry requires an active, unpaused Job".into());
        }
        let mut next = current.clone();
        let task = next["tasks"]
            .as_array_mut()
            .and_then(|tasks| tasks.iter_mut().find(|task| task["id"] == task_id))
            .ok_or("Unknown Task")?;
        if task["kind"] == "planner"
            || task.get("agentGraph").is_some()
            || task.get("dagNode").is_some()
        {
            return Err("native Task retry does not support Planner or DAG Tasks".into());
        }
        if task["state"] != "FAILED"
            || task.get("resolution").is_some_and(|value| !value.is_null())
            || task.get("escalation").is_some_and(|value| !value.is_null())
            || task
                .get("executionId")
                .is_some_and(|value| !value.is_null())
            || task.get("leaseOwner").is_some_and(|value| !value.is_null())
            || task
                .get("leaseExpiresAt")
                .is_some_and(|value| !value.is_null())
        {
            return Err(
                "native Task retry requires an inactive FAILED Task without recovery ownership"
                    .into(),
            );
        }
        let decision = graph.decide(
            "FAILED",
            GraphInput {
                transport: "event".into(),
                id: "retry".into(),
                payload: json!({}),
            },
            &HashMap::new(),
        )?;
        let Decision::Accepted {
            target, actions, ..
        } = decision
        else {
            return Err("canonical Task Graph denied retry".into());
        };
        if target != "QUEUED" {
            return Err("canonical Task Graph selected an unexpected retry state".into());
        }
        task["state"] = json!(target);
        task["error"] = Value::Null;
        task.as_object_mut()
            .ok_or("Task snapshot must be an object")?
            .shift_remove("failureReason");
        let attempt = task["attempt"].as_i64().ok_or("Task attempt missing")?;
        let max_attempts = task["maxAttempts"]
            .as_i64()
            .ok_or("Task maxAttempts missing")?;
        let used_or_budgeted = max_attempts.max(attempt);
        task["maxAttempts"] = json!(3.max((used_or_budgeted / 3 + 1) * 3));
        task.as_object_mut()
            .ok_or("Task snapshot must be an object")?
            .remove("routing");
        task.as_object_mut()
            .ok_or("Task snapshot must be an object")?
            .remove("workerSelection");
        task["leaseOwner"] = Value::Null;
        task["leaseExpiresAt"] = Value::Null;
        task["executionId"] = Value::Null;
        task["updatedAt"] = json!(at);
        super::lifecycle::apply_pure_task_actions(task, &actions)?;
        next["updatedAt"] = json!(at);
        Ok((next, vec![]))
    })?;
    let task = transitioned.job["tasks"]
        .as_array()
        .and_then(|tasks| tasks.iter().find(|task| task["id"] == task_id))
        .ok_or("Retried Task missing from committed Job")?;
    Ok(json!({"jobId":job_id,"taskId":task_id,"task":task}))
}

fn no_review_completion_ready(job: &Value) -> bool {
    // These are deliberately conservative *facts*. JOB_GRAPH decides the
    // transition. Never infer approval from a worker's exit status.
    if job["state"] != "ACTIVE"
        || job["reviewEnabled"] != false
        // The canonical Job Graph's `localCompletionAllowed` guard is fed by
        // `autoMergeEnabled` (default true), for review and no-review Jobs.
        || job["autoMerge"] == false
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

fn reviewed_local_completion_ready(job: &Value) -> bool {
    if job["state"] != "ACTIVE"
        || job["reviewEnabled"] == false
        // Match the canonical Node `autoMergeEnabled` fact: omitted/null means
        // enabled, and only an explicit false disables local completion.
        || job["autoMerge"] == false
        || job.get("prNumber").and_then(Value::as_i64).unwrap_or(0) != 0
        || job.get("localMerge").is_some_and(|value| !value.is_null())
        || job["tasks"].as_array().is_some_and(|tasks| {
            tasks.iter().any(|task| {
                task["kind"] != "planner"
                    && !matches!(
                        task["agentName"].as_str(),
                        Some("job-acceptance-reviewer" | "reviewer" | "troubleshooter")
                    )
                    && task["output"]["kind"] == "task_pr"
            })
        })
        || job.get("publication").is_some_and(|value| !value.is_null())
        || job.get("pause").is_some_and(|value| !value.is_null())
    {
        return false;
    }
    let Some(head) = job["headSha"].as_str().filter(|head| valid_job_sha(head)) else {
        return false;
    };
    let review = &job["review"];
    if review["outcome"] != "approved"
        || review["headSha"].as_str() != Some(head)
        || review["taskId"].as_str().is_none()
    {
        return false;
    }
    let evidence = &review["evidence"]["data"];
    let evidence_head = evidence["head_sha"]
        .as_str()
        .or_else(|| evidence["headSha"].as_str());
    if !matches!(evidence["verdict"].as_str(), Some("approved" | "pass"))
        || evidence_head != Some(head)
        || evidence["findings"]
            .as_array()
            .is_none_or(|findings| !findings.is_empty())
    {
        return false;
    }
    if let Some(plans_value) = job.get("plans").filter(|value| !value.is_null()) {
        let Some(plans) = plans_value.as_array() else {
            return false;
        };
        if plans.iter().any(|plan| plan["status"] != "SUCCEEDED") {
            return false;
        }
    }
    let Some(tasks) = job.get("tasks").and_then(Value::as_array) else {
        return false;
    };
    let current_review_id = review["taskId"].as_str().unwrap_or_default();
    if !tasks.iter().any(|task| {
        task["id"] == current_review_id
            && matches!(
                task["agentName"].as_str(),
                Some("job-acceptance-reviewer" | "reviewer")
            )
            && task["state"] == "SUCCEEDED"
            && task["reviewHeadSha"].as_str() == Some(head)
    }) {
        return false;
    }
    let mut implementation_seen = false;
    for task in tasks {
        let is_reviewer = matches!(
            task["agentName"].as_str(),
            Some("job-acceptance-reviewer" | "reviewer")
        );
        if is_reviewer {
            if task["id"] == current_review_id {
                if task["state"] != "SUCCEEDED" || task["reviewHeadSha"].as_str() != Some(head) {
                    return false;
                }
            } else if !matches!(
                task["state"].as_str(),
                Some("SUCCEEDED" | "FAILED" | "CANCELLED")
            ) {
                return false;
            }
            continue;
        }
        if task["state"] != "SUCCEEDED"
            || task.get("resolution").is_some_and(|value| !value.is_null())
            || task.get("escalation").is_some_and(|value| !value.is_null())
        {
            return false;
        }
        if let Some(invocation) = task
            .get("interactiveInvocation")
            .filter(|invocation| !invocation.is_null())
        {
            if invocation["status"] != "approved" {
                return false;
            }
        }
        if task["kind"] != "planner" && task["agentName"] != "troubleshooter" {
            implementation_seen = true;
        }
    }
    implementation_seen
}

fn host_approvals_are_durable(
    tx: &Transaction<'_>,
    job_id: &str,
    job: &Value,
) -> Result<bool, String> {
    for task in job["tasks"].as_array().ok_or("Job Tasks missing")? {
        let Some(invocation) = task
            .get("interactiveInvocation")
            .filter(|invocation| !invocation.is_null())
        else {
            continue;
        };
        let task_id = task["id"].as_str().ok_or("interactive Task ID missing")?;
        let invocation_id = invocation["invocationId"]
            .as_str()
            .ok_or("interactive invocation ID missing")?;
        let execution_id = invocation["executionId"]
            .as_str()
            .ok_or("interactive execution ID missing")?;
        let revision = invocation["revision"]
            .as_str()
            .ok_or("interactive revision missing")?;
        let decision: Option<i64> = tx
            .query_row(
                "SELECT 1 FROM host_invocation_decision WHERE job_id=?1 AND task_id=?2 AND invocation_id=?3 AND execution_id=?4 AND revision=?5 AND decision='approved'",
                rusqlite::params![job_id, task_id, invocation_id, execution_id, revision],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("host Review approval ledger unavailable: {error}"))?;
        if decision != Some(1) {
            return Ok(false);
        }
    }
    Ok(true)
}

fn valid_job_sha(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

/// Graph-gated local completion after current-head Review approval. This is
/// available only to a local-only Job with successful settled implementation
/// and Plan evidence; an approval event or reviewer Task alone cannot finish it.
pub fn complete_approved_local_job(
    authority: &mut RelayAuthority,
    job_id: &str,
) -> Result<bool, String> {
    let Some(snapshot) = authority.read_job(job_id)? else {
        return Err("Unknown Job".into());
    };
    if !reviewed_local_completion_ready(&snapshot) {
        return Ok(false);
    }
    let at = after_time(
        snapshot["updatedAt"]
            .as_str()
            .ok_or("Job timestamp missing")?,
    )?;
    let graph = Graph::parse(JOB_GRAPH)?;
    authority.commit_job_with_tx(job_id, &at, |tx, current| {
        if !reviewed_local_completion_ready(current) {
            return Err("local Review completion facts changed before commit".into());
        }
        if !host_approvals_are_durable(tx, job_id, current)? {
            return Err("interactive Review approval lacks a durable accepted decision".into());
        }
        let decision = graph.decide(
            "ACTIVE",
            GraphInput {
                transport: "event".into(),
                id: "local.completed".into(),
                payload: json!({}),
            },
            &HashMap::from([("localCompletionAllowed".to_owned(), true)]),
        )?;
        if !matches!(decision, Decision::Accepted { ref target, ref actions, .. }
            if target == "COMPLETED" && actions.is_empty())
        {
            return Err("canonical Job Graph denied reviewed local completion".into());
        }
        let mut next = current.clone();
        next["state"] = json!("COMPLETED");
        next["runtimeStatus"] = json!("COMPLETED");
        next["closedAt"] = json!(at);
        next["updatedAt"] = json!(at);
        Ok((next, vec![]))
    })?;
    Ok(true)
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

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use tempfile::tempdir;

    const AT: &str = "2026-11-15T11:00:00.000Z";
    const HEAD: &str = "0123456789abcdef0123456789abcdef01234567";

    fn approved_local_job() -> Value {
        json!({
            "id":"91","repository":"example","state":"ACTIVE","updatedAt":AT,
            "runtimeStatus":"RUNNING","prNumber":0,"reviewEnabled":true,"autoMerge":true,
            "headSha":HEAD,"plans":[],"review":{"outcome":"approved","headSha":HEAD,
                "taskId":"review-1","updatedAt":AT,
                "evidence":{"data":{"verdict":"approved","head_sha":HEAD,"findings":[]}}},
            "tasks":[
                {"id":"work-1","kind":"work","agentName":"implementation","state":"SUCCEEDED",
                    "resolution":null,"escalation":null},
                {"id":"review-1","kind":"work","agentName":"job-acceptance-reviewer","state":"SUCCEEDED",
                    "reviewHeadSha":HEAD}
            ]
        })
    }

    fn open_authority(job: Value) -> (tempfile::TempDir, RelayAuthority) {
        let dir = tempdir().unwrap();
        let path = dir.path().join("relay.sqlite");
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch("CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL);
            CREATE TABLE host_invocation_decision(job_id TEXT NOT NULL,task_id TEXT NOT NULL,invocation_id TEXT NOT NULL,
                execution_id TEXT NOT NULL,revision TEXT NOT NULL,decision TEXT NOT NULL);").unwrap();
        connection
            .execute(
                "INSERT INTO job_snapshot(job_id,json,updated_at) VALUES('91',?1,?2)",
                rusqlite::params![job.to_string(), AT],
            )
            .unwrap();
        drop(connection);
        (dir, RelayAuthority::open_existing(&path).unwrap())
    }

    #[test]
    fn approved_local_job_completes_only_through_job_graph_after_settled_work() {
        let (dir, mut authority) = open_authority(approved_local_job());
        assert!(complete_approved_local_job(&mut authority, "91").unwrap());
        let job = authority.read_job("91").unwrap().unwrap();
        assert_eq!(job["state"], "COMPLETED");
        assert_eq!(job["runtimeStatus"], "COMPLETED");
        drop(authority);
        let reopened = RelayAuthority::open_existing(&dir.path().join("relay.sqlite")).unwrap();
        assert_eq!(
            reopened.read_job("91").unwrap().unwrap()["state"],
            "COMPLETED"
        );
    }

    #[test]
    fn approved_local_job_with_no_plans_field_is_treated_as_plan_free() {
        let mut job = approved_local_job();
        job.as_object_mut().unwrap().remove("plans");
        let (_dir, mut authority) = open_authority(job);
        assert!(complete_approved_local_job(&mut authority, "91").unwrap());
        assert_eq!(
            authority.read_job("91").unwrap().unwrap()["state"],
            "COMPLETED"
        );
    }

    #[test]
    fn reviewed_local_completion_matches_auto_merge_graph_guard() {
        let mut disabled = approved_local_job();
        disabled["autoMerge"] = json!(false);
        let (_dir, mut authority) = open_authority(disabled);
        assert!(!complete_approved_local_job(&mut authority, "91").unwrap());

        let mut default_enabled = approved_local_job();
        default_enabled.as_object_mut().unwrap().remove("autoMerge");
        let (_dir, mut authority) = open_authority(default_enabled);
        assert!(complete_approved_local_job(&mut authority, "91").unwrap());
    }

    #[test]
    fn no_review_local_completion_matches_auto_merge_graph_guard() {
        let mut job = json!({
            "id":"91","repository":"example","state":"ACTIVE","updatedAt":AT,
            "runtimeStatus":"RUNNING","prNumber":0,"reviewEnabled":false,"autoMerge":true,
            "tasks":[{"id":"work-1","kind":"work","agentName":"implementation","state":"SUCCEEDED",
                "resolution":null,"interactiveInvocation":null}]
        });
        let (_dir, mut authority) = open_authority(job.clone());
        assert!(complete_no_review_job(&mut authority, "91").unwrap());

        job["autoMerge"] = json!(false);
        let (_dir, mut authority) = open_authority(job);
        assert!(!complete_no_review_job(&mut authority, "91").unwrap());
    }

    #[test]
    fn approval_alone_cannot_complete_stale_pr_or_unsettled_local_job() {
        let mut approval_only = approved_local_job();
        approval_only["tasks"][0]["state"] = json!("FAILED");
        let (_dir, mut authority) = open_authority(approval_only);
        assert!(!complete_approved_local_job(&mut authority, "91").unwrap());
        assert_eq!(
            authority.read_job("91").unwrap().unwrap()["state"],
            "ACTIVE"
        );

        let mut stale = approved_local_job();
        stale["headSha"] = json!("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        let (_dir, mut authority) = open_authority(stale);
        assert!(!complete_approved_local_job(&mut authority, "91").unwrap());

        let mut pr = approved_local_job();
        pr["prNumber"] = json!(42);
        let (_dir, mut authority) = open_authority(pr);
        assert!(!complete_approved_local_job(&mut authority, "91").unwrap());

        let mut needs_local_merge = approved_local_job();
        needs_local_merge["tasks"][0]["output"] = json!({"kind":"task_pr"});
        let (_dir, mut authority) = open_authority(needs_local_merge);
        assert!(!complete_approved_local_job(&mut authority, "91").unwrap());

        let mut planning = approved_local_job();
        planning["plans"] = json!([{"status":"PLANNING"}]);
        let (_dir, mut authority) = open_authority(planning);
        assert!(!complete_approved_local_job(&mut authority, "91").unwrap());

        let mut forged_binding = approved_local_job();
        forged_binding["review"]["taskId"] = json!("work-1");
        let (_dir, mut authority) = open_authority(forged_binding);
        assert!(!complete_approved_local_job(&mut authority, "91").unwrap());
    }

    #[test]
    fn local_completion_requires_exact_durable_host_approval_when_interactive_task_exists() {
        let mut job = approved_local_job();
        job["tasks"][0]["interactiveInvocation"] = json!({
            "status":"approved","invocationId":"inv-1","executionId":"exec-1","revision":"rev-2"
        });
        let (dir, mut authority) = open_authority(job);
        assert!(complete_approved_local_job(&mut authority, "91")
            .unwrap_err()
            .contains("lacks a durable accepted decision"));
        drop(authority);
        let connection = Connection::open(dir.path().join("relay.sqlite")).unwrap();
        connection.execute(
            "INSERT INTO host_invocation_decision(job_id,task_id,invocation_id,execution_id,revision,decision) VALUES('91','work-1','inv-1','exec-1','rev-2','approved')",
            [],
        ).unwrap();
        drop(connection);
        let mut reopened = RelayAuthority::open_existing(&dir.path().join("relay.sqlite")).unwrap();
        assert!(complete_approved_local_job(&mut reopened, "91").unwrap());
        assert_eq!(
            reopened.read_job("91").unwrap().unwrap()["state"],
            "COMPLETED"
        );
    }
}
