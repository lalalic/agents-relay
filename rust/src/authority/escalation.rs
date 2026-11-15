//! Durable Troubleshooter escalation effects. The Task Resolution and Task
//! Lifecycle Graphs select ownership and blocking; this module validates the
//! selected identities and atomically persists their concrete mutations.
use super::{RelayAuthority, WorkflowEvent};
use crate::dispatch::ActionPorts;
use crate::graph::{Decision, Graph, GraphInput};
use crate::lifecycle::apply_pure_task_actions;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

#[derive(Clone, Debug)]
pub struct TroubleshooterEscalationRequest {
    pub required_action: String,
    pub resolution_condition: String,
    pub context: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TroubleshooterEscalation {
    pub job_id: String,
    pub task_id: String,
    pub state: String,
    pub status: String,
    pub escalation: Value,
    pub duplicate: bool,
}

fn fingerprint(request: &TroubleshooterEscalationRequest, execution_id: Option<&str>) -> String {
    let bytes = serde_json::to_vec(&json!([
        request.required_action.trim(),
        request.resolution_condition.trim(),
        request.context.trim(),
        execution_id,
    ]))
    .expect("string tuple serializes");
    format!("{:x}", Sha256::digest(bytes))
}

fn task<'a>(job: &'a Value, task_id: &str) -> Option<&'a Value> {
    job.get("tasks")?
        .as_array()?
        .iter()
        .find(|task| task["id"] == task_id)
}

fn two_tasks_mut<'a>(
    job: &'a mut Value,
    first_id: &str,
    second_id: &str,
) -> Result<(&'a mut Value, &'a mut Value), String> {
    let tasks = job
        .get_mut("tasks")
        .and_then(Value::as_array_mut)
        .ok_or("Job Tasks missing")?;
    let first_index = tasks
        .iter()
        .position(|task| task["id"] == first_id)
        .ok_or("original Task missing during escalation")?;
    let second_index = tasks
        .iter()
        .position(|task| task["id"] == second_id)
        .ok_or("Troubleshooter Task missing during escalation")?;
    if first_index == second_index {
        return Err("original and Troubleshooter Task identities collide".into());
    }
    if first_index < second_index {
        let (before, after) = tasks.split_at_mut(second_index);
        Ok((&mut before[first_index], &mut after[0]))
    } else {
        let (before, after) = tasks.split_at_mut(first_index);
        Ok((&mut after[0], &mut before[second_index]))
    }
}

fn duplicate(job_id: &str, task_id: &str, recovery: &Value) -> Option<TroubleshooterEscalation> {
    let escalation = recovery.get("escalation")?.clone();
    Some(TroubleshooterEscalation {
        job_id: job_id.into(),
        task_id: task_id.into(),
        state: recovery["state"].as_str()?.into(),
        status: escalation["status"].as_str()?.into(),
        escalation,
        duplicate: true,
    })
}

fn blocked_transition(recovery: &mut Value, at: &str) -> Result<(), String> {
    let state = recovery["state"]
        .as_str()
        .ok_or("Troubleshooter state missing")?
        .to_owned();
    let event = match state.as_str() {
        "QUEUED" => "block",
        "RUNNING" | "FAILED" => "task.blocked",
        _ => return Err(format!("Troubleshooter cannot escalate from {state}")),
    };
    let graph = Graph::parse(include_str!("../../../workflow/task-lifecycle.mmd"))?;
    let decision = graph.decide(
        &state,
        GraphInput {
            transport: "event".into(),
            id: event.into(),
            payload: json!({"taskId":recovery["id"]}),
        },
        &HashMap::from([
            (
                "troubleshooterTask".into(),
                recovery["agentName"] == "troubleshooter",
            ),
            ("recoverableExecution".into(), true),
        ]),
    )?;
    let Decision::Accepted {
        target, actions, ..
    } = decision
    else {
        return Err("Task Lifecycle Graph rejected Troubleshooter escalation".into());
    };
    if target != "BLOCKED" {
        return Err("Task Lifecycle Graph selected unexpected escalation state".into());
    }
    apply_pure_task_actions(recovery, &actions)?;
    recovery["state"] = json!(target);
    recovery["leaseOwner"] = Value::Null;
    recovery["leaseExpiresAt"] = Value::Null;
    recovery["executionId"] = Value::Null;
    recovery["error"] = json!(format!(
        "Waiting for human action: {}",
        recovery["escalation"]["requiredAction"]
            .as_str()
            .unwrap_or("required action")
    ));
    recovery["failureReason"] = json!("human_action_required");
    recovery["updatedAt"] = json!(at);
    Ok(())
}

