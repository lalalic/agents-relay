// Direct read-only facts from src/review-revision-model.ts.
// Atomic recordTargetedRevisionRequest + submitTargetedRevisionRequest require
// SQL allocation and task entity creation; intentionally NOT implemented here.
use serde_json::{Map, Value};
use std::collections::HashSet;
fn arr<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    v[key].as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn s(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
pub fn targeted_requests_for_review(
    job: &Value,
    review_task: &Value,
    head_sha: &str,
) -> Vec<Value> {
    arr(job, "reviewRevisionRequests")
        .iter()
        .filter(|r| {
            r["reviewTaskId"] == review_task["id"]
                && r["reviewExecutionId"] == review_task["executionId"]
                && r["reviewHeadSha"] == head_sha
                && r["status"] != "stale"
                && arr(job, "tasks")
                    .iter()
                    .any(|t| t["id"] == r["originalTaskId"] && t["state"] == "SUCCEEDED")
        })
        .cloned()
        .collect()
}
pub fn targeted_requests_cover_review(
    job: &Value,
    review_task: &Value,
    head_sha: &str,
    issues: &[Value],
) -> bool {
    if issues.is_empty()
        || issues
            .iter()
            .any(|v| s(v).trim() == "[unparseable blocking finding]")
    {
        return false;
    }
    let requests = targeted_requests_for_review(job, review_task, head_sha);
    if requests.is_empty() {
        return false;
    }
    let covered = requests
        .iter()
        .flat_map(|r| arr(r, "findings"))
        .flat_map(|f| {
            [
                s(&f["id"]).trim().to_string(),
                s(&f["summary"]).trim().to_string(),
            ]
        })
        .collect::<HashSet<_>>();
    issues.iter().all(|v| covered.contains(s(v).trim()))
}
pub fn dependency_validity(task: &Value, id: &str) -> Result<String, String> {
    if !arr(task, "dependencies").iter().any(|v| v == id) {
        return Err("dependency is not declared on Task".into());
    }
    let mode = task["dependencyValidity"][id]
        .as_str()
        .unwrap_or("order-only");
    if !matches!(mode, "order-only" | "revalidate" | "rerun") {
        return Err("invalid dependency validity policy".into());
    }
    Ok(mode.into())
}
pub fn dependency_revision_vector(job: &Value, task: &Value) -> Result<Value, String> {
    let mut ids = arr(task, "dependencies")
        .iter()
        .map(|v| s(v).to_string())
        .collect::<Vec<_>>();
    ids.sort();
    ids.dedup();
    let mut result = Map::new();
    for id in ids {
        if dependency_validity(task, &id)? == "order-only" {
            continue;
        }
        let original = arr(job, "tasks")
            .iter()
            .find(|t| t["id"] == id)
            .ok_or_else(|| format!("dependency Task not found: {id}"))?;
        let mut candidates = arr(job, "tasks")
            .iter()
            .filter(|t| t["revision"]["originalTaskId"] == id && t["state"] == "SUCCEEDED")
            .collect::<Vec<_>>();
        candidates.sort_by(|a, b| {
            s(&a["createdAt"])
                .cmp(s(&b["createdAt"]))
                .then_with(|| s(&a["id"]).cmp(s(&b["id"])))
        });
        let selected = candidates.last().copied().unwrap_or(original);
        if selected["state"] != "SUCCEEDED" {
            return Err(format!("dependency has no successful evidence: {id}"));
        }
        result.insert(
            id,
            Value::String(format!(
                "{}:{}",
                s(&selected["id"]),
                selected["attempt"]
                    .as_i64()
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| "undefined".into())
            )),
        );
    }
    Ok(Value::Object(result))
}
pub fn same_dependency_revision_vector(a: &Value, b: &Value) -> bool {
    match (a.as_object(), b.as_object()) {
        (Some(a), Some(b)) => a.len() == b.len() && a.iter().all(|(k, v)| b.get(k) == Some(v)),
        _ => false,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn stale_not_coverage() {
        let j = json!({"tasks":[{"id":"o","state":"SUCCEEDED"}],
    "reviewRevisionRequests":[{"reviewTaskId":"r","reviewExecutionId":"e","reviewHeadSha":"h","originalTaskId":"o","status":"stale","findings":[{"id":"f","summary":"s"}]}]});
        assert!(!targeted_requests_cover_review(
            &j,
            &json!({"id":"r","executionId":"e"}),
            "h",
            &[json!("f")]
        ));
    }
    #[test]
    fn revision_vector_generation() {
        let j = json!({"tasks":[{"id":"a","state":"SUCCEEDED","attempt":1},
        {"id":"b","state":"SUCCEEDED","attempt":2,"createdAt":"2026-01-01","revision":{"originalTaskId":"a"}}]});
        let task = json!({"dependencies":["a"],"dependencyValidity":{"a":"revalidate"}});
        assert_eq!(dependency_revision_vector(&j, &task).unwrap()["a"], "b:2");
    }
}
