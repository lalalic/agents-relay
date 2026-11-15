//! Persist Graph-selected dependency transitions inside the same SQLite
//! transaction that reads their predecessor states. Reconciler contains no
//! independent state machine and never touches Review-scoped revisions.
use super::ids::{allocate_entity_id_in_tx, EntityKind};
use super::RelayAuthority;
use crate::dispatch::ActionPorts;
use crate::graph::{Graph, GraphInput};
use crate::lifecycle::apply_pure_task_actions;
use crate::reconcile::{propose_dependency_transitions, TaskProposal};
use rusqlite::Transaction;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};

const REVISION_GRAPH: &str = include_str!("../../../workflow/dependency-revision.mmd");
const TASK_GRAPH: &str = include_str!("../../../workflow/task-lifecycle.mmd");

fn revision_of(task: &Value) -> Option<&Value> {
    task.get("revision").filter(|revision| !revision.is_null())
}

fn latest_revision<'a>(tasks: &'a [Value], original_id: &str) -> Option<&'a Value> {
    tasks
        .iter()
        .filter(|task| {
            task["state"] == "SUCCEEDED"
                && revision_of(task).and_then(|r| r["originalTaskId"].as_str()) == Some(original_id)
        })
        .max_by(|a, b| {
            a["createdAt"]
                .as_str()
                .cmp(&b["createdAt"].as_str())
                .then_with(|| a["id"].as_str().cmp(&b["id"].as_str()))
        })
}

fn validity<'a>(task: &'a Value, dependency_id: &str) -> Result<&'a str, String> {
    if !task["dependencies"]
        .as_array()
        .is_some_and(|deps| deps.iter().any(|item| item.as_str() == Some(dependency_id)))
    {
        return Err(format!(
            "dependency validity names undeclared Task {dependency_id}"
        ));
    }
    match task
        .get("dependencyValidity")
        .and_then(|v| v.get(dependency_id))
        .and_then(Value::as_str)
        .unwrap_or("order-only")
    {
        value @ ("order-only" | "revalidate" | "rerun") => Ok(value),
        _ => Err(format!(
            "invalid dependency validity for Task {dependency_id}"
        )),
    }
}

fn validate_policies(task: &Value) -> Result<(), String> {
    let dependencies = task["dependencies"]
        .as_array()
        .ok_or("Task dependencies missing")?
        .iter()
        .map(|value| value.as_str().ok_or("invalid dependency Task ID"))
        .collect::<Result<Vec<_>, _>>()?;
    if dependencies.iter().copied().collect::<HashSet<_>>().len() != dependencies.len() {
        return Err("duplicate dependency Task ID".into());
    }
    if let Some(value) = task
        .get("dependencyValidity")
        .filter(|value| !value.is_null())
    {
        let policies = value
            .as_object()
            .ok_or("dependencyValidity must be an object")?;
        for (id, policy) in policies {
            if !dependencies.contains(&id.as_str()) {
                return Err(format!(
                    "dependencyValidity key {id} must identify a declared dependency"
                ));
            }
            if !matches!(policy.as_str(), Some("order-only" | "revalidate" | "rerun")) {
                return Err(format!("invalid dependencyValidity policy for Task {id}"));
            }
        }
    }
    Ok(())
}

fn evidence_vector(job: &Value, task: &Value) -> Result<BTreeMap<String, String>, String> {
    let tasks = job["tasks"].as_array().ok_or("Job tasks missing")?;
    let mut deps = task["dependencies"]
        .as_array()
        .ok_or("Task dependencies missing")?
        .iter()
        .map(|v| {
            v.as_str()
                .map(str::to_owned)
                .ok_or("invalid dependency Task ID")
        })
        .collect::<Result<Vec<_>, _>>()?;
    deps.sort();
    deps.dedup();
    let mut vector = BTreeMap::new();
    for id in deps {
        if validity(task, &id)? == "order-only" {
            continue;
        }
        let original = tasks
            .iter()
            .find(|item| item["id"] == id)
            .ok_or_else(|| format!("missing dependency Task {id}"))?;
        let selected = latest_revision(tasks, &id).unwrap_or(original);
        if selected["state"] != "SUCCEEDED" {
            return Err(format!(
                "dependency Task {id} has no settled successful evidence"
            ));
        }
        let selected_id = selected["id"]
            .as_str()
            .ok_or("dependency Task ID missing")?;
        let attempt = selected["attempt"].as_i64().unwrap_or(0);
        vector.insert(id, format!("{selected_id}:{attempt}"));
    }
    Ok(vector)
}

