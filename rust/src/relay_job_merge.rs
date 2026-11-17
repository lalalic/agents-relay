// Direct port of Node src/relay-job-merge.ts: immutable inbound Job/Plan/Task merge with local SQLite-owned review history and append-only Task comments.
use crate::{
    review_revision_merge::preserve_review_revision_history, task_comments::preserve_task_comments,
};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
fn updated_at(value: &Value) -> &str {
    value.get("updatedAt").and_then(Value::as_str).unwrap_or("")
}
fn merge_records(local: &[Value], remote: &[Value]) -> Vec<Value> {
    let remote_by_id: HashMap<String, &Value> = remote
        .iter()
        .filter_map(|item| {
            item.get("id")
                .and_then(Value::as_str)
                .map(|id| (id.to_owned(), item))
        })
        .collect();
    let mut merged = local
        .iter()
        .map(|item| {
            let remote = item
                .get("id")
                .and_then(Value::as_str)
                .and_then(|id| remote_by_id.get(id).copied())
                .unwrap_or(item);
            if updated_at(remote) > updated_at(item) {
                remote.clone()
            } else {
                item.clone()
            }
        })
        .collect::<Vec<_>>();
    let local_ids = local
        .iter()
        .filter_map(|item| item.get("id").and_then(Value::as_str))
        .collect::<HashSet<_>>();
    for item in remote {
        if !item
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(|id| local_ids.contains(id))
        {
            merged.push(item.clone());
        }
    }
    merged
}
pub fn merge_inbound_job_snapshot(local: &Value, remote: &Value) -> Value {
    let mut base = if updated_at(remote) > updated_at(local) {
        remote.clone()
    } else {
        local.clone()
    };
    let local_tasks = local
        .get("tasks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let remote_tasks = remote
        .get("tasks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    base["tasks"] = json!(preserve_task_comments(
        &local_tasks,
        &merge_records(&local_tasks, &remote_tasks)
    ));
    preserve_review_revision_history(local, &mut base);
    let local_plans = local
        .get("plans")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let remote_plans = remote
        .get("plans")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if !local_plans.is_empty() || !remote_plans.is_empty() {
        let mut plans = merge_records(&local_plans, &remote_plans);
        plans.sort_by(|a, b| {
            let lhs = a.get("round").and_then(Value::as_f64).unwrap_or(0.0);
            let rhs = b.get("round").and_then(Value::as_f64).unwrap_or(0.0);
            lhs.partial_cmp(&rhs).unwrap_or(std::cmp::Ordering::Equal)
        });
        base["plans"] = json!(plans);
    } else if let Some(object) = base.as_object_mut() {
        object.remove("plans");
    }
    base
}
