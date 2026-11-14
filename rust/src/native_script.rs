//! Isolated native Script Worker adapter. It requires a canonical Task Graph
//! claim before launch; OS process lifecycle is delegated to `worker.rs`.
//! There is deliberately no production daemon/CLI entry point yet.
use crate::authority::{
    ActionOutcome, ExecutionProcessRecord, RelayAuthority, ScriptClaim, WorkflowEvent,
};
use crate::graph::{Graph, GraphInput};
use crate::lifecycle::{TaskLifecycle, TaskTransition};
use crate::worker::{run_worker, WorkerResult, WorkerSpec};
use chrono::DateTime;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::process::Command;
use std::sync::atomic::AtomicBool;

#[derive(Clone)]
pub struct ScriptExecutionTimes<'a> {
    pub started_at: &'a str,
    pub finished_at: &'a str,
    pub verified_at: &'a str,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeScriptResult {
    pub task_id: String,
    pub execution_id: String,
    pub task_state: String,
    pub verified: bool,
    pub reason: String,
    pub worker: WorkerResult,
}
pub(crate) fn task_input(
    task_id: &str,
    execution_id: &str,
    owner: &str,
    attempt: i64,
    event: &str,
) -> GraphInput {
    GraphInput {
        transport: "event".into(),
        id: event.into(),
        payload: json!({
        "taskId":task_id,"executionId":execution_id,"leaseOwner":owner,"attempt":attempt}),
    }
}
pub(crate) fn exact_process(
    pid: u32,
    claim: &ScriptClaim,
    at: &str,
) -> Result<ExecutionProcessRecord, String> {
    let output = Command::new("/bin/ps")
        .args(["-p", &pid.to_string(), "-o", "pgid=", "-o", "lstart="])
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err("cannot observe started native Worker process".into());
    }
    let text = String::from_utf8(output.stdout).map_err(|e| e.to_string())?;
    let text = text.trim();
    let split = text
        .find(char::is_whitespace)
        .ok_or("missing Worker start token")?;
    let pgid = text[..split].parse::<i64>().map_err(|e| e.to_string())?;
    if pgid != i64::from(pid) {
        return Err("Worker is not own process-group leader".into());
    }
    let start_token = text[split..].trim();
    if start_token.is_empty() {
        return Err("Worker start token missing".into());
    }
    let host = Command::new("/bin/hostname")
        .output()
        .map_err(|e| e.to_string())?;
    if !host.status.success() {
        return Err("cannot observe worker host identity".into());
    }
    let host = String::from_utf8(host.stdout)
        .map_err(|e| e.to_string())?
        .trim()
        .to_owned();
    if host.is_empty() {
        return Err("worker host identity empty".into());
    }
    Ok(ExecutionProcessRecord {
        job_id: claim.job_id.clone(),
        task_id: claim.task_id.clone(),
        execution_id: claim.execution_id.clone(),
        lease_owner: claim.owner.clone(),
        host,
        pid: i64::from(pid),
        pgid,
        start_token: start_token.into(),
        observed_at: at.into(),
        ended_at: None,
    })
}
pub(crate) fn read_evidence(path: &Path, claim: &ScriptClaim) -> Result<Value, String> {
    let value = crate::native_receipt::read_bounded_json(path, "Worker completion evidence")?;
    if value["jobId"] != claim.job_id
        || value["taskId"] != claim.task_id
        || value["executionId"] != claim.execution_id
        || value["status"] != "COMPLETED"
        || !value["output"].is_object()
    {
        return Err("Worker completion evidence does not match execution identity".into());
    }
    Ok(value)
}

/// Execute a *previously claimed* worker generation. This procedure never
/// changes an unclaimed Job and never infers success from exit code or stdout.
/// The caller is responsible for providing trusted WorkerSpec and timestamps;
/// adapter errors leave the durable lease for a guarded recovery pass.
pub fn execute_claimed_script(
    authority: &mut RelayAuthority,
    claim: &ScriptClaim,
    spec: &WorkerSpec,
    evidence: &Path,
    cancelled: &AtomicBool,
    at: ScriptExecutionTimes<'_>,
) -> Result<NativeScriptResult, String> {
    let start = DateTime::parse_from_rfc3339(at.started_at)
        .map_err(|_| "invalid Worker start timestamp")?;
    let finish = DateTime::parse_from_rfc3339(at.finished_at)
        .map_err(|_| "invalid Worker finish timestamp")?;
    let verified = DateTime::parse_from_rfc3339(at.verified_at)
        .map_err(|_| "invalid Worker verification timestamp")?;
    let expiry = DateTime::parse_from_rfc3339(&claim.lease_expires_at)
        .map_err(|_| "invalid Worker lease expiry")?;
    let claimed = DateTime::parse_from_rfc3339(&claim.claimed_at)
        .map_err(|_| "invalid Worker claim timestamp")?;
    if !(claimed < start && start < finish && finish < verified && verified < expiry) {
        return Err("Worker timing exceeds leased generation; recovery must reconcile".into());
    }
    if evidence.exists() {
        return Err("completion evidence exists before Worker launch".into());
    }
    let job = authority
        .read_job(&claim.job_id)?
        .ok_or("Script Job missing")?;
    let task = job["tasks"]
        .as_array()
        .ok_or("Script Job tasks missing")?
        .iter()
        .find(|task| task["id"] == claim.task_id)
        .ok_or("claimed Script Task missing")?;
    if job["state"] != "ACTIVE"
        || job.get("pause").is_some_and(|v| !v.is_null())
        || task["state"] != "QUEUED"
        || task["adapter"] != claim.adapter
        || (claim.adapter == "codex"
            && (task.get("routing") != claim.routing.as_ref()
                || task.get("workerSelection") != claim.worker_selection.as_ref()))
        || task["executionId"] != claim.execution_id
        || task["leaseOwner"] != claim.owner
        || task["attempt"] != claim.attempt
        || task["leaseExpiresAt"] != claim.lease_expires_at
    {
        return Err("stale or mismatched Script execution claim".into());
    }
    let trace = authority
        .action_trace(&claim.attempt_key)?
        .ok_or("missing durable launch Action")?;
    if trace.outcome != ActionOutcome::Unknown
        || trace.execution_id != claim.execution_id
        || trace.generation != claim.attempt
        || trace.action_id != "effect.launchTask"
    {
        return Err("Script launch Action is not a fresh Unknown generation".into());
    }
    let graph = Graph::parse(include_str!("../../workflow/task-lifecycle.mmd"))?;
    let lifecycle = TaskLifecycle::new(&graph);
    // Atomic second fence: a caller that merely copied ScriptClaim may not
    // launch the same generation twice, even before PID is registered.
    authority.begin_script_launch(claim, at.started_at)?;
    let worker = run_worker(spec, cancelled, |pid| {
        let record = exact_process(pid, claim, at.started_at)?;
        authority.record_process(&record)?;
        lifecycle.apply(
            authority,
            TaskTransition {
                job_id: &claim.job_id,
                task_id: &claim.task_id,
                input: task_input(
                    &claim.task_id,
                    &claim.execution_id,
                    &claim.owner,
                    claim.attempt,
                    "task.started",
                ),
                guard_facts: &HashMap::new(),
                at: at.started_at,
                events: vec![],
            },
        )?;
        Ok(())
    })?;
    finish_script_worker(
        authority,
        claim,
        &worker,
        evidence,
        at.finished_at,
        at.verified_at,
    )
}