fn vector_matches(a: &Value, b: &BTreeMap<String, String>) -> bool {
    a.as_object().is_some_and(|map| {
        map.len() == b.len()
            && b.iter()
                .all(|(key, value)| map.get(key).and_then(Value::as_str) == Some(value))
    })
}

pub(crate) fn dependency_revision_still_current(job: &Value, task: &Value) -> bool {
    let Some(revision) = revision_of(task) else {
        return true;
    };
    if !matches!(revision["kind"].as_str(), Some("rerun" | "revalidate")) {
        return true;
    }
    let Some(original_id) = revision["originalTaskId"].as_str() else {
        return false;
    };
    let Some(original) = job["tasks"]
        .as_array()
        .and_then(|tasks| tasks.iter().find(|item| item["id"] == original_id))
    else {
        return false;
    };
    if validate_policies(original).is_err() {
        return false;
    }
    let Ok(current) = evidence_vector(job, original) else {
        return false;
    };
    if !vector_matches(&revision["dependencyVector"], &current) {
        return false;
    }
    if job["tasks"].as_array().is_some_and(|tasks| {
        tasks.iter().any(|candidate| {
            candidate["id"] != task["id"]
                && revision_of(candidate).and_then(|r| r["originalTaskId"].as_str())
                    == Some(original_id)
                && !matches!(candidate["state"].as_str(), Some("SUCCEEDED" | "CANCELLED"))
        })
    }) {
        return false;
    }
    let Some(dependencies) = original["dependencies"].as_array() else {
        return false;
    };
    dependencies
        .iter()
        .filter_map(Value::as_str)
        .filter(|id| validity(original, id).is_ok_and(|p| p != "order-only"))
        .all(|owner| {
            !job["tasks"].as_array().is_some_and(|tasks| {
                tasks.iter().any(|candidate| {
                    revision_of(candidate).and_then(|r| r["originalTaskId"].as_str()) == Some(owner)
                        && !matches!(candidate["state"].as_str(), Some("SUCCEEDED" | "CANCELLED"))
                })
            })
        })
}

struct RevisionEffect<'a, 'db> {
    tx: &'a Transaction<'db>,
    job: &'a mut Value,
    original_id: &'a str,
    vector: &'a BTreeMap<String, String>,
    at: &'a str,
}

struct TaskStateEffect<'a> {
    task: &'a mut Value,
    at: &'a str,
}
impl ActionPorts for TaskStateEffect<'_> {
    fn persist_transition(&mut self, _source: &str, target: &str) -> Result<(), String> {
        self.task["state"] = json!(target);
        self.task["updatedAt"] = json!(self.at);
        Ok(())
    }
    fn execute_action(&mut self, action: &str, input: &GraphInput) -> Result<Value, String> {
        apply_pure_task_actions(
            self.task,
            &[crate::graph::ActionDecision {
                id: action.to_owned(),
                input: input.clone(),
                emitted_events: vec![],
            }],
        )?;
        Ok(json!({"ok":true,"payloads":{}}))
    }
    fn publish_event(&mut self, event: &str, _payload: &Value) -> Result<(), String> {
        Err(format!("unexpected dependency Task event {event}"))
    }
}

