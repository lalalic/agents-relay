//! Fail-closed recovery *inspection* for existing Relay generations. No worker
//! may be restarted, cancelled or failed based on an event alone. A real
//! process probe, current Job generation and canonical Task Graph are required.
use crate::authority::ProcessProbe;
use crate::graph::{ActionDecision, Decision, Graph, GraphInput};
use chrono::DateTime;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryAssessment {
    pub job_id: String,
    pub task_id: String,
    pub execution_id: String,
    pub lease_owner: String,
    pub lease_expires_at: String,
    pub status: String,
    pub reason: String,
    pub target: Option<String>,
    pub actions: Vec<ActionDecision>,
}

/// `current_owner_active` is a durable runtime fact from the daemon, not a
/// guess based on the lease string. An active different Relay owner blocks
/// startup recovery even if the local child process seems absent.
pub fn inspect_expired_execution(
    job: &Value,
    task_id: &str,
    now: &str,
    process: ProcessProbe,
    current_owner_active: bool,
) -> Result<Option<RecoveryAssessment>, String> {
    let observed = DateTime::parse_from_rfc3339(now).map_err(|_| "invalid Recovery timestamp")?;
    let tasks = job
        .get("tasks")
        .and_then(Value::as_array)
        .ok_or("Job tasks missing")?;
    let task = tasks
        .iter()
        .find(|task| task.get("id").and_then(Value::as_str) == Some(task_id))
        .ok_or("Recovery Task missing")?;
    if task.get("kind").and_then(Value::as_str) == Some("planner") {
        return Ok(None);
    }
    let state = task
        .get("state")
        .and_then(Value::as_str)
        .ok_or("Recovery state missing")?;
    let execution_id = task.get("executionId").and_then(Value::as_str);
    if state != "RUNNING" && !(state == "QUEUED" && execution_id.is_some()) {
        return Ok(None);
    }
    let expiry = task.get("leaseExpiresAt").and_then(Value::as_str);
    let Some(expiry) = expiry else {
        return Ok(None);
    };
    let expiration =
        DateTime::parse_from_rfc3339(expiry).map_err(|_| "invalid Task lease expiry")?;
    if expiration > observed {
        return Ok(None);
    }
    let execution = execution_id.ok_or("expired running Task missing execution ID")?;
    let owner = task
        .get("leaseOwner")
        .and_then(Value::as_str)
        .ok_or("expired Task owner missing")?;
    let job_id = job
        .get("id")
        .and_then(Value::as_str)
        .ok_or("Job ID missing")?;
    let mut assessment = RecoveryAssessment {
        job_id: job_id.into(),
        task_id: task_id.into(),
        execution_id: execution.into(),
        lease_owner: owner.into(),
        lease_expires_at: expiry.into(),
        status: "blocked".into(),
        reason: String::new(),
        target: None,
        actions: vec![],
    };
    if current_owner_active {
        assessment.reason = "another live Relay owns the execution".into();
        return Ok(Some(assessment));
    }
    match process {
        ProcessProbe::Alive => {
            assessment.reason = "matching OS process generation still alive".into();
            return Ok(Some(assessment));
        }
        ProcessProbe::Unknown => {
            assessment.reason = "OS process generation cannot be verified".into();
            return Ok(Some(assessment));
        }
        ProcessProbe::Untracked => {
            assessment.reason =
                "no durable process identity: a launched worker cannot be excluded".into();
            return Ok(Some(assessment));
        }
        ProcessProbe::Gone | ProcessProbe::Reused => {}
    }
    let graph = Graph::parse(include_str!("../../workflow/task-lifecycle.mmd"))?;
    let attempt = task
        .get("attempt")
        .and_then(Value::as_i64)
        .ok_or("Task attempt missing")?;
    let budget = task
        .get("maxAttempts")
        .and_then(Value::as_i64)
        .ok_or("Task retry budget missing")?;
    let facts = HashMap::from([("retryAvailable".to_string(), attempt < budget)]);
    let decision = graph.decide(
        state,
        GraphInput {
            transport: "event".into(),
            id: "lease.expired".into(),
            payload: json!({}),
        },
        &facts,
    )?;
    let Decision::Accepted {
        target, actions, ..
    } = decision
    else {
        return Err("Task Graph refused expired-lease recovery".into());
    };
    assessment.status = "eligible".into();
    assessment.reason =
        "execution outcome unknown; Graph-selected failure requires reconciliation".into();
    assessment.target = Some(target);
    assessment.actions = actions;
    Ok(Some(assessment))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn job() -> Value {
        json!({"id":"91","state":"ACTIVE","tasks":[
            {"id":"101","state":"RUNNING","kind":"work","executionId":"ex1","leaseOwner":"relayd-1",
             "leaseExpiresAt":"2026-11-13T20:00:00.000Z","attempt":1,"maxAttempts":3}
        ]})
    }
    #[test]
    fn never_confuses_unknown_or_alive_process_with_safe_recovery() {
        let observed = "2026-11-13T20:00:01.000Z";
        let original = job();
        assert!(
            inspect_expired_execution(&original, "101", observed, ProcessProbe::Alive, false)
                .unwrap()
                .is_some_and(|result| result.status == "blocked")
        );
        assert!(inspect_expired_execution(
            &original,
            "101",
            observed,
            ProcessProbe::Unknown,
            false
        )
        .unwrap()
        .is_some_and(|result| result.status == "blocked"));
        assert!(
            inspect_expired_execution(&original, "101", observed, ProcessProbe::Gone, true)
                .unwrap()
                .is_some_and(|result| result.status == "blocked")
        );
        let ready =
            inspect_expired_execution(&original, "101", observed, ProcessProbe::Gone, false)
                .unwrap()
                .unwrap();
        assert_eq!(ready.status, "eligible");
        assert_eq!(ready.target, Some("FAILED".into()));
        assert!(ready
            .actions
            .iter()
            .any(|a| a.id == "mutation.markUnknownOutcome"));
        assert!(ready.actions.iter().any(|a| a.id == "mutation.clearLease"));
        assert!(ready
            .actions
            .iter()
            .any(|a| a.id == "mutation.clearExecution"));
        let pending = inspect_expired_execution(
            &original,
            "101",
            "2026-11-13T19:00:00Z",
            ProcessProbe::Gone,
            false,
        )
        .unwrap();
        assert!(pending.is_none(), "unexpired execution cannot be reaped");
    }
    #[test]
    fn queued_claim_and_stale_terminal_are_classified_without_reexecution() {
        let mut value = job();
        value["tasks"][0]["state"] = json!("QUEUED");
        let result = inspect_expired_execution(
            &value,
            "101",
            "2026-11-13T20:00:01Z",
            ProcessProbe::Untracked,
            false,
        )
        .unwrap()
        .unwrap();
        assert_eq!(result.status, "blocked");
        assert_eq!(result.target, None);
        value["tasks"][0]["state"] = json!("SUCCEEDED");
        assert!(inspect_expired_execution(
            &value,
            "101",
            "2026-11-13T20:00:01Z",
            ProcessProbe::Untracked,
            false
        )
        .unwrap()
        .is_none());
    }
}
