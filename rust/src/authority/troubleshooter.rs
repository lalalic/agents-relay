//! Graph-selected creation of one durable Troubleshooter for a failed work
//! Task. The Troubleshooter Task is ordinary Relay work; recovery authority
//! stays in the Troubleshooter, Task Resolution, and Task Lifecycle graphs.
use super::ids::{allocate_entity_id_in_tx, EntityKind};
use super::{RelayAuthority, WorkflowEvent};
use crate::dispatch::ActionPorts;
use crate::graph::{Decision, Graph, GraphInput};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

const TROUBLESHOOTER_GRAPH: &str = include_str!("../../../workflow/troubleshooter.mmd");
const TASK_GRAPH: &str = include_str!("../../../workflow/task-lifecycle.mmd");
const TROUBLESHOOTER_STORY_SIZE: &str = "M";

fn timeout_for_story_size(size: &str) -> Result<i64, String> {
    match size {
        "S" => Ok(300_000),
        "M" => Ok(900_000),
        "L" => Ok(2_700_000),
        _ => Err("unsupported Troubleshooter storySize".into()),
    }
}

struct ProposalPorts;
impl ActionPorts for ProposalPorts {
    fn persist_transition(&mut self, _source: &str, _target: &str) -> Result<(), String> {
        Ok(())
    }
    fn execute_action(&mut self, _action_id: &str, _input: &GraphInput) -> Result<Value, String> {
        Ok(json!({"ok":true,"payloads":{}}))
    }
    fn publish_event(&mut self, event_id: &str, _payload: &Value) -> Result<(), String> {
        Err(format!(
            "unexpected Troubleshooter proposal event {event_id}"
        ))
    }
}

#[derive(Clone, Debug)]
pub struct TroubleshooterAgent {
    pub routing: Value,
    pub worker_selection: Value,
}

#[derive(Clone, Debug)]
pub struct CreatedTroubleshooter {
    pub task_id: String,
    pub original_task_id: String,
    pub task: Value,
}

fn failed_ordinary_task(task: &Value) -> bool {
    task["state"] == "FAILED" && task["kind"] != "planner" && task["agentName"] != "troubleshooter"
}

fn proposal(job: &Value, original_id: &str) -> Result<Decision, String> {
    let original = job["tasks"]
        .as_array()
        .and_then(|tasks| tasks.iter().find(|task| task["id"] == original_id))
        .ok_or("failed Task missing")?;
    let existing = job["tasks"].as_array().ok_or("Job Tasks missing")?;
    let already_has_recovery = existing
        .iter()
        .any(|task| task["agentName"] == "troubleshooter" && task["parentTaskId"] == original_id);
    let graph = Graph::parse(TROUBLESHOOTER_GRAPH)?;
    let mut ports = ProposalPorts;
    Ok(graph
        .dispatch_through_transient(
            "idle",
            GraphInput {
                transport: "event".into(),
                id: "troubleshooter.reconcile".into(),
                payload: json!({"taskId":original_id}),
            },
            &HashMap::from([
                ("failedWork".into(), original["state"] == "FAILED"),
                (
                    "ordinaryWork".into(),
                    original["kind"] != "planner" && original["agentName"] != "troubleshooter",
                ),
                (
                    "currentRun".into(),
                    job["state"] == "ACTIVE" && job.get("pause").is_none_or(Value::is_null),
                ),
                (
                    "needsRecovery".into(),
                    !(original["state"] == "BLOCKED"
                        && (!original["unblock"].is_null()
                            || !original["interactiveInvocation"].is_null())),
                ),
                ("idUnused".into(), !already_has_recovery),
                ("noRecoveryBarrier".into(), !already_has_recovery),
            ]),
            |state| state.starts_with("check_"),
            &mut ports,
        )?
        .decision)
}

