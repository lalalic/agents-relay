//! Graph-authorized Task state execution using Rust's atomic SQLite writer.
//! Every workflow choice comes from the canonical Mermaid Graph. This module
//! implements only side-effect-free mutation primitives; unknown effects fail.
use crate::authority::{CommittedJob, RelayAuthority, WorkflowEvent};
use crate::graph::{Decision, Graph, GraphInput};
use serde_json::Value;
use std::collections::HashMap;

/// Concrete Graph-selected Task mutations shared by lifecycle and DAG
/// checkpoint paths. Unknown effects are rejected, never acknowledged.
pub(crate) fn apply_pure_task_actions(
    task: &mut Value,
    actions: &[crate::graph::ActionDecision],
) -> Result<(), String> {
    for action in actions {
        match action.id.as_str() {
            "mutation.clearError" => task["error"] = Value::Null,
            "mutation.clearFailureReason" => {
                if let Some(fields) = task.as_object_mut() {
                    fields.shift_remove("failureReason");
                }
            }
            other => return Err(format!("unimplemented Rust Task Action '{other}'")),
        }
    }
    Ok(())
}
pub struct TaskTransition<'a> {
    pub job_id: &'a str,
    pub task_id: &'a str,
    pub input: GraphInput,
    pub guard_facts: &'a HashMap<String, bool>,
    pub at: &'a str,
    pub events: Vec<WorkflowEvent>,
}
pub struct TaskLifecycle<'g> {
    graph: &'g Graph,
}
impl<'g> TaskLifecycle<'g> {
    pub fn new(graph: &'g Graph) -> Self {
        Self { graph }
    }
    pub fn apply(
        &self,
        store: &mut RelayAuthority,
        request: TaskTransition<'_>,
    ) -> Result<(CommittedJob, Decision), String> {
        let TaskTransition {
            job_id,
            task_id,
            input,
            guard_facts,
            at,
            events,
        } = request;
        // Evaluate inside SQLite's IMMEDIATE transaction, not against a stale
        // read from before the lock. A competing reconciler cannot race us.
        let mut decision = None;
        let committed = store.commit_job(job_id, at, |job| {
            let mut next = job.clone();
            let task = next
                .get_mut("tasks")
                .and_then(Value::as_array_mut)
                .and_then(|tasks| {
                    tasks
                        .iter_mut()
                        .find(|task| task.get("id").and_then(Value::as_str) == Some(task_id))
                })
                .ok_or_else(|| format!("Unknown Task '{task_id}' in Job '{job_id}'"))?;
            let state = task
                .get("state")
                .and_then(Value::as_str)
                .ok_or("Task state is missing")?
                .to_owned();
            // The executor may never claim completion using another execution
            // generation or omit an identity on an in-flight Task.
            if !input.payload.is_object() {
                return Err("Task event payload must be object".into());
            }
            let expected = task.get("executionId").and_then(Value::as_str);
            let provided = input.payload.get("executionId").and_then(Value::as_str);
            if expected.is_some() && expected != provided {
                return Err("stale or missing Task executionId".into());
            }
            if let Some(event_task) = input.payload.get("taskId").and_then(Value::as_str) {
                if event_task != task_id {
                    return Err("event Task identity mismatch".into());
                }
            }
            if let Some(owner) = input.payload.get("leaseOwner").and_then(Value::as_str) {
                if task.get("leaseOwner").and_then(Value::as_str) != Some(owner) {
                    return Err("Task lease owner mismatch".into());
                }
            }
            if let Some(attempt) = input.payload.get("attempt").and_then(Value::as_i64) {
                if task.get("attempt").and_then(Value::as_i64) != Some(attempt) {
                    return Err("Task attempt generation mismatch".into());
                }
            }
            let graph_decision = self.graph.decide(&state, input.clone(), guard_facts)?;
            let Decision::Accepted {
                target, actions, ..
            } = &graph_decision
            else {
                return Err(format!(
                    "Graph denied Task transition {state} on {}",
                    input.id
                ));
            };
            apply_pure_task_actions(task, actions)?;
            task["state"] = Value::String(target.clone());
            task["updatedAt"] = Value::String(at.into());
            next["updatedAt"] = Value::String(at.into());
            decision = Some(graph_decision);
            Ok((next, events))
        })?;
        Ok((
            committed,
            decision.expect("successful transition sets decision"),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authority::tests::setup;
    use serde_json::json;
    fn graph() -> Graph {
        Graph::parse(include_str!("../../workflow/task-lifecycle.mmd")).unwrap()
    }
    fn input(id: &str, execution_id: Option<&str>) -> GraphInput {
        let mut payload = json!({"taskId":"101"});
        if let Some(id) = execution_id {
            payload["executionId"] = json!(id);
        }
        GraphInput {
            transport: "event".into(),
            id: id.into(),
            payload,
        }
    }
    fn apply(
        engine: &TaskLifecycle<'_>,
        store: &mut RelayAuthority,
        input: GraphInput,
        guards: HashMap<String, bool>,
        at: &str,
    ) -> Result<(CommittedJob, Decision), String> {
        engine.apply(
            store,
            TaskTransition {
                job_id: "91",
                task_id: "101",
                input,
                guard_facts: &guards,
                at,
                events: vec![],
            },
        )
    }
    #[test]
    fn canonical_task_lifecycle_runs_through_atomic_sqlite_and_rejects_stale_completion() {
        let (_dir, path) = setup();
        let mut store = RelayAuthority::open_existing(&path).unwrap();
        store
            .commit_job("91", "2026-11-13T20:00:01Z", |job| {
                let mut next = job.clone();
                next["updatedAt"] = json!("2026-11-13T20:00:01Z");
                next["tasks"][0]["state"] = json!("DRAFT");
                Ok((next, vec![]))
            })
            .unwrap();
        let graph = graph();
        let engine = TaskLifecycle::new(&graph);
        let (released, decision) = apply(
            &engine,
            &mut store,
            input("release", None),
            HashMap::new(),
            "2026-11-13T20:00:02Z",
        )
        .unwrap();
        assert_eq!(released.job["tasks"][0]["state"], "QUEUED");
        assert!(matches!(decision,Decision::Accepted{target,..} if target=="QUEUED"));
        store
            .commit_job("91", "2026-11-13T20:00:03Z", |job| {
                let mut next = job.clone();
                next["updatedAt"] = json!("2026-11-13T20:00:03Z");
                next["tasks"][0]["executionId"] = json!("ex-1");
                next["tasks"][0]["leaseOwner"] = json!("relayd-123");
                next["tasks"][0]["attempt"] = json!(1);
                next["tasks"][0]["leaseExpiresAt"] = json!("2099-01-01T00:00:00Z");
                Ok((next, vec![]))
            })
            .unwrap();
        assert!(apply(
            &engine,
            &mut store,
            input("task.started", Some("wrong")),
            HashMap::new(),
            "2026-11-13T20:00:04Z"
        )
        .unwrap_err()
        .contains("executionId"));
        let (started, _) = apply(
            &engine,
            &mut store,
            input("task.started", Some("ex-1")),
            HashMap::new(),
            "2026-11-13T20:00:04Z",
        )
        .unwrap();
        assert_eq!(started.job["tasks"][0]["state"], "RUNNING");
        assert!(apply(
            &engine,
            &mut store,
            input("task.completed", Some("wrong")),
            HashMap::new(),
            "2026-11-13T20:00:05Z"
        )
        .is_err());
        let (finished, _) = apply(
            &engine,
            &mut store,
            input("task.completed", Some("ex-1")),
            HashMap::new(),
            "2026-11-13T20:00:05Z",
        )
        .unwrap();
        assert_eq!(finished.job["tasks"][0]["state"], "SUCCEEDED");
        assert!(apply(
            &engine,
            &mut store,
            input("task.completed", Some("ex-1")),
            HashMap::new(),
            "2026-11-13T20:00:06Z"
        )
        .is_err());
        assert_eq!(
            store.read_job("91").unwrap().unwrap()["tasks"][0]["state"],
            "SUCCEEDED"
        );
    }
    #[test]
    fn launch_effect_is_not_implicitly_acknowledged() {
        let (_dir, path) = setup();
        let mut store = RelayAuthority::open_existing(&path).unwrap();
        let graph = graph();
        let engine = TaskLifecycle::new(&graph);
        let initial = store.read_job("91").unwrap().unwrap();
        assert!(apply(
            &engine,
            &mut store,
            input("dispatch", None),
            HashMap::from([("dispatchable".into(), true)]),
            "2026-11-13T20:00:01Z"
        )
        .unwrap_err()
        .contains("effect.launchTask"));
        assert_eq!(store.read_job("91").unwrap().unwrap(), initial);
    }
}