struct StaleRevisionEffect<'a> {
    task: &'a mut Value,
    at: &'a str,
}
impl ActionPorts for StaleRevisionEffect<'_> {
    fn persist_transition(&mut self, _source: &str, _target: &str) -> Result<(), String> {
        Ok(())
    }
    fn execute_action(&mut self, action: &str, _input: &GraphInput) -> Result<Value, String> {
        if action != "dependencyRevision.markStale" {
            return Err(format!("unsupported stale revision action {action}"));
        }
        let graph = Graph::parse(TASK_GRAPH)?;
        let mut ports = TaskStateEffect {
            task: self.task,
            at: self.at,
        };
        let state = ports.task["state"]
            .as_str()
            .ok_or("Task state missing")?
            .to_owned();
        let result = graph.dispatch(&state, GraphInput {
            transport: "event".into(), id: "cancel".into(),
            payload: json!({"taskId":ports.task["id"],"reason":"Superseded upstream dependency evidence vector changed"}),
        }, &std::collections::HashMap::new(), &mut ports)?;
        if !matches!(result.decision, crate::graph::Decision::Accepted { .. })
            || ports.task["state"] != "CANCELLED"
        {
            return Err("Task Lifecycle Graph rejected stale dependency cancellation".into());
        }
        Ok(json!({"ok":true,"payloads":{}}))
    }
    fn publish_event(&mut self, event: &str, _payload: &Value) -> Result<(), String> {
        Err(format!("unexpected stale revision event {event}"))
    }
}
impl ActionPorts for RevisionEffect<'_, '_> {
    fn persist_transition(&mut self, _source: &str, _target: &str) -> Result<(), String> {
        // PROPOSED is a transient Graph state; the selected child is the durable evidence.
        Ok(())
    }
    fn execute_action(&mut self, action: &str, _input: &GraphInput) -> Result<Value, String> {
        let mode = match action {
            "dependencyRevision.createRerun" => "rerun",
            "dependencyRevision.createRevalidation" => "revalidate",
            _ => return Err(format!("unsupported dependency revision action {action}")),
        };
        self.create_child(mode)?;
        Ok(json!({"ok":true,"payloads":{}}))
    }
    fn publish_event(&mut self, event: &str, _payload: &Value) -> Result<(), String> {
        Err(format!("unexpected dependency revision event {event}"))
    }
}

