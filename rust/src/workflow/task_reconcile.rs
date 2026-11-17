// Direct port of src/workflow/task-reconcile.ts. The Graph, not this adapter,
// owns automatic lifecycle choices; this adapter supplies dependency/revision facts.
use super::lifecycle::dispatch_task_lifecycle_sync;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
};

fn str_field<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn tasks(job: &Value) -> &[Value] {
    job["tasks"].as_array().map(Vec::as_slice).unwrap_or(&[])
}
pub fn dependency_ready(task: &Value, by_id: &HashMap<String, Value>) -> bool {
    task["dependencies"]
        .as_array()
        .into_iter()
        .flatten()
        .all(|id| {
            id.as_str()
                .and_then(|id| by_id.get(id))
                .is_some_and(|dep| dep["state"] == "SUCCEEDED")
        })
}
pub fn detect_cycles(tasks: &[Value]) -> Result<(), String> {
    let map: HashMap<String, &Value> = tasks
        .iter()
        .map(|t| (str_field(t, "id").to_string(), t))
        .collect();
    fn visit(
        id: &str,
        map: &HashMap<String, &Value>,
        visiting: &mut HashSet<String>,
        done: &mut HashSet<String>,
    ) -> Result<(), String> {
        if visiting.contains(id) {
            return Err(format!("Dependency cycle at {id}"));
        }
        if done.contains(id) {
            return Ok(());
        }
        visiting.insert(id.to_string());
        if let Some(t) = map.get(id) {
            for dep in t["dependencies"].as_array().into_iter().flatten() {
                if let Some(dep) = dep.as_str() {
                    visit(dep, map, visiting, done)?;
                }
            }
        }
        visiting.remove(id);
        done.insert(id.to_string());
        Ok(())
    }
    let mut visiting = HashSet::new();
    let mut done = HashSet::new();
    for task in tasks {
        visit(str_field(task, "id"), &map, &mut visiting, &mut done)?;
    }
    Ok(())
}
/// Exactly src/review-revision-execution.ts revisionRequestReady, required by
/// task-reconcile; no review decision policy is duplicated here.
pub fn revision_request_ready(job: &Value, task: &Value) -> bool {
    if task.pointer("/revision/kind").and_then(Value::as_str) != Some("targeted") {
        return true;
    }
    let review = &job["review"];
    let revision = &task["revision"];
    if review["outcome"] != "changes_required"
        || review["revisionDisposition"] != "targeted"
        || review["taskId"] != revision["reviewTaskId"]
    {
        return false;
    }
    let Some(ids) = revision["requestIds"].as_array() else {
        return false;
    };
    !ids.is_empty()
        && ids.iter().all(|id| {
            job["reviewRevisionRequests"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|r| r["requestId"] == *id)
                .is_some_and(|r| {
                    r["revisionTaskId"] == task["id"]
                        && r["status"] == "queued"
                        && r["reviewHeadSha"] == revision["basedOnHeadSha"]
                })
        })
}
pub fn reconcile_task_dependencies(
    directory: &Path,
    job: &mut Value,
    timestamp: &str,
) -> Result<(), String> {
    detect_cycles(tasks(job))?;
    let count = tasks(job).len();
    for index in 0..count {
        let scoped = &job["tasks"][index];
        if scoped["kind"] == "planner"
            || !revision_request_ready(job, scoped)
            || (scoped["state"] == "DRAFT"
                && scoped
                    .get("unblock")
                    .is_some_and(|x| !x.is_null() && x != false))
        {
            continue;
        }
        let by_id: HashMap<String, Value> = tasks(job)
            .iter()
            .map(|t| (str_field(t, "id").to_string(), t.clone()))
            .collect();
        let ready = dependency_ready(scoped, &by_id);
        let has_dependencies = scoped["dependencies"]
            .as_array()
            .is_some_and(|deps| !deps.is_empty());
        let facts = json!({"dependenciesSatisfied":has_dependencies && ready,
            "dependenciesUnsatisfied":has_dependencies && !ready,"runnable":ready});
        let from = str_field(scoped, "state").to_string();
        let decision = dispatch_task_lifecycle_sync(
            directory,
            &mut job["tasks"][index],
            "reconcile",
            &facts,
            timestamp,
        )?;
        if decision["reason"] == "ambiguous" {
            return Err(format!("Ambiguous automatic task transition from {from}"));
        }
    }
    Ok(())
}
