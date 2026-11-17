// Reducer portion of src/review-revision-stale.ts.
// Caller MUST wrap this reducer in one SQLite mutateJob transaction, then signal
// only the returned exact execution identities after the commit completes.
use crate::local_merge_lock::iso8601_now;
use crate::workflow::{
    lifecycle::dispatch_task_lifecycle_sync, revision_v2::decide_revision_lifecycle,
};
use serde_json::{json, Value};
use std::path::Path;
pub fn stale_review_revisions(
    root: &Path,
    job: &mut Value,
    review_task_id: &str,
    head_sha: &str,
    active_execution_id: Option<&str>,
) -> Result<Vec<Value>, String> {
    if job["review"]["taskId"] != review_task_id || job["review"]["headSha"] != head_sha {
        return Ok(vec![]);
    }
    if let Some(active) = active_execution_id {
        if job["tasks"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|t| t["id"] == review_task_id)
            .is_none_or(|t| t["executionId"] != active)
        {
            return Ok(vec![]);
        }
    }
    let mut cancelled = Vec::new();
    let mut changed = false;
    let mut requests = job["reviewRevisionRequests"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut tasks = job["tasks"].as_array().cloned().unwrap_or_default();
    for request in &mut requests {
        if request["reviewTaskId"] != review_task_id || request["reviewHeadSha"] != head_sha {
            continue;
        }
        if active_execution_id.is_some_and(|a| request["reviewExecutionId"] == a) {
            continue;
        }
        let state = match request["status"].as_str().unwrap_or("") {
            "requested" => "REQUESTED",
            "queued" => "QUEUED",
            "running" => "RUNNING",
            "failed" => "FAILED",
            _ => continue,
        };
        let event = if active_execution_id.is_some() {
            "review.execution_changed"
        } else {
            "review.head_changed"
        };
        let decision = decide_revision_lifecycle(root, state, event, &Value::Null)?;
        if decision["accepted"] != true
            || decision["target"] != "STALE"
            || !decision["actions"]
                .as_array()
                .is_some_and(|a| a.iter().any(|v| v["id"] == "revision.markStale"))
        {
            continue;
        }
        let child_id = request["revisionTaskId"].as_str().filter(|s| !s.is_empty());
        if let Some(child) = tasks
            .iter_mut()
            .find(|t| child_id.is_some_and(|id| t["id"] == id))
        {
            let status = child["state"].as_str().unwrap_or("");
            if matches!(status, "DRAFT" | "QUEUED" | "RUNNING") {
                let execution = child["executionId"]
                    .as_str()
                    .or_else(|| {
                        child["executionHistory"]
                            .as_array()
                            .and_then(|a| a.last())
                            .and_then(|v| v["id"].as_str())
                    })
                    .map(str::to_owned);
                let r = dispatch_task_lifecycle_sync(
                    root,
                    child,
                    "cancel",
                    &json!({}),
                    &iso8601_now(),
                )?;
                if r["accepted"] != true {
                    continue;
                }
                child["error"] = json!(if active_execution_id.is_some() {
                    "Targeted revision evidence became stale after reviewer execution changed"
                } else {
                    "Targeted revision evidence became stale after review head changed"
                });
                child["leaseOwner"] = Value::Null;
                child["leaseExpiresAt"] = Value::Null;
                child["executionId"] = Value::Null;
                child["updatedAt"] = json!(iso8601_now());
                if let Some(e) = execution {
                    cancelled.push(json!({"taskId":child["id"],"executionId":e}));
                }
            } else if !matches!(status, "FAILED" | "SUCCEEDED" | "CANCELLED") {
                continue;
            }
        }
        request["status"] = json!("stale");
        changed = true;
    }
    if changed {
        job["tasks"] = json!(tasks);
        job["reviewRevisionRequests"] = json!(requests);
        job["updatedAt"] = json!(iso8601_now());
    }
    Ok(cancelled)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn no_change_for_other_head() {
        let mut job = json!({"review":{"taskId":"r","headSha":"h"}});
        assert!(
            stale_review_revisions(Path::new("/tmp"), &mut job, "r", "other", None)
                .unwrap()
                .is_empty()
        );
    }
}