fn failure_input(job: &Value, original: &Value) -> Result<String, String> {
    let original_id = original["id"].as_str().ok_or("failed Task ID missing")?;
    let job_id = job["id"].as_str().ok_or("Job ID missing")?;
    let routing = original
        .get("routing")
        .filter(|value| !value.is_null())
        .map(Value::to_string)
        .unwrap_or_else(|| "unrouted".into());
    let worker = original["workerSelection"]["workerId"]
        .as_str()
        .or_else(|| original["adapter"].as_str())
        .unwrap_or("unknown");
    let reason = original["failureReason"]
        .as_str()
        .or_else(|| original["error"].as_str())
        .unwrap_or("unknown");
    Ok(format!(
        "Recover the failed task below only when a verified graph-authorized path is safe.\n\nOriginal repository: {}\nOriginal PR: #{}\nOriginal job: {job_id}\nOriginal task: {original_id}\nOriginal state: {}\nOriginal attempt: {}\nOriginal worker: {worker}\nOriginal routing: {routing}\nFailure reason: {reason}\n\nRetrieve the complete task event history using the version-matched Relay CLI before classifying the cause. Inspect event order, source, execution IDs, duplicate or missing terminal receipts, and relevant runtime evidence. Diagnose the confirmed root cause from durable evidence. Resolve the original through the authorized Relay Task Resolution workflow; never retry or mutate the original directly. Preserve unknown outcomes, routing evidence, and human approval boundaries.",
        job["repository"].as_str().unwrap_or("unknown"),
        job["prNumber"].as_i64().unwrap_or(0),
        original["state"].as_str().unwrap_or("unknown"),
        original["attempt"].as_i64().unwrap_or(0),
    ))
}

