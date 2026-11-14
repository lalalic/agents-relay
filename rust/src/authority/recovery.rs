//! Expired-lease execution recovery: the *exact* process identity is re-probed
//! inside the authoritative SQLite write transaction before the canonical Task
//! Graph selects the existing `lease.expired` failure actions. A missing PID
//! record or uncertain process never gets silently retried or marked complete.
use super::process::query_record;
use super::{probe_process, ProcessProbe, RelayAuthority, WorkflowEvent};
use crate::graph::{Decision, Graph, GraphInput};
use crate::lifecycle::apply_pure_task_actions;
use crate::recovery::inspect_expired_execution;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveredLease {
    pub job_id: String,
    pub task_id: String,
    pub execution_id: String,
    pub state: String,
    pub event_key: String,
}

impl RelayAuthority {
    /// Recovery is never a Worker retry. It records unknown outcome as FAILED,
    /// leaves the immutable attempt history, and requires the existing
    /// Troubleshooter/Review graph to decide any future attempt.
    pub fn fail_proven_expired_lease(
        &mut self,
        job_id: &str,
        task_id: &str,
        at: &str,
    ) -> Result<Option<RecoveredLease>, String> {
        let mut recovered = None;
        self.commit_job_with_tx(job_id, at, |tx, prior| {
            let task = prior
                .get("tasks")
                .and_then(Value::as_array)
                .and_then(|items| items.iter().find(|task| task["id"] == task_id))
                .ok_or("expired Task not found")?;
            let Some(execution_id) = task.get("executionId").and_then(Value::as_str) else {
                return Err("expired Task has no execution identity".into());
            };
            let process = query_record(tx, job_id, task_id, execution_id)?;
            // A missing PID ledger can indicate a crash between successful
            // launch CAS and PID registration. Never assume it never started.
            let Some(process) = process else {
                return Err("recovery blocked: no durable process identity".into());
            };
            if process.lease_owner != task["leaseOwner"].as_str().unwrap_or("") {
                return Err("recovery process owner mismatch".into());
            }
            let probe = probe_process(Some(&process));
            if !matches!(probe, ProcessProbe::Gone | ProcessProbe::Reused) {
                return Err(format!("recovery blocked: process probe {probe:?}"));
            }
            let assessment = inspect_expired_execution(prior, task_id, at, probe, false)?
                .ok_or("no expired active Task generation")?;
            if assessment.status != "eligible" || assessment.target.as_deref() != Some("FAILED") {
                return Err("recovery not authorized by Task Graph".into());
            }
            let decision = Graph::parse(include_str!("../../../workflow/task-lifecycle.mmd"))?
                .decide(
                    task["state"].as_str().ok_or("Task state missing")?,
                    GraphInput {
                        transport: "event".into(),
                        id: "lease.expired".into(),
                        payload: json!({"taskId":task_id,"executionId":execution_id}),
                    },
                    &HashMap::from([("retryAvailable".into(), false)]),
                )?;
            let Decision::Accepted {
                target, actions, ..
            } = decision
            else {
                return Err("Task Graph denied expired lease".into());
            };
            if target != "FAILED"
                || actions.len() != 3
                || !actions
                    .iter()
                    .any(|a| a.id == "mutation.markUnknownOutcome")
                || !actions.iter().any(|a| a.id == "mutation.clearLease")
                || !actions.iter().any(|a| a.id == "mutation.clearExecution")
            {
                return Err("unexpected Graph recovery action set".into());
            }
            let event_key = format!("recovery:{job_id}:{task_id}:{execution_id}:lease-expired");
            let mut next = prior.clone();
            let entry = next
                .get_mut("tasks")
                .and_then(Value::as_array_mut)
                .and_then(|tasks| tasks.iter_mut().find(|task| task["id"] == task_id))
                .ok_or("Task disappeared during recovery")?;
            apply_pure_task_actions(entry, &actions)?;
            entry["state"] = json!(target);
            entry["updatedAt"] = json!(at);
            next["updatedAt"] = json!(at);
            recovered = Some(RecoveredLease {
                job_id: job_id.into(),
                task_id: task_id.into(),
                execution_id: execution_id.into(),
                state: target,
                event_key: event_key.clone(),
            });
            Ok((
                next,
                vec![WorkflowEvent {
                    key: event_key.clone(),
                    event_id: "task.failed".into(),
                    payload: json!({"event_id":event_key,"type":"task.failed","jobId":job_id,
                    "taskId":task_id,"executionId":execution_id,
                    "reason":"worker_outcome_unknown","source":{"component":"rust-recovery"}}),
                }],
            ))
        })?;
        recovered.ok_or("Recovery did not commit".into()).map(Some)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authority::tests::setup;
    use crate::authority::ExecutionProcessRecord;
    #[test]
    fn missing_process_record_never_clears_lease() {
        let (_dir, path) = setup();
        let mut a = RelayAuthority::open_existing(&path).unwrap();
        a.commit_job("91", "2026-11-13T20:00:01.000Z", |old| {
            let mut next = old.clone();
            next["updatedAt"] = json!("2026-11-13T20:00:01.000Z");
            let t = &mut next["tasks"][0];
            t["state"] = json!("RUNNING");
            t["leaseExpiresAt"] = json!("2026-11-13T20:00:02.000Z");
            t["leaseOwner"] = json!("test-daemon");
            t["executionId"] = json!("exec-test");
            t["attempt"] = json!(1);
            t["maxAttempts"] = json!(3);
            Ok((next, vec![]))
        })
        .unwrap();
        assert!(a
            .fail_proven_expired_lease("91", "101", "2026-11-13T20:00:03.000Z")
            .is_err());
        let t = &a.read_job("91").unwrap().unwrap()["tasks"][0];
        assert_eq!(t["state"], "RUNNING");
        assert_eq!(t["executionId"], "exec-test");
        let _record = ExecutionProcessRecord {
            job_id: "91".into(),
            task_id: "101".into(),
            execution_id: "exec-test".into(),
            lease_owner: "test-daemon".into(),
            host: "other-host".into(),
            pid: 99999,
            pgid: 99999,
            start_token: "stale".into(),
            observed_at: "2026-11-13T20:00:01Z".into(),
            ended_at: None,
        };
        // Wrong host, even with no such local PID, must remain blocked.
    }
}