struct ResolutionEffect<'a> {
    original: &'a mut Value,
    recovery: &'a Value,
    request: &'a TroubleshooterEscalationRequest,
    at: &'a str,
}

impl ActionPorts for ResolutionEffect<'_> {
    fn persist_transition(&mut self, source: &str, target: &str) -> Result<(), String> {
        if source != "unresolved" || target != "resolved" {
            return Err("Task Resolution Graph selected unexpected durable states".into());
        }
        Ok(())
    }
    fn execute_action(&mut self, action_id: &str, _input: &GraphInput) -> Result<Value, String> {
        if action_id != "resolution.createEscalationGate" {
            return Err(format!("unexpected Task Resolution action {action_id}"));
        }
        self.original["resolution"] = json!({
            "path":"escalation_gate", "targetTaskId":self.original["id"],
            "rootCause":self.request.context.trim(), "solution":self.request.required_action.trim(),
            "state":"waiting", "owner":"troubleshooter", "updatedAt":self.at
        });
        if let Some(execution_id) = self.recovery["executionId"].as_str() {
            self.original["resolution"]["recoveryExecutionId"] = json!(execution_id);
        }
        self.original["updatedAt"] = json!(self.at);
        Ok(json!({"ok":true,"payloads":{}}))
    }
    fn publish_event(&mut self, event_id: &str, _payload: &Value) -> Result<(), String> {
        Err(format!("unexpected Task Resolution event {event_id}"))
    }
}

fn apply_resolution_graph(
    original: &mut Value,
    recovery: &Value,
    request: &TroubleshooterEscalationRequest,
    at: &str,
) -> Result<(), String> {
    if original["state"] != "FAILED"
        || original["executionId"].is_string()
        || original["leaseOwner"].is_string()
        || original["leaseExpiresAt"].is_string()
    {
        return Err("Escalation requires the exact original Task to be terminal FAILED".into());
    }
    let graph = Graph::parse(include_str!("../../../workflow/task-resolution.mmd"))?;
    let mut proposal = json!({
        "path":"escalation_gate", "targetTaskId":original["id"],
        "rootCause":request.context.trim(), "solution":request.required_action.trim()
    });
    if let Some(execution_id) = recovery["executionId"].as_str() {
        proposal["recoveryExecutionId"] = json!(execution_id);
    }
    let mut effect = ResolutionEffect {
        original,
        recovery,
        request,
        at,
    };
    let result = graph.dispatch_through_transient(
        "unresolved",
        GraphInput {
            transport: "event".into(),
            id: "resolution.propose".into(),
            payload: proposal.clone(),
        },
        &HashMap::from([
            ("recoveryOwnerAvailable".into(), true),
            ("plannerOwnerAvailable".into(), false),
            ("freshRecoveryExecution".into(), true),
            ("exactOriginalRetry".into(), false),
            ("sameJobDependency".into(), false),
            ("blockerJobDependency".into(), false),
            (
                "escalationGate".into(),
                !request.context.trim().is_empty() && !request.required_action.trim().is_empty(),
            ),
            ("genuinelyObsolete".into(), false),
        ]),
        |state| {
            matches!(
                state,
                "check_owner" | "check_path" | "check_fresh_execution"
            )
        },
        &mut effect,
    )?;
    let Decision::Accepted {
        target, actions, ..
    } = result.decision
    else {
        return Err("Task Resolution Graph rejected escalation ownership".into());
    };
    if target != "resolved"
        || actions.len() != 1
        || actions[0].id != "resolution.createEscalationGate"
    {
        return Err(format!("Task Resolution Graph selected unexpected escalation effect: target={target} actions={:?}", actions.iter().map(|action| action.id.as_str()).collect::<Vec<_>>()));
    }
    Ok(())
}