impl RelayAuthority {
    /// Create a Troubleshooter only when the canonical graph selects
    /// `troubleshooter.create`. The failed Task and active recovery barrier are
    /// rechecked inside the same immediate SQLite transaction as ID allocation
    /// and Task persistence, so concurrent ticks cannot create siblings.
    pub fn create_troubleshooter_for_failed_task(
        &mut self,
        job_id: &str,
        original_task_id: &str,
        agent: &TroubleshooterAgent,
        at: &str,
    ) -> Result<Option<CreatedTroubleshooter>, String> {
        let snapshot = self.read_job(job_id)?.ok_or("Troubleshooter Job missing")?;
        let decision = proposal(&snapshot, original_task_id)?;
        let Decision::Accepted {
            target, actions, ..
        } = decision
        else {
            return Ok(None);
        };
        if target != "create" || actions.len() != 1 || actions[0].id != "troubleshooter.create" {
            return Ok(None);
        }
        if agent.routing["provider"].as_str().is_none_or(str::is_empty)
            || agent.routing["model"].as_str().is_none_or(str::is_empty)
            || agent.worker_selection["adapter"] != "codex"
            || agent.worker_selection["workerId"]
                .as_str()
                .is_none_or(str::is_empty)
        {
            return Err("trusted Troubleshooter Model route is incomplete".into());
        }

        let mut created = None;
        let at = at.to_owned();
        let result = self.commit_job_with_tx(job_id, &at, |tx, current| {
            let decision = proposal(current, original_task_id)?;
            let Decision::Accepted {
                target, actions, ..
            } = decision
            else {
                return Err("troubleshooter_not_selected".into());
            };
            if target != "create"
                || actions.len() != 1
                || actions[0].id != "troubleshooter.create"
            {
                return Err("troubleshooter_not_selected".into());
            }
            let original = current["tasks"]
                .as_array()
                .and_then(|tasks| tasks.iter().find(|task| task["id"] == original_task_id))
                .ok_or("failed Task missing during Troubleshooter creation")?;
            if !failed_ordinary_task(original) {
                return Err("troubleshooter_not_selected".into());
            }
            let repository = current["repository"]
                .as_str()
                .filter(|value| !value.is_empty())
                .ok_or("Job repository identity missing")?;
            let occupied = current["tasks"]
                .as_array()
                .ok_or("Job Tasks missing")?
                .iter()
                .filter_map(|task| task["id"].as_str().map(str::to_owned))
                .collect::<HashSet<_>>();
            let request_key = format!("troubleshooter:{job_id}:{original_task_id}");
            let task_id = allocate_entity_id_in_tx(
                tx,
                repository,
                EntityKind::Task,
                Some(&request_key),
                &occupied,
            )?;
            let input = failure_input(current, original)?;
            let mut task = json!({
                "id":task_id,"jobId":job_id,"title":"Troubleshooter","kind":"work",
                "priority":"P0","storySize":TROUBLESHOOTER_STORY_SIZE,"projectName":current["title"],
                "agentName":"troubleshooter","parentTaskId":original_task_id,
                "recoveryForAttempt":original["attempt"],"dependencies":[],
                "capabilities":["troubleshoot","recovery"],
                "workerRequirements":{"capabilities":["model","local_repo","iterative_tools"],"runtime":"codex"},
                "adapter":"codex","routing":agent.routing,"workerSelection":agent.worker_selection,
                "input":input,"output":{"kind":"task_pr"},"attempt":0,"maxAttempts":3,
                "leaseOwner":null,"leaseExpiresAt":null,"executionId":null,"threadId":null,
                "result":null,"error":null,"timeoutMs":timeout_for_story_size(TROUBLESHOOTER_STORY_SIZE)?,"state":"DRAFT",
                "createdAt":at,"updatedAt":at
            });
            let task_graph = Graph::parse(TASK_GRAPH)?;
            let Decision::Accepted {
                target: task_state,
                actions: task_actions,
                ..
            } = task_graph.decide(
                "DRAFT",
                GraphInput {
                    transport: "event".into(),
                    id: "reconcile".into(),
                    payload: json!({"taskId":task_id}),
                },
                &HashMap::from([
                    ("dependenciesSatisfied".into(), true),
                    ("dependenciesUnsatisfied".into(), false),
                    ("runnable".into(), true),
                ]),
            )? else {
                return Err("Task Lifecycle Graph denied Troubleshooter queueing".into());
            };
            if task_state != "QUEUED" {
                return Err("Task Lifecycle Graph selected an invalid Troubleshooter state".into());
            }
            crate::lifecycle::apply_pure_task_actions(&mut task, &task_actions)?;
            task["state"] = json!(task_state);
            task["updatedAt"] = json!(at);
            let mut next = current.clone();
            next["tasks"].as_array_mut().ok_or("Job Tasks missing")?.push(task.clone());
            next["updatedAt"] = json!(at);
            let event_key = format!("troubleshooter-created:{job_id}:{original_task_id}");
            created = Some(CreatedTroubleshooter {
                task_id: task_id.clone(),
                original_task_id: original_task_id.into(),
                task,
            });
            Ok((next, vec![WorkflowEvent {
                key: event_key.clone(),
                event_id: event_key.clone(),
                payload: json!({"event_id":event_key,"type":"troubleshooter.created",
                    "job_id":job_id,"task_id":task_id,"parent_task_id":original_task_id,
                    "status":"queued","visibility":"orchestrator",
                    "message":format!("Troubleshooter Task {task_id} created for failed Task {original_task_id}"),
                    "data":{"agentName":"troubleshooter","originalTaskId":original_task_id},
                    "source":{"component":"agents-relay-rust"}}),
            }]))
        });
        match result {
            Ok(_) => Ok(created),
            Err(error) if error == "troubleshooter_not_selected" => Ok(None),
            Err(error) => Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use tempfile::tempdir;

    const AT: &str = "2026-11-15T14:00:00.000Z";

    fn fixture(recovery: bool, failed: bool) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempdir().unwrap();
        let path = dir.path().join("relay.sqlite");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL);").unwrap();
        let mut tasks = vec![
            json!({"id":"101","jobId":"91","kind":"work","agentName":"implementation",
            "state":if failed {"FAILED"} else {"SUCCEEDED"},"attempt":2,"adapter":"codex",
            "failureReason":"verified worker timeout","error":"timeout","executionHistory":[],"updatedAt":AT}),
        ];
        if recovery {
            tasks.push(
                json!({"id":"102","jobId":"91","kind":"work","agentName":"troubleshooter",
                "parentTaskId":"101","recoveryForAttempt":2,"state":"QUEUED","updatedAt":AT}),
            );
        }
        let job = json!({"id":"91","repository":"example","title":"isolated recovery fixture",
            "state":"ACTIVE","updatedAt":AT,"tasks":tasks,"plans":[],"reviewEnabled":true,
            "autoMerge":true,"prNumber":0});
        conn.execute(
            "INSERT INTO job_snapshot VALUES('91',?1,?2)",
            rusqlite::params![job.to_string(), AT],
        )
        .unwrap();
        (dir, path)
    }

