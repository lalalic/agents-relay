//! Persist Graph-selected dependency transitions inside the same SQLite
//! transaction that reads their predecessor states. Reconciler contains no
//! independent state machine and never touches Review-scoped revisions.
use super::RelayAuthority;
use crate::graph::Graph;
use crate::lifecycle::apply_pure_task_actions;
use crate::reconcile::{propose_dependency_transitions, TaskProposal};
use serde_json::{json, Value};

fn effective_proposals(job: &Value, graph: &Graph) -> Result<Vec<TaskProposal>, String> {
    let proposals = propose_dependency_transitions(job, graph)?;
    let tasks = job
        .get("tasks")
        .and_then(Value::as_array)
        .ok_or("Job Tasks missing")?;
    let mut changed = vec![];
    for proposal in proposals {
        let task = tasks
            .iter()
            .find(|task| task["id"] == proposal.task_id)
            .ok_or("Graph proposal Task missing")?;
        let mut next = task.clone();
        apply_pure_task_actions(&mut next, &proposal.actions)?;
        if proposal.source != proposal.target || next != *task {
            changed.push(proposal);
        }
    }
    Ok(changed)
}

impl RelayAuthority {
    pub fn reconcile_native_dependencies(
        &mut self,
        job_id: &str,
        at: &str,
    ) -> Result<Vec<String>, String> {
        let graph = Graph::parse(include_str!("../../../workflow/task-lifecycle.mmd"))?;
        let prior = self.read_job(job_id)?.ok_or("dependency Job not found")?;
        if prior["state"] != "ACTIVE" || prior.get("pause").is_some_and(|v| !v.is_null()) {
            return Ok(vec![]);
        }
        if effective_proposals(&prior, &graph)?.is_empty() {
            return Ok(vec![]);
        }
        let mut changed = vec![];
        let commit = self.commit_job_with_tx(job_id, at, |_, current| {
            if current["state"] != "ACTIVE" || current.get("pause").is_some_and(|v| !v.is_null()) {
                return Err("dependency Job changed before Graph reconcile".into());
            }
            let proposals = effective_proposals(current, &graph)?;
            if proposals.is_empty() {
                return Err("native-dependency-noop-after-concurrent-tick".into());
            }
            let mut next = current.clone();
            for proposal in proposals {
                if proposal.source == proposal.target && proposal.actions.is_empty() {
                    continue;
                }
                let entry = next
                    .get_mut("tasks")
                    .and_then(Value::as_array_mut)
                    .and_then(|items| items.iter_mut().find(|task| task["id"] == proposal.task_id))
                    .ok_or("dependency Task disappeared")?;
                apply_pure_task_actions(entry, &proposal.actions)?;
                entry["state"] = json!(proposal.target);
                entry["updatedAt"] = json!(at);
                changed.push(proposal.task_id);
            }
            next["updatedAt"] = json!(at);
            Ok((next, vec![]))
        });
        match commit {
            Ok(_) => Ok(changed),
            Err(error) if error == "native-dependency-noop-after-concurrent-tick" => Ok(vec![]),
            Err(error) => Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authority::tests::setup;
    #[test]
    fn canonical_dependency_queue_is_atomic_and_idempotent() {
        let (_dir, path) = setup();
        let mut authority = RelayAuthority::open_existing(&path).unwrap();
        authority
            .commit_job("91", "2026-11-13T20:00:01.000Z", |old| {
                let mut new = old.clone();
                new["updatedAt"] = json!("2026-11-13T20:00:01.000Z");
                new["tasks"] = json!([
                    {"id":"101","state":"SUCCEEDED","dependencies":[]},
                    {"id":"102","state":"DRAFT","dependencies":["101"]},
                    {"id":"103","state":"DRAFT","dependencies":["999"]}
                ]);
                Ok((new, vec![]))
            })
            .unwrap();
        let changed = authority
            .reconcile_native_dependencies("91", "2026-11-13T20:00:02.000Z")
            .unwrap();
        assert_eq!(changed, vec!["102"]);
        assert_eq!(
            authority.read_job("91").unwrap().unwrap()["tasks"][1]["state"],
            "QUEUED"
        );
        assert!(authority
            .reconcile_native_dependencies("91", "2026-11-13T20:00:03.000Z")
            .unwrap()
            .is_empty());
    }
}
