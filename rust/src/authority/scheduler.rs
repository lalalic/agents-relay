//! Atomic native Script Scheduler claim. The Task Graph authorizes dispatch;
//! the existing SQLite Job snapshot and Action Attempt Ledger form one
//! transaction. No second queue, independent DAG policy or worker launch.
use super::ledger::reserve_authorized_action_tx;
use super::{ActionIdentity, RelayAuthority};
use crate::dispatch::ActionPorts;
use crate::graph::{Decision, Graph, GraphInput};
use chrono::DateTime;
use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;

#[derive(Clone, Debug)]
pub struct ScriptClaimRequest<'a> {
    pub job_id: &'a str,
    pub task_id: &'a str,
    pub execution_id: &'a str,
    pub owner: &'a str,
    pub at: &'a str,
    pub lease_expires_at: &'a str,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptClaim {
    pub job_id: String,
    pub task_id: String,
    pub execution_id: String,
    pub owner: String,
    pub adapter: String,
    pub routing: Option<Value>,
    pub worker_selection: Option<Value>,
    pub attempt: i64,
    pub attempt_key: String,
    pub claimed_at: String,
    pub lease_expires_at: String,
}

fn input(task_id: &str, execution_id: &str) -> GraphInput {
    GraphInput {
        transport: "event".into(),
        id: "dispatch".into(),
        payload: json!({"taskId":task_id,"executionId":execution_id}),
    }
}

struct LaunchClaimEffect<'a, 'db> {
    tx: &'a Transaction<'db>,
    identity: ActionIdentity,
    at: &'a str,
    reserved: bool,
}

impl ActionPorts for LaunchClaimEffect<'_, '_> {
    fn persist_transition(&mut self, source: &str, target: &str) -> Result<(), String> {
        if source != "QUEUED" || target != "QUEUED" {
            return Err("Task Graph selected an invalid launch transition".into());
        }
        Ok(())
    }

    fn execute_action(&mut self, action_id: &str, _input: &GraphInput) -> Result<Value, String> {
        Err(format!(
            "launch effect requires its Graph decision: {action_id}"
        ))
    }

    fn execute_authorized_action(
        &mut self,
        action_id: &str,
        _input: &GraphInput,
        decision: &Decision,
    ) -> Result<Value, String> {
        if action_id != "effect.launchTask" || self.reserved {
            return Err("Task Graph did not select one fresh launch effect".into());
        }
        self.reserved = reserve_authorized_action_tx(
            self.tx,
            &self.identity,
            decision,
            "worker.started",
            self.at,
        )?;
        if !self.reserved {
            return Err("duplicate native launch attempt identity".into());
        }
        Ok(json!({"ok":true,"payloads":{}}))
    }

    fn publish_event(&mut self, event_id: &str, _payload: &Value) -> Result<(), String> {
        Err(format!("unexpected launch event {event_id}"))
    }
}

impl RelayAuthority {
    /// A native worker may only run after this has durably returned a new
    /// lease and launch Action claim. A contender with the same Task receives
    /// `None`, not another execution generation. Distinct eligible Tasks may
    /// hold independent leases at once; the daemon supplies worker capacity.
    pub fn claim_queued_script(
        &mut self,
        req: &ScriptClaimRequest<'_>,
    ) -> Result<Option<ScriptClaim>, String> {
        self.claim_queued_worker(req, "script")
    }

    /// Codex/Model requires an already durable worker/model routing decision.
    /// This does not implement a second Router or authorize Review/Planner
    /// Tasks. Only ordinary work Tasks are admitted in this staged adapter.
    pub fn claim_queued_codex(
        &mut self,
        req: &ScriptClaimRequest<'_>,
    ) -> Result<Option<ScriptClaim>, String> {
        self.claim_queued_worker(req, "codex")
    }

