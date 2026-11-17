// Direct port of src/review-revision-execution.ts durable generation facts.
// No fake Graph policy: every status change is authorized through canonical revision-v2 Graph.
use crate::workflow::revision_v2::decide_revision_lifecycle;
use serde_json::Value;
use std::path::Path;

fn items<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    v[key].as_array().map(Vec::as_slice).unwrap_or(&[])
}
pub fn revision_request_ready(job: &Value, task: &Value) -> bool {
    if task["revision"]["kind"] != "targeted" {
        return true;
    }
    let r = &job["review"];
    let rev = &task["revision"];
    if r.is_null()
        || r["outcome"] != "changes_required"
        || r["revisionDisposition"] != "targeted"
        || r["taskId"] != rev["reviewTaskId"]
    {
        return false;
    }
    let ids = items(rev, "requestIds");
    !ids.is_empty()
        && ids.iter().all(|id| {
            items(job, "reviewRevisionRequests")
                .iter()
                .find(|r| r["requestId"] == *id)
                .is_some_and(|r| {
                    r["revisionTaskId"] == task["id"]
                        && r["status"] == "queued"
                        && r["reviewHeadSha"] == rev["basedOnHeadSha"]
                })
        })
}
fn accepted(
    graph_dir: &Path,
    state: &str,
    event: &str,
    facts: Value,
    target: &str,
    action: &str,
) -> Result<bool, String> {
    let d = decide_revision_lifecycle(graph_dir, state, event, &facts)?;
    Ok(d["accepted"] == true
        && d["target"] == target
        && d["actions"]
            .as_array()
            .is_some_and(|a| a.iter().any(|v| v["id"] == action)))
}
pub fn reconcile_review_revision_facts(graph_dir: &Path, job: &mut Value) -> Result<bool, String> {
    let tasks = items(job, "tasks").to_vec();
    let review = job["review"].clone();
    let Some(requests) = job["reviewRevisionRequests"].as_array_mut() else {
        return Ok(false);
    };
    let mut changed = false;
    for req in requests.iter_mut() {
        let task = tasks.iter().find(|t| {
            t["id"] == req["revisionTaskId"]
                && t["revision"]["reviewTaskId"] == req["reviewTaskId"]
                && items(&t["revision"], "requestIds").contains(&req["requestId"])
        });
        let Some(task) = task else { continue };
        let status = req["status"].as_str().unwrap_or("").to_string();
        let state = task["state"].as_str().unwrap_or("");
        let active = review["outcome"] == "changes_required"
            && review["revisionDisposition"] == "targeted"
            && review["taskId"] == req["reviewTaskId"];
        if (status == "failed" || status == "running")
            && state == "QUEUED"
            && task["executionId"].is_null()
            && active
            && accepted(
                graph_dir,
                if status == "failed" {
                    "FAILED"
                } else {
                    "RUNNING"
                },
                "revision.retry",
                serde_json::json!({"taskRetryQueued":true}),
                "QUEUED",
                "revision.queueTask",
            )?
        {
            req["status"] = Value::String("queued".into());
            changed = true;
        }
        if status == "requested"
            && active
            && accepted(
                graph_dir,
                "REQUESTED",
                "revision.queue",
                serde_json::json!({"changesRequiredRecorded":true}),
                "QUEUED",
                "revision.queueTask",
            )?
        {
            req["status"] = Value::String("queued".into());
            changed = true;
        }
        // Node captures status before transitions, but updates request synchronously.
        let status = req["status"].as_str().unwrap_or("");
        if status == "queued" && matches!(state, "RUNNING" | "SUCCEEDED" | "FAILED") {
            if accepted(
                graph_dir,
                "QUEUED",
                "revision.started",
                Value::Null,
                "RUNNING",
                "",
            )? || {
                let d = decide_revision_lifecycle(
                    graph_dir,
                    "QUEUED",
                    "revision.started",
                    &Value::Null,
                )?;
                d["accepted"] == true && d["target"] == "RUNNING"
            } {
                if state == "RUNNING" {
                    req["status"] = serde_json::json!("running");
                    changed = true;
                } else if accepted(
                    graph_dir,
                    "RUNNING",
                    if state == "SUCCEEDED" {
                        "revision.verified"
                    } else {
                        "revision.failed"
                    },
                    Value::Null,
                    if state == "SUCCEEDED" {
                        "VERIFIED"
                    } else {
                        "FAILED"
                    },
                    "",
                )? || {
                    let d = decide_revision_lifecycle(
                        graph_dir,
                        "RUNNING",
                        if state == "SUCCEEDED" {
                            "revision.verified"
                        } else {
                            "revision.failed"
                        },
                        &Value::Null,
                    )?;
                    d["accepted"] == true
                        && d["target"]
                            == if state == "SUCCEEDED" {
                                "VERIFIED"
                            } else {
                                "FAILED"
                            }
                } {
                    req["status"] = serde_json::json!(if state == "SUCCEEDED" {
                        "verified"
                    } else {
                        "failed"
                    });
                    changed = true;
                }
            }
        } else if status == "running" && matches!(state, "SUCCEEDED" | "FAILED") {
            let d = decide_revision_lifecycle(
                graph_dir,
                "RUNNING",
                if state == "SUCCEEDED" {
                    "revision.verified"
                } else {
                    "revision.failed"
                },
                &Value::Null,
            )?;
            if d["accepted"] == true
                && d["target"]
                    == if state == "SUCCEEDED" {
                        "VERIFIED"
                    } else {
                        "FAILED"
                    }
            {
                req["status"] = serde_json::json!(if state == "SUCCEEDED" {
                    "verified"
                } else {
                    "failed"
                });
                changed = true;
            }
        }
    }
    if changed {
        job["updatedAt"] =
            serde_json::json!(chrono::DateTime::<chrono::Utc>::from_timestamp_millis(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .expect("system time")
                    .as_millis() as i64
            )
            .expect("valid timestamp")
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
    }
    Ok(changed)
}

/// Public Node reconcileReviewRevisions store wrapper. The Job is read and
/// updated only under the SQLite BEGIN IMMEDIATE transaction, never from
/// externally supplied Task events or cached snapshots.
pub fn reconcile_review_revisions<W, E>(
    store: &mut crate::relay_workflow_operations::SQLiteWorkflowOperations<'_, W, E>,
    graph_dir: &Path,
    job_id: &str,
) -> Result<bool, String>
where
    W: FnMut(&Value, &str) -> Result<(), String>,
    E: FnMut(&Value, &str) -> Result<(), String>,
{
    let mut changed = false;
    store.mutate_job(job_id, |mut job| {
        changed = reconcile_review_revision_facts(graph_dir, &mut job)?;
        Ok(job)
    })?;
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn targeted_generation_guard() {
        let j = json!({"review":{"taskId":"1","outcome":"changes_required","revisionDisposition":"targeted"},"reviewRevisionRequests":[{"requestId":"q","revisionTaskId":"3","status":"queued","reviewHeadSha":"h"}]});
        let t = json!({"id":"3","revision":{"kind":"targeted","reviewTaskId":"1","requestIds":["q"],"basedOnHeadSha":"h"}});
        assert!(revision_request_ready(&j, &t));
        let mut bad = t;
        bad["revision"]["basedOnHeadSha"] = json!("old");
        assert!(!revision_request_ready(&j, &bad));
    }
}
