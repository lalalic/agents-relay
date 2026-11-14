//! Atomic native Script Scheduler claim. The Task Graph authorizes dispatch;
//! the existing SQLite Job snapshot and Action Attempt Ledger form one
//! transaction. No second queue, independent DAG policy or worker launch.
use super::ledger::reserve_authorized_action_tx;
use super::{ActionIdentity, RelayAuthority};
use crate::graph::{Decision, Graph, GraphInput};
use chrono::DateTime;
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

impl RelayAuthority {
    /// A native worker may only run after this has durably returned a new
    /// lease and launch Action claim. A contender with the same Task receives
    /// `None`, not another execution generation. This is intentionally serial
    /// per Job while the full execution slot/router is being ported.
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
                || task
                    .get("interactiveInvocation")
                    .is_some_and(|inv| inv["status"] == "changes_requested")
            {
                return Err("Task not eligible for native worker dispatch".into());
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
            // Serial execution slot until DAG-specific concurrency is ported:
            // other Task executions must not be silently overwritten.
            if tasks.iter().any(|other| {
                other["id"] != req.task_id
                    && (other["state"] == "RUNNING"
                        || (other["state"] == "QUEUED"
                            && other.get("executionId").is_some_and(|id| !id.is_null())))
            }) {
                return Err("Job has conflicting active Task execution".into());
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
            let decision = graph.decide(
                "QUEUED",
                input(req.task_id, req.execution_id),
                &HashMap::from([("dispatchable".into(), true)]),
            )?;
            if !matches!(&decision,Decision::Accepted{source,target,actions,..}
                if source=="QUEUED" && target=="QUEUED" && actions.len()==1
                    && actions[0].id=="effect.launchTask")
            {
                return Err("Task Graph did not authorize exactly one launch effect".into());
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
            if !reserve_authorized_action_tx(tx, &identity, &decision, "worker.started", req.at)? {
                return Err("duplicate native launch attempt identity".into());
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