impl RevisionEffect<'_, '_> {
    fn create_child(&mut self, mode: &str) -> Result<(), String> {
        let tasks = self.job["tasks"].as_array().ok_or("Job tasks missing")?;
        let original = tasks
            .iter()
            .find(|task| task["id"] == self.original_id)
            .ok_or("dependency revision owner Task missing")?
            .clone();
        let mut dependencies = vec![self.original_id.to_owned()];
        let mut upstream_requests = Vec::new();
        let mut ancestor_review = self.job["review"]["taskId"]
            .as_str()
            .unwrap_or("")
            .to_owned();
        let mut found_revision = false;
        for dependency_id in original["dependencies"]
            .as_array()
            .ok_or("original dependencies missing")?
            .iter()
            .map(|item| item.as_str().ok_or("invalid original dependency Task ID"))
            .collect::<Result<Vec<_>, _>>()?
        {
            if !self.vector.contains_key(dependency_id) {
                continue;
            }
            let original_dependency = tasks
                .iter()
                .find(|task| task["id"] == dependency_id)
                .ok_or("dependency revision input Task missing")?;
            let selected = latest_revision(tasks, dependency_id).unwrap_or(original_dependency);
            let selected_id = selected["id"]
                .as_str()
                .ok_or("dependency Task ID missing")?;
            dependencies.push(selected_id.to_owned());
            if let Some(revision) = revision_of(selected) {
                if let Some(ids) = revision["requestIds"].as_array() {
                    upstream_requests
                        .extend(ids.iter().filter_map(Value::as_str).map(str::to_owned));
                }
                if !found_revision {
                    if let Some(review_id) = revision["reviewTaskId"].as_str() {
                        ancestor_review = review_id.to_owned();
                    }
                    found_revision = true;
                }
            }
        }
        let mut seen_dependencies = HashSet::new();
        dependencies.retain(|dependency| seen_dependencies.insert(dependency.clone()));
        let repository = self.job["repository"]
            .as_str()
            .ok_or("Job repository missing")?;
        let occupied = tasks
            .iter()
            .filter_map(|task| task["id"].as_str().map(str::to_owned))
            .collect::<HashSet<_>>();
        let id = allocate_entity_id_in_tx(self.tx, repository, EntityKind::Task, None, &occupied)?;
        let title = format!(
            "{} {}",
            if mode == "rerun" {
                "Rerun"
            } else {
                "Revalidate"
            },
            original["title"].as_str().unwrap_or(self.original_id)
        );
        let original_input = original["input"]
            .as_str()
            .ok_or("original Task input missing")?;
        let original_result = original.get("result").cloned().unwrap_or(Value::Null);
        let vector_json = serde_json::to_value(self.vector).map_err(|e| e.to_string())?;
        let mut child = json!({
            "jobId": self.job["id"], "id": id, "title": title, "kind": "work",
            "parentTaskId": self.original_id, "agentName": original["agentName"],
            "priority": original.get("priority").filter(|value| !value.is_null()).cloned()
                .or_else(|| self.job.get("priority").filter(|value| !value.is_null()).cloned()).unwrap_or(json!("P2")),
            "storySize": original.get("storySize").filter(|value| !value.is_null()).cloned().unwrap_or(json!("M")),
            "projectName": original["projectName"], "dependencies": dependencies,
            "capabilities": original.get("capabilities").filter(|value| !value.is_null()).cloned().unwrap_or(json!([])),
            "workerRequirements": original.get("workerRequirements").cloned().unwrap_or(Value::Null),
            "adapter": original.get("adapter").cloned().unwrap_or(Value::Null),
            "output": original.get("output").filter(|value| !value.is_null()).cloned().unwrap_or(json!({"kind":"task_pr"})),
            "input": format!("{} of original Task {}.\nSemantic dependency evidence vector (all inputs must be validated): {}.\n{}\nOriginal durable Task objective: {}\nOriginal result: {}",
                if mode == "rerun" { "MANDATORY RERUN" } else { "EXPLICIT REVALIDATION" }, self.original_id,
                serde_json::to_string(self.vector).map_err(|e| e.to_string())?,
                if mode == "rerun" { "Re-execute the original deliverable from current upstream evidence; do not merely sign off the old output." }
                else { "Verify whether the original delivered result remains valid against every new upstream generation. Update the output if required and report exact verification evidence." },
                original_input, serde_json::to_string(&original_result).map_err(|e| e.to_string())?),
            "revision": {"kind": mode, "originalTaskId": self.original_id, "requestIds": upstream_requests,
                "reviewTaskId": ancestor_review, "basedOnHeadSha": self.job["headSha"].as_str().unwrap_or(""),
                "dependencyVector": vector_json},
            "attempt": 0, "maxAttempts": original["maxAttempts"].as_i64().unwrap_or(3).max(3),
            "leaseOwner": null, "leaseExpiresAt": null, "executionId": null, "threadId": null,
            "result": null, "error": null, "timeoutMs": original["timeoutMs"].as_i64().unwrap_or(0),
            "createdAt": self.at, "updatedAt": self.at, "state": "DRAFT"
        });
        if let Some(fields) = child.as_object_mut() {
            for optional in ["agentName", "projectName", "workerRequirements", "adapter"] {
                if fields.get(optional).is_some_and(Value::is_null) {
                    fields.remove(optional);
                }
            }
        }
        // Task Lifecycle Graph owns whether settled dependencies queue this child.
        let task_graph = Graph::parse(TASK_GRAPH)?;
        let ready = dependencies.iter().all(|dependency| {
            self.job["tasks"]
                .as_array()
                .and_then(|all| all.iter().find(|task| task["id"] == *dependency))
                .is_some_and(|task| task["state"] == "SUCCEEDED")
        });
        let decision = task_graph.decide(
            "DRAFT",
            GraphInput {
                transport: "event".into(),
                id: "reconcile".into(),
                payload: json!({"taskId":id}),
            },
            &std::collections::HashMap::from([("dependenciesSatisfied".to_owned(), ready)]),
        )?;
        let crate::graph::Decision::Accepted {
            target, actions, ..
        } = decision
        else {
            return Err("Task Lifecycle Graph denied dependency revision child".into());
        };
        if target != "QUEUED" {
            return Err("Task Lifecycle Graph did not queue settled dependency revision".into());
        }
        apply_pure_task_actions(&mut child, &actions)?;
        child["state"] = json!(target);
        self.job["tasks"]
            .as_array_mut()
            .ok_or("Job tasks missing")?
            .push(child);
        Ok(())
    }
}

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
    fn reconcile_dependency_revisions_in_tx(
        tx: &Transaction<'_>,
        job: &mut Value,
        at: &str,
    ) -> Result<Vec<String>, String> {
        let graph = Graph::parse(REVISION_GRAPH)?;
        let stale_ids = job["tasks"]
            .as_array()
            .ok_or("Job Tasks missing")?
            .iter()
            .filter(|task| {
                matches!(task["state"].as_str(), Some("DRAFT" | "QUEUED"))
                    && revision_of(task).is_some_and(|revision| {
                        matches!(revision["kind"].as_str(), Some("revalidate" | "rerun"))
                    })
            })
            .filter(|task| !dependency_revision_still_current(job, task))
            .filter_map(|task| task["id"].as_str().map(str::to_owned))
            .collect::<Vec<_>>();
        let mut changed = Vec::new();
        for id in stale_ids {
            let task = job["tasks"]
                .as_array_mut()
                .and_then(|tasks| tasks.iter_mut().find(|task| task["id"] == id))
                .ok_or("stale dependency Task disappeared")?;
            let mut effect = StaleRevisionEffect { task, at };
            let result = graph.dispatch(
                "PROPOSED",
                GraphInput {
                    transport: "event".into(),
                    id: "dependency.stale".into(),
                    payload: json!({"taskId":id}),
                },
                &std::collections::HashMap::new(),
                &mut effect,
            )?;
            if matches!(result.decision, crate::graph::Decision::Accepted { .. }) {
                changed.push(id);
            }
        }
        let originals = job["tasks"]
            .as_array()
            .ok_or("Job Tasks missing")?
            .iter()
            .filter(|task| {
                task["state"] == "SUCCEEDED"
                    && revision_of(task).is_none()
                    && task["kind"] != "planner"
                    && task["agentName"] != "troubleshooter"
                    && task["agentName"] != "job-acceptance-reviewer"
            })
            .map(|task| {
                task["id"]
                    .as_str()
                    .map(str::to_owned)
                    .ok_or("Task ID missing")
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut created = Vec::new();
        for original_id in originals {
            let tasks = job["tasks"].as_array().ok_or("Job Tasks missing")?;
            let original = tasks
                .iter()
                .find(|task| task["id"] == original_id)
                .ok_or("dependency revision owner disappeared")?
                .clone();
            validate_policies(&original)?;
            let explicit = original["dependencies"]
                .as_array()
                .ok_or("Task dependencies missing")?
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .map(str::to_owned)
                        .ok_or("invalid dependency Task ID")
                })
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .filter(|id| validity(&original, id).is_ok_and(|policy| policy != "order-only"))
                .collect::<Vec<_>>();
            if explicit.is_empty() {
                continue;
            }
            let pending = |owner: &str| {
                tasks.iter().any(|candidate| {
                    revision_of(candidate).and_then(|revision| revision["originalTaskId"].as_str())
                        == Some(owner)
                        && !matches!(candidate["state"].as_str(), Some("SUCCEEDED" | "CANCELLED"))
                })
            };
            if explicit.iter().any(|id| pending(id)) || pending(&original_id) {
                continue;
            }
            let Ok(vector) = evidence_vector(job, &original) else {
                continue;
            };
            let previous = latest_revision(tasks, &original_id)
                .and_then(|revision| {
                    revision_of(revision).and_then(|r| r["dependencyVector"].as_object())
                })
                .map(|object| {
                    object
                        .iter()
                        .filter_map(|(k, v)| v.as_str().map(|value| (k.clone(), value.to_owned())))
                        .collect::<BTreeMap<_, _>>()
                })
                .unwrap_or_else(|| {
                    explicit
                        .iter()
                        .filter_map(|id| {
                            tasks
                                .iter()
                                .find(|task| task["id"] == *id)
                                .and_then(|task| {
                                    task["attempt"]
                                        .as_i64()
                                        .map(|attempt| (id.clone(), format!("{id}:{attempt}")))
                                })
                        })
                        .collect()
                });
            let changed = vector != previous;
            let rerun_required = explicit.iter().any(|id| {
                vector.get(id) != previous.get(id)
                    && validity(&original, id).is_ok_and(|policy| policy == "rerun")
            });
            let duplicate = tasks.iter().any(|candidate| {
                revision_of(candidate).is_some_and(|revision| {
                    revision["originalTaskId"] == original_id
                        && revision["kind"] != "targeted"
                        && vector_matches(&revision["dependencyVector"], &vector)
                })
            });
            let guards = std::collections::HashMap::from([
                ("upstreamEvidenceChanged".to_owned(), changed),
                ("explicitValidityPolicy".to_owned(), !explicit.is_empty()),
                ("allInputsSettled".to_owned(), true),
                ("notAlreadyRecorded".to_owned(), !duplicate),
                ("rerunRequired".to_owned(), rerun_required),
            ]);
            let input = GraphInput {
                transport: "event".into(),
                id: "dependency.reconcile".into(),
                payload: json!({"taskId":original_id,"dependencyVector":vector}),
            };
            let mut effect = RevisionEffect {
                tx,
                job,
                original_id: &original_id,
                vector: &vector,
                at,
            };
            let result = graph.dispatch("NONE", input, &guards, &mut effect)?;
            if matches!(result.decision, crate::graph::Decision::Accepted { .. }) {
                let id = job["tasks"]
                    .as_array()
                    .and_then(|items| items.last())
                    .and_then(|task| task["id"].as_str())
                    .ok_or("dependency Graph action created no Task")?;
                created.push(id.to_owned());
            }
        }
        changed.extend(created);
        Ok(changed)
    }

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
        let mut changed = vec![];
        let commit = self.commit_job_with_tx(job_id, at, |tx, current| {
            if current["state"] != "ACTIVE" || current.get("pause").is_some_and(|v| !v.is_null()) {
                return Err("dependency Job changed before Graph reconcile".into());
            }
            let proposals = effective_proposals(current, &graph)?;
            let mut next = current.clone();
            changed.extend(Self::reconcile_dependency_revisions_in_tx(
                tx, &mut next, at,
            )?);
            if proposals.is_empty() && changed.is_empty() {
                return Err("native-dependency-noop-after-concurrent-tick".into());
            }
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

    fn revision_task(id: &str, owner: &str, state: &str, at: &str) -> Value {
        json!({"id":id,"jobId":"91","kind":"work","agentName":"implementation",
            "parentTaskId":null,"dependencies":[],"capabilities":["model"],
            "workerRequirements":{"capabilities":["model"]},"adapter":"codex",
            "input":"upstream revision","output":{"kind":"task_pr"},"state":state,
            "attempt":1,"maxAttempts":3,"timeoutMs":1000,"result":{"summary":"verified"},
            "revision":{"kind":"targeted","originalTaskId":owner,"requestIds":["req-{owner}"],
                "reviewTaskId":"review","basedOnHeadSha":"head"},
            "createdAt":at,"updatedAt":at})
    }

    fn seed_revision_job(authority: &mut RelayAuthority, upstream_state: &str) {
        authority.commit_job("91", "2026-11-13T20:00:01.000Z", |old| {
            let mut job = old.clone();
            job["updatedAt"] = json!("2026-11-13T20:00:01.000Z");
            let mut upstream_a = revision_task("104", "101", upstream_state, "2026-11-13T19:30:00.000Z");
            upstream_a["revision"]["reviewTaskId"] = json!("review-A");
            let mut upstream_b = revision_task("105", "102", "SUCCEEDED", "2026-11-13T19:31:00.000Z");
            upstream_b["revision"]["reviewTaskId"] = json!("review-B");
            job["tasks"] = json!([
                {"id":"101","jobId":"91","title":"A","kind":"work","state":"SUCCEEDED","attempt":1,
                    "dependencies":[],"agentName":"implementation","adapter":"script","capabilities":["script"],
                    "input":"produce A","output":{"kind":"file","path":"/tmp/A"},"result":{"summary":"A1"},
                    "maxAttempts":3,"timeoutMs":1000,"createdAt":"2026-11-13T19:00:00.000Z"},
                {"id":"102","jobId":"91","title":"B","kind":"work","state":"SUCCEEDED","attempt":1,
                    "dependencies":[],"agentName":"implementation","adapter":"codex","capabilities":["model"],
                    "input":"produce B","output":{"kind":"task_pr"},"result":{"summary":"B1"},
                    "maxAttempts":3,"timeoutMs":2000,"createdAt":"2026-11-13T19:00:00.000Z"},
                {"id":"103","jobId":"91","title":"C","kind":"work","state":"SUCCEEDED","attempt":2,
                    "dependencies":["101","102"],"dependencyValidity":{"101":"revalidate","102":"rerun"},
                    "parentTaskId":"100","agentName":"implementation","adapter":"codex","capabilities":["model"],
                    "workerRequirements":{"capabilities":["model"]},"input":"produce C","output":{"kind":"task_pr"},
                    "result":{"summary":"C1"},"maxAttempts":3,"timeoutMs":3000,"createdAt":"2026-11-13T19:00:00.000Z"},
                upstream_a,
                upstream_b
            ]);
            Ok((job, vec![]))
        }).unwrap();
    }

    #[test]
    fn graph_selected_rerun_waits_for_complete_evidence_and_is_restart_deduped() {
        let (_dir, path) = setup();
        let mut authority = RelayAuthority::open_existing(&path).unwrap();
        seed_revision_job(&mut authority, "SUCCEEDED");
        let made = authority
            .reconcile_native_dependencies("91", "2026-11-13T20:00:02.000Z")
            .unwrap();
        assert_eq!(made, vec!["106"]);
        let job = authority.read_job("91").unwrap().unwrap();
        let child = job["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|task| task["id"] == "106")
            .unwrap();
        assert_eq!(
            child["revision"]["kind"], "rerun",
            "rerun policy wins for a changed fan-in input"
        );
        assert_eq!(
            child["parentTaskId"], "103",
            "semantic ownership remains separate from dependencies"
        );
        assert_eq!(child["dependencies"], json!(["103", "104", "105"]));
        assert_eq!(child["revision"]["reviewTaskId"], "review-A");
        assert_eq!(
            child["revision"]["dependencyVector"],
            json!({"101":"104:1","102":"105:1"})
        );
        assert_eq!(child["adapter"], "codex");
        assert_eq!(child["state"], "QUEUED");
        assert_eq!(job["tasks"][2]["state"], "SUCCEEDED");
        assert_eq!(
            job["state"], "ACTIVE",
            "queued verification cannot falsely complete the Job"
        );

        assert!(authority
            .reconcile_native_dependencies("91", "2026-11-13T20:00:03.000Z")
            .unwrap()
            .is_empty());
        drop(authority);
        let mut reopened = RelayAuthority::open_existing(&path).unwrap();
        assert!(reopened
            .reconcile_native_dependencies("91", "2026-11-13T20:00:04.000Z")
            .unwrap()
            .is_empty());
        let job = reopened.read_job("91").unwrap().unwrap();
        assert_eq!(
            job["tasks"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|task| revision_of(task)
                    .is_some_and(|r| r["originalTaskId"] == "103" && r["kind"] == "rerun"))
                .count(),
            1
        );
    }

    #[test]
    fn unsettled_or_invalid_upstream_evidence_never_creates_a_revision() {
        let (_dir, path) = setup();
        let mut authority = RelayAuthority::open_existing(&path).unwrap();
        seed_revision_job(&mut authority, "RUNNING");
        assert!(authority
            .reconcile_native_dependencies("91", "2026-11-13T20:00:02.000Z")
            .unwrap()
            .is_empty());
        let job = authority.read_job("91").unwrap().unwrap();
        assert_eq!(job["tasks"].as_array().unwrap().len(), 5);

        authority
            .commit_job("91", "2026-11-13T20:00:03.000Z", |old| {
                let mut job = old.clone();
                job["updatedAt"] = json!("2026-11-13T20:00:03.000Z");
                job["tasks"][3]["state"] = json!("FAILED");
                job["tasks"][3]["result"] = Value::Null;
                job["tasks"][4]["state"] = json!("FAILED");
                job["tasks"][4]["result"] = Value::Null;
                Ok((job, vec![]))
            })
            .unwrap();
        assert!(authority
            .reconcile_native_dependencies("91", "2026-11-13T20:00:04.000Z")
            .unwrap()
            .is_empty());
        authority
            .commit_job("91", "2026-11-13T20:00:05.000Z", |old| {
                let mut job = old.clone();
                job["updatedAt"] = json!("2026-11-13T20:00:05.000Z");
                job["tasks"][2]["dependencyValidity"] = json!(["rerun"]);
                Ok((job, vec![]))
            })
            .unwrap();
        assert!(authority
            .reconcile_native_dependencies("91", "2026-11-13T20:00:06.000Z")
            .unwrap_err()
            .contains("dependencyValidity must be an object"));
        assert_eq!(
            authority.read_job("91").unwrap().unwrap()["tasks"]
                .as_array()
                .unwrap()
                .len(),
            5
        );
    }

    #[test]
    fn revalidation_uses_the_graph_and_stales_a_superseded_queued_vector() {
        let (_dir, path) = setup();
        let mut authority = RelayAuthority::open_existing(&path).unwrap();
        seed_revision_job(&mut authority, "SUCCEEDED");
        authority
            .commit_job("91", "2026-11-13T20:00:02.000Z", |old| {
                let mut job = old.clone();
                job["updatedAt"] = json!("2026-11-13T20:00:02.000Z");
                job["tasks"][2]["dependencyValidity"]["102"] = json!("revalidate");
                Ok((job, vec![]))
            })
            .unwrap();
        assert_eq!(
            authority
                .reconcile_native_dependencies("91", "2026-11-13T20:00:03.000Z")
                .unwrap(),
            vec!["106"]
        );
        assert_eq!(
            authority.read_job("91").unwrap().unwrap()["tasks"][5]["revision"]["kind"],
            "revalidate"
        );

        authority
            .commit_job("91", "2026-11-13T20:00:04.000Z", |old| {
                let mut job = old.clone();
                job["updatedAt"] = json!("2026-11-13T20:00:04.000Z");
                let mut newer =
                    revision_task("107", "102", "SUCCEEDED", "2026-11-13T19:59:00.000Z");
                newer["result"] = json!({"summary":"new upstream generation"});
                job["tasks"].as_array_mut().unwrap().push(newer);
                Ok((job, vec![]))
            })
            .unwrap();
        assert_eq!(
            authority
                .reconcile_native_dependencies("91", "2026-11-13T20:00:05.000Z")
                .unwrap(),
            vec!["106", "108"]
        );
        let job = authority.read_job("91").unwrap().unwrap();
        assert_eq!(
            job["tasks"][5]["state"], "CANCELLED",
            "stale queued verification is graph-cancelled"
        );
        assert_eq!(
            job["tasks"][7]["revision"]["dependencyVector"],
            json!({"101":"104:1","102":"107:1"})
        );
        assert_eq!(
            job["state"], "ACTIVE",
            "stale cancellation and queued replacement cannot infer completion"
        );
        assert!(authority
            .reconcile_native_dependencies("91", "2026-11-13T20:00:06.000Z")
            .unwrap()
            .is_empty());
    }
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