    fn claim_queued_worker(
        &mut self,
        req: &ScriptClaimRequest<'_>,
        adapter: &str,
    ) -> Result<Option<ScriptClaim>, String> {
        if !matches!(adapter, "script" | "codex") {
            return Err("native Worker adapter is unsupported".into());
        }
        if [req.job_id, req.task_id, req.execution_id, req.owner]
            .iter()
            .any(|s| s.is_empty())
        {
            return Err("invalid native Script claim identity".into());
        }
        let now = DateTime::parse_from_rfc3339(req.at).map_err(|_| "invalid Script claim time")?;
        let expires = DateTime::parse_from_rfc3339(req.lease_expires_at)
            .map_err(|_| "invalid Script claim lease expiry")?;
        if expires <= now {
            return Err("Script lease must expire after claim time".into());
        }
        let graph = Graph::parse(include_str!("../../../workflow/task-lifecycle.mmd"))?;
        let mut claimed = None;
        self.commit_job_with_tx(req.job_id, req.at, |tx, prior| {
            if prior["state"] != "ACTIVE"
                || prior.get("pause").is_some_and(|value| !value.is_null())
            {
                return Err("only ACTIVE, unpaused Jobs may dispatch native Workers".into());
            }
            let tasks = prior
                .get("tasks")
                .and_then(Value::as_array)
                .ok_or("Job Task snapshot missing")?;
            let task = tasks
                .iter()
                .find(|task| task["id"] == req.task_id)
                .ok_or("Script Task missing")?;
            if task["state"] != "QUEUED"
                || task["adapter"] != adapter
                || task.get("kind").and_then(Value::as_str) == Some("planner")
                || matches!(
                    task.get("agentName").and_then(Value::as_str),
                    Some("job-acceptance-reviewer" | "reviewer" | "troubleshooter")
                )
                || task.get("reviewHeadSha").is_some_and(|v| !v.is_null())
                || task.get("agentGraph").is_some_and(|value| !value.is_null())
                || task
                    .get("revisionRequest")
                    .is_some_and(|value| !value.is_null())
                || task.get("interactiveInvocation").is_some_and(|inv| {
                    !inv.is_null()
                        && !matches!(
                            inv["status"].as_str(),
                            Some("approved" | "changes_requested")
                        )
                })
            {
                return Err("Task not eligible for native worker dispatch".into());
            }
            if !crate::authority::dependency_revision_still_current(prior, task) {
                return Err("dependency revision evidence is stale or has unsettled upstream work".into());
            }
            // The UI is not the authority for human approval: even if a
            // corrupted caller has written status=approved into the snapshot,
            // the current execution/revision must have a committed host decision
            // in the same SQLite authority. Check under this claim transaction.
            if let Some(inv) = task.get("interactiveInvocation").filter(|inv| !inv.is_null()) {
                let invocation_id = inv["invocationId"].as_str().ok_or("Review invocation ID missing")?;
                let revision = inv["revision"].as_str().ok_or("Review revision missing")?;
                let original_execution = inv["executionId"].as_str().ok_or("Review origin execution missing")?;
                let decision = inv["status"]
                    .as_str()
                    .ok_or("Review decision status missing")?;
                let accepted: Option<i64> = tx.query_row(
                    "SELECT 1 FROM host_invocation_decision WHERE job_id=?1 AND task_id=?2 AND invocation_id=?3 AND execution_id=?4 AND revision=?5 AND decision=?6",
                    params![req.job_id, req.task_id, invocation_id, original_execution, revision, decision],
                    |row| row.get(0),
                ).optional().map_err(|error|format!("Review approval ledger unavailable: {error}"))?;
                if accepted != Some(1) {
                    return Err("Review decision status not backed by durable host decision".into());
                }
            }
            if adapter == "codex" {
                let selection = &task["workerSelection"];
                if selection["adapter"] != "codex"
                    || selection["workerId"]
                        .as_str()
                        .is_none_or(|v| v.trim().is_empty())
                {
                    return Err("Codex Task requires durable Worker Router selection".into());
                }
                let route = &task["routing"];
                let provider = route.get("provider").and_then(Value::as_str).unwrap_or("");
                let model = route.get("model").and_then(Value::as_str).unwrap_or("");
                if provider.trim().is_empty()
                    || model.trim().is_empty()
                    || route["decidedBy"]
                        .as_str()
                        .is_none_or(|v| v.trim().is_empty())
                    || route["decidedAt"]
                        .as_str()
                        .is_none_or(|v| v.trim().is_empty())
                    || route
                        .get("adapter")
                        .and_then(Value::as_str)
                        .is_some_and(|value| value != "codex")
                {
                    return Err(
                        "Codex Task requires a durable provider/model routing decision".into(),
                    );
                }
            }
            if task
                .get("executionId")
                .is_some_and(|value| !value.is_null())
                || task.get("leaseOwner").is_some_and(|value| !value.is_null())
            {
                // Another scheduler already committed the generation. The
                // caller is forbidden from launching a duplicate worker.
                return Err("Task already has a durable execution claim".into());
            }
            let dependencies = task
                .get("dependencies")
                .and_then(Value::as_array)
                .ok_or("Script Task dependencies missing")?;
            if !dependencies.iter().all(|id| {
                id.as_str().is_some_and(|id| {
                    tasks
                        .iter()
                        .any(|parent| parent["id"] == id && parent["state"] == "SUCCEEDED")
                })
            }) {
                return Err("Script Task dependencies not satisfied".into());
            }
            let prior_attempt = task
                .get("attempt")
                .and_then(Value::as_i64)
                .ok_or("missing Task attempt")?;
            let max_attempts = task
                .get("maxAttempts")
                .and_then(Value::as_i64)
                .ok_or("missing Task maxAttempts")?;
            let attempt = prior_attempt
                .checked_add(1)
                .ok_or("Task attempt overflow")?;
            if attempt > max_attempts || attempt <= 0 {
                return Err("native Script retry budget exhausted".into());
            }
            if tasks
                .iter()
                .any(|other| other["id"] != req.task_id && other["executionId"] == req.execution_id)
            {
                return Err("duplicate native execution ID within Job".into());
            }
            let key = format!("{}/{}/{}/launch", req.job_id, req.task_id, req.execution_id);
            let identity = ActionIdentity {
                job_id: req.job_id.into(),
                task_id: req.task_id.into(),
                execution_id: req.execution_id.into(),
                lease_owner: req.owner.into(),
                attempt,
                generation: attempt,
                graph: "task-lifecycle.mmd".into(),
                action_id: "effect.launchTask".into(),
                attempt_key: key.clone(),
            };
            let mut effect = LaunchClaimEffect {
                tx,
                identity,
                at: req.at,
                reserved: false,
            };
            let dispatched = graph.dispatch(
                "QUEUED",
                input(req.task_id, req.execution_id),
                &HashMap::from([("dispatchable".into(), true)]),
                &mut effect,
            )?;
            if !matches!(&dispatched.decision,Decision::Accepted{source,target,actions,..}
                if source=="QUEUED" && target=="QUEUED" && actions.len()==1
                    && actions[0].id=="effect.launchTask")
                || !effect.reserved
            {
                return Err("Task Graph did not authorize exactly one launch effect".into());
            }
            let mut next = prior.clone();
            let entry = next
                .get_mut("tasks")
                .and_then(Value::as_array_mut)
                .and_then(|tasks| tasks.iter_mut().find(|task| task["id"] == req.task_id))
                .ok_or("Script Task missing during claim")?;
            entry["attempt"] = json!(attempt);
            entry["executionId"] = json!(req.execution_id);
            entry["leaseOwner"] = json!(req.owner);
            entry["leaseExpiresAt"] = json!(req.lease_expires_at);
            let history = entry
                .get_mut("executionHistory")
                .and_then(Value::as_array_mut);
            if let Some(history) = history {
                history.push(json!({"id":req.execution_id,"attempt":attempt,"startedAt":req.at}));
            } else {
                entry["executionHistory"] =
                    json!([{"id":req.execution_id,"attempt":attempt,"startedAt":req.at}]);
            }
            entry["updatedAt"] = json!(req.at);
            next["updatedAt"] = json!(req.at);
            claimed = Some(ScriptClaim {
                job_id: req.job_id.into(),
                task_id: req.task_id.into(),
                execution_id: req.execution_id.into(),
                owner: req.owner.into(),
                adapter: adapter.into(),
                routing: if adapter == "codex" {
                    task.get("routing").cloned()
                } else {
                    None
                },
                worker_selection: if adapter == "codex" {
                    task.get("workerSelection").cloned()
                } else {
                    None
                },
                attempt,
                attempt_key: key,
                claimed_at: req.at.into(),
                lease_expires_at: req.lease_expires_at.into(),
            });
            Ok((next, vec![]))
        })?;
        Ok(claimed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authority::tests::setup;
    fn prepare(auth: &mut RelayAuthority, at: &str) {
        auth.commit_job("91", at, |prior| {
            let mut next = prior.clone();
            next["updatedAt"] = json!(at);
            let task = &mut next["tasks"][0];
            task["adapter"] = json!("script");
            task["dependencies"] = json!([]);
            task["attempt"] = json!(0);
            task["maxAttempts"] = json!(3);
            task["executionId"] = Value::Null;
            task["leaseOwner"] = Value::Null;
            Ok((next, vec![]))
        })
        .unwrap();
    }
    #[test]
    fn graph_authorized_atomic_script_claim_fences_replay_and_rollback() {
        let (_dir, path) = setup();
        let mut auth = RelayAuthority::open_existing(&path).unwrap();
        let job = "91";
        prepare(&mut auth, "2026-11-13T20:00:00.500Z");
        let claim = ScriptClaimRequest {
            job_id: job,
            task_id: "101",
            execution_id: "ex-native-1",
            owner: "local-test",
            at: "2026-11-13T20:00:01.000Z",
            lease_expires_at: "2099-01-01T00:00:00.000Z",
        };
        let first = auth.claim_queued_script(&claim).unwrap().unwrap();
        assert_eq!(first.attempt, 1);
        assert_eq!(first.attempt_key, "91/101/ex-native-1/launch");
        assert_eq!(
            auth.read_job(job).unwrap().unwrap()["tasks"][0]["executionId"],
            "ex-native-1"
        );
        assert_eq!(
            auth.action_trace(&first.attempt_key)
                .unwrap()
                .unwrap()
                .outcome,
            super::super::ActionOutcome::Unknown
        );
        assert!(auth.claim_queued_script(&claim).is_err());
        assert_eq!(
            auth.action_trace(&first.attempt_key)
                .unwrap()
                .unwrap()
                .generation,
            1
        );
        auth.begin_script_launch(&first, "2026-11-13T20:00:02.000Z")
            .unwrap();
        assert!(
            auth.begin_script_launch(&first, "2026-11-13T20:00:02.000Z")
                .is_err(),
            "exact Script execution must not launch twice"
        );
        assert_eq!(
            auth.action_trace(&first.attempt_key)
                .unwrap()
                .unwrap()
                .observed_at,
            "2026-11-13T20:00:02.000Z"
        );
    }

    #[test]
    fn independent_ready_siblings_claim_concurrently_but_duplicate_claims_are_rejected() {
        let (_dir, path) = setup();
        let mut auth = RelayAuthority::open_existing(&path).unwrap();
        prepare(&mut auth, "2026-11-13T20:00:00.500Z");
        auth.commit_job("91", "2026-11-13T20:00:00.600Z", |job| {
            let mut next = job.clone();
            next["updatedAt"] = json!("2026-11-13T20:00:00.600Z");
            let sibling = next["tasks"][0].clone();
            let mut sibling = sibling;
            sibling["id"] = json!("102");
            sibling["title"] = json!("independent sibling");
            sibling["executionId"] = Value::Null;
            sibling["leaseOwner"] = Value::Null;
            next["tasks"].as_array_mut().unwrap().push(sibling);
            Ok((next, vec![]))
        })
        .unwrap();
        let claim = |task_id, execution_id, at| ScriptClaimRequest {
            job_id: "91",
            task_id,
            execution_id,
            owner: "local-test",
            at,
            lease_expires_at: "2099-01-01T00:00:00.000Z",
        };
        let first = auth
            .claim_queued_script(&claim("101", "sibling-1", "2026-11-13T20:00:01.000Z"))
            .unwrap()
            .unwrap();
        let second = auth
            .claim_queued_script(&claim("102", "sibling-2", "2026-11-13T20:00:02.000Z"))
            .unwrap()
            .unwrap();
        assert_ne!(first.execution_id, second.execution_id);
        assert!(auth
            .claim_queued_script(&claim("101", "stale-replay", "2026-11-13T20:00:03.000Z"))
            .is_err());
        let snapshot = auth.read_job("91").unwrap().unwrap();
        assert_eq!(snapshot["tasks"][0]["state"], "QUEUED");
        assert_eq!(snapshot["tasks"][1]["state"], "QUEUED");
        assert_eq!(snapshot["tasks"][0]["executionId"], first.execution_id);
        assert_eq!(snapshot["tasks"][1]["executionId"], second.execution_id);
        assert_eq!(snapshot["state"], "ACTIVE");
        assert!(auth
            .action_trace("91/101/stale-replay/launch")
            .unwrap()
            .is_none());
    }

    #[test]
    fn codex_claim_requires_durable_route_and_rejects_duplicate_generation() {
        let (_dir, path) = setup();
        let mut auth = RelayAuthority::open_existing(&path).unwrap();
        prepare(&mut auth, "2026-11-13T20:00:00.500Z");
        auth.commit_job("91", "2026-11-13T20:00:00.600Z", |job| {
            let mut next = job.clone();
            next["updatedAt"] = json!("2026-11-13T20:00:00.600Z");
            let task = &mut next["tasks"][0];
            task["adapter"] = json!("codex");
            task["workerSelection"] = json!({"adapter":"codex","workerId":"fixture-worker"});
            task["routing"] = json!({});
            Ok((next, vec![]))
        })
        .unwrap();
        let request = ScriptClaimRequest {
            job_id: "91",
            task_id: "101",
            execution_id: "model-generation-1",
            owner: "local-test",
            at: "2026-11-13T20:00:01.000Z",
            lease_expires_at: "2099-01-01T00:00:00.000Z",
        };
        assert!(
            auth.claim_queued_codex(&request).is_err(),
            "missing route facts must not claim"
        );
        assert!(auth
            .action_trace("91/101/model-generation-1/launch")
            .unwrap()
            .is_none());

        auth.commit_job("91", "2026-11-13T20:00:00.700Z", |job| {
            let mut next = job.clone();
            next["updatedAt"] = json!("2026-11-13T20:00:00.700Z");
            next["tasks"][0]["routing"] = json!({
                "provider":"fixture","model":"fixture-model",
                "decidedBy":"fixture-router","decidedAt":"2026-11-13T20:00:00.700Z"
            });
            Ok((next, vec![]))
        })
        .unwrap();
        let first = auth.claim_queued_codex(&request).unwrap().unwrap();
        assert_eq!(first.adapter, "codex");
        assert_eq!(first.routing.as_ref().unwrap()["model"], "fixture-model");
        assert!(
            auth.claim_queued_codex(&request).is_err(),
            "same model generation must be rejected"
        );
        assert_eq!(
            auth.read_job("91").unwrap().unwrap()["tasks"][0]["executionId"],
            "model-generation-1"
        );
        assert!(auth
            .action_trace("91/101/model-generation-1/launch")
            .unwrap()
            .is_some());
    }
    #[test]
    fn refuses_paused_job_and_unready_dependencies_without_ledger_side_effect() {
        let (_dir, path) = setup();
        let mut auth = RelayAuthority::open_existing(&path).unwrap();
        auth.commit_job("91", "2026-11-13T20:00:01.000Z", |j| {
            let mut next = j.clone();
            next["updatedAt"] = json!("2026-11-13T20:00:01.000Z");
            next["pause"] = json!({"generation":1});
            let task = &mut next["tasks"][0];
            task["adapter"] = json!("script");
            task["dependencies"] = json!([]);
            task["attempt"] = json!(0);
            task["maxAttempts"] = json!(3);
            task["executionId"] = Value::Null;
            task["leaseOwner"] = Value::Null;
            Ok((next, vec![]))
        })
        .unwrap();
        let req = ScriptClaimRequest {
            job_id: "91",
            task_id: "101",
            execution_id: "ex-native-2",
            owner: "local-test",
            at: "2026-11-13T20:00:02.000Z",
            lease_expires_at: "2099-01-01T00:00:00.000Z",
        };
        assert!(auth.claim_queued_script(&req).is_err());
        assert_eq!(
            auth.read_job("91").unwrap().unwrap()["tasks"][0]["executionId"],
            Value::Null
        );
        assert!(auth
            .action_trace("91/101/ex-native-2/launch")
            .unwrap()
            .is_none());
    }
}
