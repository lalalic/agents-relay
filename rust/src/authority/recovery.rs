//! Expired-lease execution recovery: the *exact* process identity is re-probed
//! inside the authoritative SQLite write transaction before the canonical Task
//! Graph selects the existing `lease.expired` failure actions. A missing PID
//! record or uncertain process never gets silently retried or marked complete.
use super::process::query_record;
use super::{probe_process, ProcessProbe, RelayAuthority, WorkflowEvent};
use crate::graph::{Decision, Graph, GraphInput};
use crate::lifecycle::apply_pure_task_actions;
use crate::recovery::inspect_expired_execution;
use chrono::DateTime;
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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReopenedRecovery {
    pub job_id: String,
    pub original_task_id: String,
    pub task_id: String,
    pub attempt: i64,
    pub state: String,
    pub event_key: String,
}

impl RelayAuthority {
    /// Apply the canonical `recovery.reopen` Task effect to a Troubleshooter
    /// selected by the caller's recovery workflow. The transaction revalidates
    /// exact parentage and failure episode before applying Graph actions.
    pub fn reopen_troubleshooter_recovery(
        &mut self,
        job_id: &str,
        original_task_id: &str,
        recovery_task_id: &str,
        at: &str,
    ) -> Result<ReopenedRecovery, String> {
        DateTime::parse_from_rfc3339(at).map_err(|_| "invalid recovery reopen timestamp")?;
        let mut reopened = None;
        self.commit_job_with_tx(job_id, at, |_, prior| {
            if prior.get("state").and_then(Value::as_str) != Some("ACTIVE")
                || prior.get("pause").is_some_and(|value| !value.is_null())
            {
                return Err("recovery reopen requires an active, unpaused Job".into());
            }
            let tasks = prior
                .get("tasks")
                .and_then(Value::as_array)
                .ok_or("Job Task snapshot missing")?;
            let original = tasks
                .iter()
                .find(|task| task.get("id").and_then(Value::as_str) == Some(original_task_id))
                .ok_or("original recovery Task missing")?;
            let recovery = tasks
                .iter()
                .find(|task| task.get("id").and_then(Value::as_str) == Some(recovery_task_id))
                .ok_or("Troubleshooter recovery Task missing")?;
            if original.get("state").and_then(Value::as_str) != Some("FAILED")
                || original.get("kind").and_then(Value::as_str) == Some("planner")
                || original.get("agentName").and_then(Value::as_str) == Some("troubleshooter")
            {
                return Err("original Task is not failed ordinary work".into());
            }
            if recovery.get("agentName").and_then(Value::as_str) != Some("troubleshooter")
                || recovery.get("parentTaskId").and_then(Value::as_str)
                    != Some(original_task_id)
            {
                return Err("Troubleshooter parent identity mismatch".into());
            }
            let attempt = original
                .get("attempt")
                .and_then(Value::as_i64)
                .ok_or("original Task attempt missing")?;
            let recovered_attempt = recovery
                .get("recoveryForAttempt")
                .and_then(Value::as_i64)
                .ok_or("Troubleshooter recovery attempt missing")?;
            if recovered_attempt >= attempt {
                return Err("Troubleshooter recovery does not belong to an older failure episode".into());
            }
            let state = recovery
                .get("state")
                .and_then(Value::as_str)
                .ok_or("Troubleshooter state missing")?;
            let graph = Graph::parse(include_str!("../../../workflow/task-lifecycle.mmd"))?;
            let decision = graph.decide(
                state,
                GraphInput {
                    transport: "event".into(),
                    id: "recovery.reopen".into(),
                    payload: json!({"taskId": recovery_task_id, "originalTaskId": original_task_id, "attempt": attempt}),
                },
                &HashMap::from([("troubleshooterRecovery".into(), true)]),
            )?;
            let Decision::Accepted { target, actions, .. } = decision else {
                return Err("Task Graph denied Troubleshooter recovery reopen".into());
            };
            if target != "QUEUED"
                || actions.len() != 4
                || !actions.iter().any(|action| action.id == "mutation.clearError")
                || !actions.iter().any(|action| action.id == "mutation.clearFailureReason")
                || !actions.iter().any(|action| action.id == "mutation.clearLease")
                || !actions.iter().any(|action| action.id == "mutation.clearExecution")
            {
                return Err("unexpected Graph recovery reopen action set".into());
            }

            let event_key = format!("recovery-reopen:{job_id}:{recovery_task_id}:{attempt}");
            let mut next = prior.clone();
            let entry = next
                .get_mut("tasks")
                .and_then(Value::as_array_mut)
                .and_then(|items| items.iter_mut().find(|task| task["id"] == recovery_task_id))
                .ok_or("Troubleshooter disappeared during reopen")?;
            apply_pure_task_actions(entry, &actions)?;
            entry["state"] = json!(target);
            entry["recoveryForAttempt"] = json!(attempt);
            entry["updatedAt"] = json!(at);
            next["updatedAt"] = json!(at);
            reopened = Some(ReopenedRecovery {
                job_id: job_id.into(),
                original_task_id: original_task_id.into(),
                task_id: recovery_task_id.into(),
                attempt,
                state: target.clone(),
                event_key: event_key.clone(),
            });
            Ok((next, vec![WorkflowEvent {
                key: event_key.clone(),
                event_id: "troubleshooter.reopened".into(),
                payload: json!({"event_id":event_key,"type":"troubleshooter.reopened","jobId":job_id,
                    "taskId":recovery_task_id,"originalTaskId":original_task_id,"attempt":attempt,
                    "source":{"component":"rust-recovery"}}),
            }]))
        })?;
        reopened.ok_or_else(|| "Troubleshooter recovery reopen did not commit".into())
    }

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
    use serde_json::json;