impl RelayAuthority {
    /// Block only the durable Troubleshooter recovery Task. The exact FAILED
    /// original receives Graph-selected escalation-gate ownership in the same
    /// SQLite snapshot transaction.
    pub fn request_troubleshooter_escalation(
        &mut self,
        job_id: &str,
        recovery_task_id: &str,
        request: &TroubleshooterEscalationRequest,
        at: &str,
    ) -> Result<TroubleshooterEscalation, String> {
        if request.required_action.trim().is_empty()
            || request.resolution_condition.trim().is_empty()
            || request.context.trim().is_empty()
        {
            return Err(
                "Escalation requires required action, resolution condition and diagnostic context"
                    .into(),
            );
        }
        let prior = self.read_job(job_id)?.ok_or("Escalation Job missing")?;
        if matches!(prior["state"].as_str(), Some("COMPLETED" | "CANCELLED")) {
            return Err("Escalation Job is terminal".into());
        }
        let recovery =
            task(&prior, recovery_task_id).ok_or("Troubleshooter recovery Task missing")?;
        if recovery["agentName"] != "troubleshooter" {
            return Err("Escalation target is not a Troubleshooter Task".into());
        }
        let original_id = recovery["parentTaskId"]
            .as_str()
            .ok_or("Troubleshooter original Task is missing")?;
        let original = task(&prior, original_id).ok_or("Troubleshooter original Task missing")?;
        if original["state"] != "FAILED" {
            return Err("Troubleshooter has no current FAILED original Task".into());
        }
        let execution_id = original["executionId"].as_str();
        let fingerprint = fingerprint(request, execution_id);
        if recovery["escalation"]["fingerprint"] == fingerprint {
            return duplicate(job_id, recovery_task_id, recovery)
                .ok_or("duplicate escalation record invalid".into());
        }
        if recovery["escalation"]["status"] == "pending" && recovery["state"] == "BLOCKED" {
            return duplicate(job_id, recovery_task_id, recovery)
                .ok_or("pending escalation record invalid".into());
        }
        if !matches!(
            recovery["state"].as_str(),
            Some("QUEUED" | "RUNNING" | "FAILED")
        ) {
            return Err(format!(
                "Troubleshooter cannot escalate from {}",
                recovery["state"].as_str().unwrap_or("unknown")
            ));
        }
        let now = at.to_owned();
        let escalation_id = uuid::Uuid::new_v4().to_string();
        let event_key = format!("escalation/{escalation_id}");
        let event = WorkflowEvent {
            key: event_key.clone(),
            event_id: event_key.clone(),
            payload: json!({"event_id":event_key,"type":"escalation.requested","job_id":job_id,
                "task_id":recovery_task_id,"status":"blocked","visibility":"user",
                "message":format!("Human action required: {}",request.required_action.trim()),
                "data":{"escalationId":escalation_id,"originalTaskId":original_id,
                    "requiredAction":request.required_action.trim(),"resolutionCondition":request.resolution_condition.trim(),"notificationStatus":"pending"},
                "source":{"component":"agents-relay","agent":"relay"}}),
        };
        let blocked_event_id = format!("task-blocked/{job_id}/{recovery_task_id}/{escalation_id}");
        let blocked_event = WorkflowEvent {
            key: blocked_event_id.clone(),
            event_id: blocked_event_id.clone(),
            payload: json!({"event_id":blocked_event_id,"type":"task.blocked","job_id":job_id,
                "task_id":recovery_task_id,"parent_task_id":original_id,"status":"blocked","visibility":"user",
                "message":format!("Human action required: {}",request.required_action.trim()),
                "data":{"escalationId":escalation_id,"originalTaskId":original_id},
                "source":{"component":"agents-relay","agent":"relay"}}),
        };
        let committed = self.commit_job_with_tx(job_id, &now, |_, current| {
            if current["state"] == "COMPLETED" || current["state"] == "CANCELLED" { return Err("Escalation Job became terminal".into()); }
            let mut next = current.clone();
            let (original, recovery) = two_tasks_mut(&mut next, original_id, recovery_task_id)?;
            if recovery["agentName"] != "troubleshooter" || recovery["parentTaskId"] != original_id { return Err("Troubleshooter parent identity changed".into()); }
            if recovery["escalation"]["fingerprint"] == fingerprint || recovery["escalation"]["status"] == "pending" && recovery["state"] == "BLOCKED" {
                return Err("escalation duplicate race".into());
            }
            apply_resolution_graph(original, recovery, request, &now)?;
            let mut record = json!({"id":escalation_id,"originalTaskId":original_id,"fingerprint":fingerprint,
                "requiredAction":request.required_action.trim(),"resolutionCondition":request.resolution_condition.trim(),
                "context":request.context.trim(),"status":"pending","requestedAt":now,
                "notification":{"status":"pending","channel":"relay-event","requestedAt":now}});
            if let Some(execution_id) = execution_id { record["originalExecutionId"] = json!(execution_id); }
            if let Some(execution_id) = recovery["executionId"].as_str() { record["recoveryExecutionId"] = json!(execution_id); }
            recovery["escalation"] = record;
            blocked_transition(recovery, &now)?;
            next["updatedAt"] = json!(now);
            Ok((next, vec![event.clone(), blocked_event.clone()]))
        });
        let committed = match committed {
            Ok(committed) => committed,
            Err(error) if error == "escalation duplicate race" => {
                let current = self
                    .read_job(job_id)?
                    .ok_or("Escalation Job missing after race")?;
                let recovery =
                    task(&current, recovery_task_id).ok_or("Troubleshooter missing after race")?;
                if recovery["escalation"]["fingerprint"] == fingerprint
                    || recovery["escalation"]["status"] == "pending"
                        && recovery["state"] == "BLOCKED"
                {
                    return duplicate(job_id, recovery_task_id, recovery)
                        .ok_or("duplicate escalation record invalid".into());
                }
                return Err(error);
            }
            Err(error) => return Err(error),
        };
        let recovery = task(&committed.job, recovery_task_id)
            .ok_or("Troubleshooter missing after escalation")?;
        Ok(TroubleshooterEscalation {
            job_id: job_id.into(),
            task_id: recovery_task_id.into(),
            state: recovery["state"].as_str().unwrap_or_default().into(),
            status: recovery["escalation"]["status"]
                .as_str()
                .unwrap_or_default()
                .into(),
            escalation: recovery["escalation"].clone(),
            duplicate: false,
        })
    }