    fn trusted_agent() -> TroubleshooterAgent {
        TroubleshooterAgent {
            routing: json!({"provider":"openai","model":"gpt-test","decidedBy":"test","decidedAt":AT}),
            worker_selection: json!({"adapter":"codex","workerId":"codex"}),
        }
    }

    #[test]
    fn failed_work_creates_one_graph_selected_recovery_and_stays_failed_after_restart() {
        let (_dir, path) = fixture(false, true);
        let mut authority = RelayAuthority::open_existing(&path).unwrap();
        let first = authority
            .create_troubleshooter_for_failed_task(
                "91",
                "101",
                &trusted_agent(),
                "2026-11-15T14:00:00.001Z",
            )
            .unwrap()
            .unwrap();
        assert_eq!(first.task["agentName"], "troubleshooter");
        assert_eq!(first.task["parentTaskId"], "101");
        assert_eq!(first.task["recoveryForAttempt"], 2);
        assert_eq!(first.task["state"], "QUEUED");
        assert_eq!(first.task["adapter"], "codex");
        assert_eq!(first.task["routing"], trusted_agent().routing);
        assert_eq!(
            first.task["workerSelection"],
            trusted_agent().worker_selection
        );
        let job = authority.read_job("91").unwrap().unwrap();
        assert_eq!(job["tasks"].as_array().unwrap().len(), 2);
        assert_eq!(job["tasks"][0]["state"], "FAILED");
        assert!(job["tasks"][0]["result"].is_null());
        assert_eq!(
            authority
                .pending_events()
                .unwrap()
                .iter()
                .filter(|event| event.payload["type"] == "troubleshooter.created")
                .count(),
            1
        );
        drop(authority);
        let mut restarted = RelayAuthority::open_existing(&path).unwrap();
        assert!(restarted
            .create_troubleshooter_for_failed_task(
                "91",
                "101",
                &trusted_agent(),
                "2026-11-15T14:00:00.002Z"
            )
            .unwrap()
            .is_none());
        let after = restarted.read_job("91").unwrap().unwrap();
        assert_eq!(after["tasks"].as_array().unwrap().len(), 2);
        assert_eq!(after["tasks"][0]["state"], "FAILED");
    }

    #[test]
    fn graph_denies_nonfailed_and_already_owned_recovery_without_snapshot_write() {
        for (already_exists, failed) in [(false, false), (true, true)] {
            let (_dir, path) = fixture(already_exists, failed);
            let mut authority = RelayAuthority::open_existing(&path).unwrap();
            let before = authority.read_job("91").unwrap().unwrap();
            assert!(authority
                .create_troubleshooter_for_failed_task(
                    "91",
                    "101",
                    &trusted_agent(),
                    "2026-11-15T14:00:00.001Z"
                )
                .unwrap()
                .is_none());
            assert_eq!(authority.read_job("91").unwrap().unwrap(), before);
            assert!(authority.pending_events().unwrap().is_empty());
        }
    }

    #[test]
    fn paused_job_cannot_create_troubleshooter_during_reconciliation_race() {
        let (_dir, path) = fixture(false, true);
        let connection = Connection::open(&path).unwrap();
        connection
            .execute(
                "UPDATE job_snapshot SET json=json_set(json,'$.state','PAUSED') WHERE job_id='91'",
                [],
            )
            .unwrap();
        drop(connection);
        let mut authority = RelayAuthority::open_existing(&path).unwrap();
        let before = authority.read_job("91").unwrap().unwrap();
        assert!(authority
            .create_troubleshooter_for_failed_task(
                "91",
                "101",
                &trusted_agent(),
                "2026-11-15T14:00:00.001Z"
            )
            .unwrap()
            .is_none());
        assert_eq!(authority.read_job("91").unwrap().unwrap(), before);
        assert!(authority.pending_events().unwrap().is_empty());
    }
}