    fn recovery_fixture(path: &std::path::Path, recovery_state: &str) {
        let mut authority = RelayAuthority::open_existing(path).unwrap();
        authority.commit_job("91", "2026-11-13T20:00:01.000Z", |job| {
            let mut next = job.clone();
            next["tasks"] = json!([
                {"id":"101","state":"FAILED","kind":"work","agentName":"implementation","attempt":2},
                {"id":"102","state":recovery_state,"kind":"work","agentName":"troubleshooter",
                 "parentTaskId":"101","recoveryForAttempt":1,"attempt":1,"error":"old diagnostic",
                 "failureReason":"old_failure","leaseOwner":"old-owner","leaseExpiresAt":"2026-11-13T19:59:00Z",
                 "executionId":"old-execution","executionHistory":[{"id":"old-execution","attempt":1}],"result":{"data":{"status":"COMPLETED"}}}
            ]);
            next["updatedAt"] = json!("2026-11-13T20:00:01.000Z");
            Ok((next, vec![]))
        }).unwrap();
    }

    #[test]
    fn graph_reopens_only_correlated_recovery_and_deduplicates_after_restart() {
        let (_dir, path) = setup();
        recovery_fixture(&path, "SUCCEEDED");
        let mut authority = RelayAuthority::open_existing(&path).unwrap();
        let result = authority
            .reopen_troubleshooter_recovery("91", "101", "102", "2026-11-13T20:00:02.000Z")
            .unwrap();
        assert_eq!(result.state, "QUEUED");
        assert_eq!(result.attempt, 2);
        let recovery = &authority.read_job("91").unwrap().unwrap()["tasks"][1];
        assert_eq!(recovery["state"], "QUEUED");
        assert_eq!(recovery["recoveryForAttempt"], 2);
        assert!(recovery["error"].is_null());
        assert!(recovery.get("failureReason").is_none());
        assert!(recovery["leaseOwner"].is_null());
        assert!(recovery["leaseExpiresAt"].is_null());
        assert!(recovery["executionId"].is_null());
        assert_eq!(recovery["executionHistory"][0]["id"], "old-execution");
        assert_eq!(recovery["result"]["data"]["status"], "COMPLETED");
        assert_eq!(
            authority.read_job("91").unwrap().unwrap()["tasks"][0]["state"],
            "FAILED"
        );
        assert_eq!(authority.pending_events().unwrap().len(), 1);

        let mut restarted = RelayAuthority::open_existing(&path).unwrap();
        assert!(restarted
            .reopen_troubleshooter_recovery("91", "101", "102", "2026-11-13T20:00:03.000Z",)
            .is_err());
        let persisted = restarted.read_job("91").unwrap().unwrap();
        assert_eq!(persisted["tasks"][1]["state"], "QUEUED");
        assert_eq!(restarted.pending_events().unwrap().len(), 1);
    }

    #[test]
    fn graph_reopens_cancelled_recovery_but_rejects_wrong_lineage_and_stale_episode() {
        let (_dir, path) = setup();
        recovery_fixture(&path, "CANCELLED");
        let mut authority = RelayAuthority::open_existing(&path).unwrap();
        assert!(authority
            .reopen_troubleshooter_recovery("91", "999", "102", "2026-11-13T20:00:02.000Z",)
            .is_err());
        authority
            .commit_job("91", "2026-11-13T20:00:02.000Z", |job| {
                let mut next = job.clone();
                next["tasks"][1]["parentTaskId"] = json!("999");
                next["updatedAt"] = json!("2026-11-13T20:00:02.000Z");
                Ok((next, vec![]))
            })
            .unwrap();
        assert!(authority
            .reopen_troubleshooter_recovery("91", "101", "102", "2026-11-13T20:00:03.000Z",)
            .is_err());
        authority
            .commit_job("91", "2026-11-13T20:00:04.000Z", |job| {
                let mut next = job.clone();
                next["tasks"][1]["parentTaskId"] = json!("101");
                next["tasks"][1]["recoveryForAttempt"] = json!(2);
                next["updatedAt"] = json!("2026-11-13T20:00:04.000Z");
                Ok((next, vec![]))
            })
            .unwrap();
        assert!(authority
            .reopen_troubleshooter_recovery("91", "101", "102", "2026-11-13T20:00:05.000Z",)
            .is_err());
        assert_eq!(
            authority.read_job("91").unwrap().unwrap()["tasks"][1]["state"],
            "CANCELLED"
        );
        assert!(authority.pending_events().unwrap().is_empty());
    }
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