    /// Record an authorized human response on a pending escalation and queue
    /// the same Troubleshooter Task through Task Lifecycle.
    pub fn resume_troubleshooter_escalation(
        &mut self,
        job_id: &str,
        recovery_task_id: &str,
        response: &str,
        at: &str,
    ) -> Result<TroubleshooterEscalation, String> {
        if response.trim().is_empty() {
            return Err("Troubleshooter response is required".into());
        }
        let now = at.to_owned();
        let current = self.read_job(job_id)?.ok_or("Troubleshooter Job missing")?;
        let current_task = task(&current, recovery_task_id).ok_or("Troubleshooter Task missing")?;
        let escalation_id = current_task["escalation"]["id"]
            .as_str()
            .ok_or("Escalation ID missing")?
            .to_owned();
        let original_task_id = current_task["parentTaskId"]
            .as_str()
            .ok_or("Original Task ID missing")?
            .to_owned();
        let event_id = format!("task-unblocked/{job_id}/{recovery_task_id}/{escalation_id}");
        let event = WorkflowEvent {
            key: event_id.clone(),
            event_id: event_id.clone(),
            payload: json!({
            "event_id":event_id,"type":"task.unblocked","job_id":job_id,"task_id":recovery_task_id,
            "parent_task_id":original_task_id,"status":"queued","visibility":"orchestrator",
            "message":"Human response recorded","data":{"escalationId":escalation_id},
            "source":{"component":"agents-relay","agent":"relay"}}),
        };
        let committed = self.commit_job(job_id, &now, |current| {
            let mut next = current.clone();
            let recovery = next["tasks"]
                .as_array_mut()
                .and_then(|items| items.iter_mut().find(|item| item["id"] == recovery_task_id))
                .ok_or("Troubleshooter Task missing")?;
            if recovery["agentName"] != "troubleshooter"
                || recovery["escalation"]["status"] != "pending"
                || recovery["state"] != "BLOCKED"
            {
                return Err("Task is not a blocked pending Troubleshooter escalation".into());
            }
            let graph = Graph::parse(include_str!("../../../workflow/task-lifecycle.mmd"))?;
            let decision = graph.decide(
                "BLOCKED",
                GraphInput {
                    transport: "event".into(),
                    id: "task.unblocked".into(),
                    payload: json!({"taskId":recovery_task_id}),
                },
                &HashMap::from([("troubleshooterTask".into(), true)]),
            )?;
            let Decision::Accepted {
                target, actions, ..
            } = decision
            else {
                return Err("Task Lifecycle Graph rejected Troubleshooter response".into());
            };
            if target != "QUEUED" {
                return Err("Task Lifecycle Graph selected unexpected response state".into());
            }
            apply_pure_task_actions(recovery, &actions)?;
            recovery["escalation"]["status"] = json!("responded");
            recovery["escalation"]["response"] = json!(response.trim());
            recovery["escalation"]["respondedAt"] = json!(now);
            recovery["result"] = Value::Null;
            recovery["error"] = Value::Null;
            recovery["leaseOwner"] = Value::Null;
            recovery["leaseExpiresAt"] = Value::Null;
            recovery["executionId"] = Value::Null;
            recovery["state"] = json!(target);
            recovery["updatedAt"] = json!(now);
            next["updatedAt"] = json!(now);
            Ok((next, vec![event.clone()]))
        })?;
        let recovery = task(&committed.job, recovery_task_id)
            .ok_or("Troubleshooter missing after response")?;
        Ok(TroubleshooterEscalation {
            job_id: job_id.into(),
            task_id: recovery_task_id.into(),
            state: recovery["state"].as_str().unwrap_or_default().into(),
            status: recovery["escalation"]["status"]
                .as_str()
                .unwrap_or_default()
                .into(),
            escalation: recovery["escalation"].clone(),
            duplicate: false,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use tempfile::tempdir;

    const T0: &str = "2026-11-15T13:00:00.000Z";

    fn fixture() -> (tempfile::TempDir, std::path::PathBuf, RelayAuthority) {
        let root = tempdir().unwrap();
        let db = root.path().join("relay.sqlite");
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch("CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL);").unwrap();
        let job = json!({"id":"91","repository":"example","state":"ACTIVE","updatedAt":T0,
        "tasks":[
            {"jobId":"91","id":"original","kind":"work","agentName":"implementation","state":"FAILED","attempt":2,
             "executionId":null,"leaseOwner":null,"leaseExpiresAt":null,"executionHistory":[{"id":"failed-exec","attempt":1}],
             "failureReason":"timeout","error":"worker timed out","resolution":null,"updatedAt":T0},
            {"jobId":"91","id":"recovery","kind":"work","agentName":"troubleshooter","parentTaskId":"original","state":"RUNNING","attempt":1,
             "executionId":"recovery-exec","leaseOwner":"worker","leaseExpiresAt":"2026-11-15T13:30:00.000Z",
             "executionHistory":[{"id":"recovery-exec","attempt":1}],"error":null,"failureReason":null,"result":null,"updatedAt":T0}
        ]});
        conn.execute(
            "INSERT INTO job_snapshot(job_id,json,updated_at) VALUES('91',?1,?2)",
            rusqlite::params![serde_json::to_string(&job).unwrap(), T0],
        )
        .unwrap();
        drop(conn);
        let authority = RelayAuthority::open_existing(&db).unwrap();
        (root, db, authority)
    }

    fn request() -> TroubleshooterEscalationRequest {
        TroubleshooterEscalationRequest {
            required_action: "confirm owner decision".into(),
            resolution_condition: "owner response is recorded".into(),
            context: "exact failed execution was diagnosed".into(),
        }
    }

    #[test]
    fn escalation_blocks_only_troubleshooter_and_resumes_same_task_after_restart() {
        let (_root, db, mut authority) = fixture();
        let result = authority
            .request_troubleshooter_escalation(
                "91",
                "recovery",
                &request(),
                "2026-11-15T13:00:00.001Z",
            )
            .unwrap();
        assert!(!result.duplicate);
        assert_eq!(result.state, "BLOCKED");
        assert_eq!(result.status, "pending");
        assert_eq!(
            result.escalation["fingerprint"],
            "5ab78439578f4b2b20c9562e94061393274e2baa1eab6ff8e4d014ba7fb88c52"
        );
        let job = authority.read_job("91").unwrap().unwrap();
        assert_eq!(task(&job, "original").unwrap()["state"], "FAILED");
        assert_eq!(
            task(&job, "original").unwrap()["resolution"]["path"],
            "escalation_gate"
        );
        assert_eq!(task(&job, "recovery").unwrap()["state"], "BLOCKED");
        assert_eq!(job["updatedAt"], "2026-11-15T13:00:00.001Z");
        let initial_events = authority.pending_events().unwrap();
        assert_eq!(initial_events.len(), 2);
        assert!(initial_events
            .iter()
            .any(|event| event.payload["type"] == "escalation.requested"));
        assert!(initial_events
            .iter()
            .any(|event| event.payload["type"] == "task.blocked"));
        drop(authority);
        let mut restarted = RelayAuthority::open_existing(&db).unwrap();
        let duplicate = restarted
            .request_troubleshooter_escalation(
                "91",
                "recovery",
                &request(),
                "2026-11-15T13:00:00.002Z",
            )
            .unwrap();
        assert!(duplicate.duplicate);
        assert_eq!(duplicate.escalation["id"], result.escalation["id"]);
        assert_eq!(
            restarted.read_job("91").unwrap().unwrap()["updatedAt"],
            "2026-11-15T13:00:00.001Z"
        );
        let resumed = restarted
            .resume_troubleshooter_escalation(
                "91",
                "recovery",
                "confirmed",
                "2026-11-15T13:00:00.003Z",
            )
            .unwrap();
        assert_eq!(resumed.state, "QUEUED");
        assert_eq!(resumed.status, "responded");
        assert_eq!(resumed.escalation["response"], "confirmed");
        assert_eq!(
            restarted.read_job("91").unwrap().unwrap()["tasks"][1]["id"],
            "recovery"
        );
        assert!(restarted
            .pending_events()
            .unwrap()
            .iter()
            .any(|event| event.payload["type"] == "task.unblocked"));
    }

    #[test]
    fn escalation_rejects_wrong_lineage_and_non_pending_responses() {
        let (_root, _db, mut authority) = fixture();
        assert!(authority
            .request_troubleshooter_escalation(
                "91",
                "original",
                &request(),
                "2026-11-15T13:00:00.001Z",
            )
            .is_err());
        assert!(authority
            .resume_troubleshooter_escalation(
                "91",
                "recovery",
                "confirmed",
                "2026-11-15T13:00:00.001Z",
            )
            .is_err());
        assert!(authority
            .request_troubleshooter_escalation(
                "91",
                "recovery",
                &TroubleshooterEscalationRequest {
                    required_action: " ".into(),
                    resolution_condition: "condition".into(),
                    context: "diagnosis".into(),
                },
                "2026-11-15T13:00:00.001Z",
            )
            .is_err());
    }
}
