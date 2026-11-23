// src/review-revision-model.ts: reducer plus atomic authoritative SQLite intake;
// all revision transitions are selected by the canonical Review Graph.
use crate::{
    final_review_role::is_final_review_agent,
    local_merge_lock::iso8601_now,
    relay_job_snapshot_reads::load_relay_job,
    task_comments::append_task_comment,
    workflow::{entity_creation::create_task_entity, revision_v2::decide_revision_lifecycle},
};
use serde_json::{json, Map, Value};
use std::path::Path;

use std::collections::HashSet;
fn arr<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    v[key].as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn s(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}

fn field<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn put_optional(target: &mut Value, key: &str, original: &Value, from: &str) {
    if let Some(value) = original.get(from) {
        target[key] = value.clone();
    }
}
/// Node recordTargetedRevisionRequest. Call only within mutateJob so that
/// request, two comments and the child Task commit or roll back together.
pub fn record_targeted_revision_request(
    graph_dir: &Path,
    job: &mut Value,
    input: &Value,
) -> Result<Value, String> {
    let request_id = field(input, "requestId");
    if request_id.trim().is_empty() || request_id.encode_utf16().count() > 160 {
        return Err("revision request requires stable request ID (max 160)".into());
    }
    let head = field(input, "headSha");
    let execution = field(input, "reviewExecutionId");
    if head.trim().is_empty() || execution.trim().is_empty() {
        return Err("revision requires exact reviewer execution and immutable head".into());
    }
    let findings = input["findings"].as_array();
    if findings.is_none_or(|f| {
        f.is_empty()
            || f.iter().any(|item| {
                field(item, "id").trim().is_empty()
                    || field(item, "summary").trim().is_empty()
                    || field(item, "summary").encode_utf16().count() > 4000
            })
    }) {
        return Err("revision requires identified, nonempty findings".into());
    }
    let findings = findings.expect("validated findings");
    if findings
        .iter()
        .map(|f| field(f, "id"))
        .collect::<HashSet<_>>()
        .len()
        != findings.len()
    {
        return Err("duplicate finding IDs in revision request".into());
    }
    if let Some(existing) = arr(job, "reviewRevisionRequests")
        .iter()
        .find(|request| request["requestId"] == request_id)
    {
        let same = existing["reviewTaskId"] == input["reviewTaskId"]
            && existing["reviewExecutionId"] == input["reviewExecutionId"]
            && existing["reviewHeadSha"] == input["headSha"]
            && existing["originalTaskId"] == input["originalTaskId"]
            && existing["findings"] == input["findings"];
        if !same {
            return Err("revision request ID reused with different immutable feedback".into());
        }
        return Ok(json!({"request":existing,"created":false}));
    }
    let reviewer = arr(job, "tasks")
        .iter()
        .find(|task| task["id"] == input["reviewTaskId"])
        .cloned();
    let owner = arr(job, "tasks")
        .iter()
        .find(|task| task["id"] == input["originalTaskId"])
        .cloned();
    let reviewer_ok = reviewer.as_ref().is_some_and(|reviewer| {
        is_final_review_agent(reviewer["agentName"].as_str())
            && reviewer["state"] == "RUNNING"
            && reviewer["executionId"] == execution
    });
    let head_ok = reviewer
        .as_ref()
        .is_some_and(|reviewer| reviewer["reviewHeadSha"] == head)
        && job["headSha"] == head
        && (job.get("review").is_none_or(Value::is_null)
            || (job["review"]["headSha"] == head
                && job["review"]["taskId"] == input["reviewTaskId"]
                && matches!(
                    job["review"]["outcome"].as_str(),
                    Some("pending" | "started")
                )));
    let owner_ok = owner.as_ref().is_some_and(|owner| {
        owner["state"] == "SUCCEEDED"
            && owner["kind"] != "planner"
            && !is_final_review_agent(owner["agentName"].as_str())
            && owner["id"] != input["reviewTaskId"]
            && owner.get("revision").is_none_or(Value::is_null)
    });
    let decision = decide_revision_lifecycle(
        graph_dir,
        "NONE",
        "revision.submit",
        &json!({
            "reviewerAuthorized":job["state"] == "ACTIVE" && reviewer_ok,
            "reviewHeadCurrent":head_ok,
            "originalTaskSucceeded":owner_ok,
        }),
    )?;
    if decision["accepted"] != true
        || decision["target"] != "REQUESTED"
        || decision["actions"].as_array().is_none_or(|actions| {
            actions.iter().map(|a| field(a, "id")).collect::<Vec<_>>() != ["revision.recordRequest"]
        })
    {
        return Err("revision rejected: reviewer, head, execution or original owner is not current/eligible".into());
    }
    let child_id = field(input, "allocatedTaskId");
    if child_id.starts_with('0')
        || child_id.is_empty()
        || !child_id.bytes().all(|b| b.is_ascii_digit())
    {
        return Err("targeted revision requires a Relay-allocated Task ID".into());
    }
    let now = iso8601_now();
    let request = json!({
        "requestId":request_id,"reviewTaskId":input["reviewTaskId"],
        "reviewExecutionId":execution,"reviewHeadSha":head,
        "originalTaskId":input["originalTaskId"],"findings":findings,
        "createdAt":now,"status":"requested","revisionTaskId":child_id,
        "feedbackOrigin":"final-review",
    });
    if job.get("reviewRevisionRequests").is_none_or(Value::is_null) {
        job["reviewRevisionRequests"] = json!([]);
    }
    job["reviewRevisionRequests"]
        .as_array_mut()
        .ok_or("invalid revision requests collection")?
        .push(request.clone());
    let reviewer_id = field(input, "reviewTaskId");
    let original_id = field(input, "originalTaskId");
    let summaries = findings
        .iter()
        .map(|f| format!("- {}: {}", field(f, "id"), field(f, "summary")))
        .collect::<Vec<_>>()
        .join("\n");
    let feedback_options = json!({"author":"reviewer","kind":"review.feedback",
        "executionId":execution,"transition":"revision.requested",
        "idempotencyKey":format!("review-revision/{request_id}")});
    append_task_comment(
        job,
        original_id,
        &format!("Final Review {reviewer_id} requested revision at {head}:\n{summaries}"),
        &feedback_options,
    )?;
    if let Some(child) = job["tasks"]
        .as_array_mut()
        .and_then(|tasks| tasks.iter_mut().find(|task| task["id"] == child_id))
    {
        if child["revision"]["kind"] != "targeted"
            || child["revision"]["originalTaskId"] != input["originalTaskId"]
            || child["revision"]["reviewTaskId"] != input["reviewTaskId"]
            || child["revision"]["basedOnHeadSha"] != head
            || child["state"] != "DRAFT"
        {
            return Err(
                "revision child no longer accepts feedback in this immutable review round".into(),
            );
        }
        let ids = child["revision"]["requestIds"]
            .as_array_mut()
            .ok_or("revision request IDs missing")?;
        if !ids.iter().any(|id| id == request_id) {
            ids.push(json!(request_id));
        }
    } else {
        let owner = owner.ok_or("review revision owner/reviewer missing")?;
        let reviewer = reviewer.ok_or("review revision owner/reviewer missing")?;
        let owner_evidence = if owner["result"].is_null() || owner["result"] == false {
            "No original result".to_string()
        } else {
            owner["result"].to_string()
        };
        let mut value = json!({
            "jobId":job["id"],"id":child_id,"kind":"work",
            "title":format!("Revise {}",owner["title"].as_str().unwrap_or(field(&owner,"id"))),
            "priority":owner.get("priority").filter(|v|!v.is_null()).unwrap_or(&job["priority"]),
            "storySize":owner.get("storySize").filter(|v|!v.is_null()).unwrap_or(&json!("M")),
            "agentName":owner["agentName"],"parentTaskId":owner["id"],
            "dependencies":[reviewer["id"]],"capabilities":owner["capabilities"],
            "input":format!("Revision of original Task {original_id} for Job {}; Final Review {reviewer_id}, immutable reviewed head {head}.\n\nRetrieve the authoritative Task Context; follow ALL append-only review.feedback comments and associated request IDs. Repair the original result without changing the historical succeeded Task. Review the full current Job objective and repository head, implement and verify the correction, and include root cause, solution, validation and self-review evidence in the durable result.\n\nOriginal Task input:\n{}\n\nOriginal completed evidence:\n{}",
                field(job,"id"),field(&owner,"input"),owner_evidence),
            "output":owner.get("output").filter(|v|!v.is_null()).unwrap_or(&json!({"kind":"task_pr"})),
            "revision":{"kind":"targeted","originalTaskId":owner["id"],
                "requestIds":[request_id],"reviewTaskId":reviewer["id"],"basedOnHeadSha":head},
            "attempt":0,"maxAttempts":std::cmp::max(3,owner["maxAttempts"].as_i64().unwrap_or(0)),
            "executionId":null,"threadId":null,
            "result":null,"error":null,"continuation":null,"continuationDeliveredAt":null,
            "createdAt":now,"updatedAt":now,
        });
        for key in ["projectName", "workerRequirements", "adapter", "timeoutMs"] {
            put_optional(&mut value, key, &owner, key);
        }
        let child = create_task_entity(graph_dir, job, &value, true, &now)?;
        job["tasks"]
            .as_array_mut()
            .ok_or("Job tasks missing")?
            .push(child);
    }
    let feedback = findings
        .iter()
        .map(|f| {
            format!(
                "- {}: {}{}",
                field(f, "id"),
                field(f, "summary"),
                f.get("evidence")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(|e| format!("\n  Evidence: {e}"))
                    .unwrap_or_default()
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    append_task_comment(
        job,
        child_id,
        &format!(
            "Review feedback request {request_id} for owner {original_id} at {head}:\n{feedback}"
        ),
        &json!({"author":"reviewer","kind":"review.feedback","executionId":execution,
            "transition":"revision.requested",
            "idempotencyKey":format!("review-revision-child/{request_id}")}),
    )?;
    Ok(json!({"request":request,"created":true}))
}
/// Public intake boundary. The repository-scoped allocator creates a stable
/// globally numeric child identity, while mutateJob commits all feedback and
/// entity creation together. All file access is to caller-supplied store dir.
pub fn submit_targeted_revision_request<W, E>(
    store: &mut crate::relay_workflow_operations::SQLiteWorkflowOperations<'_, W, E>,
    store_dir: &Path,
    graph_dir: &Path,
    job_id: &str,
    input: &Value,
) -> Result<Value, String>
where
    W: FnMut(&Value, &str) -> Result<(), String>,
    E: FnMut(&Value, &str) -> Result<(), String>,
{
    let snapshot =
        load_relay_job(store.db, job_id)?.ok_or_else(|| format!("Job {job_id} not found"))?;
    let allocated = crate::job_task_id_sequence::allocate_entity_id(
        store_dir,
        field(&snapshot, "repository"),
        "task",
        Some(&format!(
            "targeted-revision:{job_id}:{}:{}:{}",
            field(input, "reviewTaskId"),
            field(input, "originalTaskId"),
            field(input, "headSha")
        )),
        &HashSet::new(),
    )?;
    let mut assigned = input.clone();
    assigned["allocatedTaskId"] = json!(allocated);
    let mut created = false;
    let committed = store.mutate_job(job_id, |mut current| {
        created = record_targeted_revision_request(graph_dir, &mut current, &assigned)?["created"]
            == true;
        Ok(current)
    })?;
    let request = arr(&committed, "reviewRevisionRequests")
        .iter()
        .find(|request| request["requestId"] == input["requestId"])
        .ok_or("targeted revision mutation did not persist the request")?;
    Ok(json!({"request":request,"created":created}))
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