/// Common terminal Task authority used by direct isolated-worker tests and
/// the parent-death-safe, helper-supervised daemon. A successful OS exit is
/// insufficient without a matching structured result for this generation.
pub(crate) fn finish_script_worker(
    authority: &mut RelayAuthority,
    claim: &ScriptClaim,
    worker: &WorkerResult,
    evidence: &Path,
    finished_at: &str,
    verified_at: &str,
) -> Result<NativeScriptResult, String> {
    authority.finish_process(
        &claim.job_id,
        &claim.task_id,
        &claim.execution_id,
        finished_at,
    )?;
    // Model completion comes from a correlated terminal task event, NOT from
    // Codex/subprocess exit code. The authoritative route is fenced in the
    // original claim; the current Task must still carry that same route.
    let current = authority
        .read_job(&claim.job_id)?
        .ok_or("Worker Job missing at terminal receipt")?;
    let task = current["tasks"]
        .as_array()
        .ok_or("Worker Task list missing")?
        .iter()
        .find(|task| task["id"] == claim.task_id)
        .ok_or("Worker Task missing at receipt")?;
    let route_valid = task["adapter"] == claim.adapter
        && (claim.adapter != "codex"
            || (task.get("routing") == claim.routing.as_ref()
                && task.get("workerSelection") == claim.worker_selection.as_ref()));
    let valid_result = if !route_valid {
        Err("Model route or Worker adapter changed after durable claim".into())
    } else if worker.exit_code == Some(0) && !worker.cancelled && !worker.timed_out {
        if claim.adapter == "codex" {
            crate::native_model::verified_model_receipt(evidence, claim)
        } else {
            read_evidence(evidence, claim)
        }
    } else {
        Err("Worker exit, cancellation or timeout did not prove completion".into())
    };
    let verified = valid_result.is_ok();
    let reason = match &valid_result {
        Ok(_) if claim.adapter == "codex" => "verified correlated Model terminal task event".into(),
        Ok(_) => "verified correlated Script output".into(),
        Err(reason) => reason.clone(),
    };
    let event = if verified {
        "task.completed"
    } else {
        "task.failed"
    };
    let key = format!(
        "{}/{}/{}/terminal",
        claim.job_id, claim.task_id, claim.execution_id
    );
    let receipt = WorkflowEvent {
        key: key.clone(),
        event_id: event.into(),
        payload: json!({
            "event_id":key,"type":event,"jobId":claim.job_id,
            "taskId":claim.task_id,"executionId":claim.execution_id,"reason":reason,
        }),
    };
    let result = valid_result.ok().map(|data| {
        let summary = if claim.adapter == "codex" {
            data["summary"].as_str().unwrap_or("Model task completed")
        } else {
            "Native Script verified"
        };
        json!({"summary":summary,
            "data":{"status":"COMPLETED","output":data["output"].clone()},
        })
    });
    let graph = Graph::parse(include_str!("../../workflow/task-lifecycle.mmd"))?;
    let lifecycle = TaskLifecycle::new(&graph);
    let (finished, _) = lifecycle.apply_with_launch_receipt(
        authority,
        TaskTransition {
            job_id: &claim.job_id,
            task_id: &claim.task_id,
            input: task_input(
                &claim.task_id,
                &claim.execution_id,
                &claim.owner,
                claim.attempt,
                event,
            ),
            guard_facts: &HashMap::new(),
            at: verified_at,
            events: vec![receipt],
        },
        result,
        claim,
    )?;
    let new_state = finished.job["tasks"]
        .as_array()
        .ok_or("Worker result tasks missing")?
        .iter()
        .find(|t| t["id"] == claim.task_id)
        .ok_or("Worker result Task missing")?["state"]
        .as_str()
        .ok_or("Worker new state missing")?
        .to_owned();
    Ok(NativeScriptResult {
        task_id: claim.task_id.clone(),
        execution_id: claim.execution_id.clone(),
        task_state: new_state,
        verified,
        reason,
        worker: worker.clone(),
    })
}
