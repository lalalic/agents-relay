//! Pure Graph-driven dependency reconciliation proposals. No hidden
//! scheduler, worker launches, or state writes. The authoritative Graph still
//! chooses every state transition; callers must recheck facts under SQLite.
use crate::graph::{ActionDecision, Decision, Graph, GraphInput};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskProposal {
    pub task_id: String,
    pub source: String,
    pub target: String,
    pub actions: Vec<ActionDecision>,
}
fn visit(
    id: &str,
    tasks: &HashMap<String, &Value>,
    visiting: &mut HashSet<String>,
    done: &mut HashSet<String>,
) -> Result<(), String> {
    if done.contains(id) {
        return Ok(());
    }
    if !visiting.insert(id.to_owned()) {
        return Err(format!("Dependency cycle at {id}"));
    }
    if let Some(task) = tasks.get(id) {
        for dependency in task
            .get("dependencies")
            .and_then(Value::as_array)
            .ok_or("invalid dependencies")?
        {
            let dep = dependency.as_str().ok_or("invalid dependency Task ID")?;
            visit(dep, tasks, visiting, done)?;
        }
    }
    visiting.remove(id);
    done.insert(id.to_owned());
    Ok(())
}

pub fn propose_dependency_transitions(
    job: &Value,
    graph: &Graph,
) -> Result<Vec<TaskProposal>, String> {
    if job.get("pause").is_some_and(|p| !p.is_null()) {
        return Ok(vec![]);
    }
    let tasks = job
        .get("tasks")
        .and_then(Value::as_array)
        .ok_or("Job tasks missing")?;
    let mut by_id = HashMap::new();
    for task in tasks {
        let id = task
            .get("id")
            .and_then(Value::as_str)
            .ok_or("Task ID missing")?;
        if by_id.insert(id.to_owned(), task).is_some() {
            return Err(format!("duplicate Task ID {id}"));
        }
    }
    let mut visiting = HashSet::new();
    let mut done = HashSet::new();
    for id in by_id.keys() {
        visit(id, &by_id, &mut visiting, &mut done)?;
    }
    let mut proposals = Vec::new();
    for task in tasks {
        if task.get("kind").and_then(Value::as_str) == Some("planner") {
            continue;
        }
        let id = task["id"].as_str().ok_or("Task ID missing")?;
        let state = task
            .get("state")
            .and_then(Value::as_str)
            .ok_or("Task state missing")?;
        if state == "DRAFT"
            && task
                .get("unblock")
                .is_some_and(|p| !p.is_null() && p != &Value::Bool(false))
        {
            continue;
        }
        // Review revisions have additional immutable eligibility constraints.
        // Until ported from revisionRequestReady, do not make a speculative
        // reconciler decision for any revision-scoped Task.
        if task.get("revisionRequest").is_some_and(|v| !v.is_null()) {
            return Err(format!(
                "revision eligibility not implemented for Task {id}"
            ));
        }
        let deps = task
            .get("dependencies")
            .and_then(Value::as_array)
            .ok_or("Task dependencies missing")?;
        let ready = deps.iter().all(|dependency| {
            dependency
                .as_str()
                .and_then(|dep| by_id.get(dep))
                .and_then(|item| item.get("state"))
                .and_then(Value::as_str)
                == Some("SUCCEEDED")
        });
        let guards = HashMap::from([
            (
                "dependenciesSatisfied".to_string(),
                !deps.is_empty() && ready,
            ),
            (
                "dependenciesUnsatisfied".to_string(),
                !deps.is_empty() && !ready,
            ),
            ("runnable".to_string(), ready),
        ]);
        let decision = graph.decide(
            state,
            GraphInput {
                transport: "event".into(),
                id: "reconcile".into(),
                payload: json!({}),
            },
            &guards,
        )?;
        if let Decision::Accepted {
            source,
            target,
            actions,
            ..
        } = decision
        {
            if source != target || !actions.is_empty() {
                proposals.push(TaskProposal {
                    task_id: id.to_owned(),
                    source,
                    target,
                    actions,
                });
            }
        }
    }
    Ok(proposals)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn graph() -> Graph {
        Graph::parse(include_str!("../../workflow/task-lifecycle.mmd")).unwrap()
    }
    #[test]
    fn graph_dependency_proposals_and_cycle_detection() {
        let job = json!({"id":"1","tasks":[
            {"id":"1","state":"SUCCEEDED","dependencies":[]},
            {"id":"2","state":"DRAFT","dependencies":["1"]},
            {"id":"3","state":"QUEUED","dependencies":["2"]},
            {"id":"4","state":"DRAFT","dependencies":[]}
        ]});
        let proposals = propose_dependency_transitions(&job, &graph()).unwrap();
        assert!(proposals
            .iter()
            .any(|p| p.task_id == "2" && p.source == "DRAFT" && p.target == "QUEUED"));
        assert!(proposals
            .iter()
            .any(|p| p.task_id == "3" && p.source == "QUEUED" && p.target == "DRAFT"));
        assert!(!proposals.iter().any(|p| p.task_id == "4"));
        let mut paused = job.clone();
        paused["pause"] = json!({"generation":1});
        assert!(propose_dependency_transitions(&paused, &graph())
            .unwrap()
            .is_empty());
        let cyclic = json!({"tasks":[{"id":"1","state":"DRAFT","dependencies":["2"]},
            {"id":"2","state":"DRAFT","dependencies":["1"]}]});
        assert!(propose_dependency_transitions(&cyclic, &graph())
            .unwrap_err()
            .contains("Dependency cycle"));
    }
}
