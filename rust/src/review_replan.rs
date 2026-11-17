// Direct port of pure review scheduling facts in src/review-replan.ts.
// Graph remains the sole authority to dispatch review or Planner actions.
use crate::final_review_role::is_final_review_agent;
use crate::workflow::troubleshooter_v2::dispatch_troubleshooter;
use serde_json::{json, Value};
use std::path::Path;

fn arr<'a>(v: &'a Value, k: &str) -> &'a [Value] {
    v[k].as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn reviewer(task: &Value) -> bool {
    is_final_review_agent(task["agentName"].as_str())
}
fn task_id(job: &Value) -> Option<&str> {
    job["review"]["taskId"].as_str().filter(|s| !s.is_empty())
}
fn requires_revision(job: &Value) -> bool {
    let Some(id) = task_id(job) else { return false };
    job["review"]["outcome"] == "changes_required"
        || (job["review"]["outcome"] == "stale"
            && arr(job, "reviewRevisionRounds")
                .iter()
                .any(|r| r["reviewTaskId"] == id && r["status"] == "changes_required"))
}

/// src/review-replan.ts reviewWorkSettled. The Troubleshooter Graph remains
/// the authority to decide if a missing recovery Task must be created.
pub fn review_work_settled(graph_dir: &Path, job: &Value) -> Result<bool, String> {
    let tasks = arr(job, "tasks");
    let work = tasks
        .iter()
        .filter(|task| task["kind"] != "planner" && !reviewer(task))
        .collect::<Vec<_>>();
    if !work
        .iter()
        .any(|task| task["agentName"] != "troubleshooter")
        || work.iter().any(|task| {
            !matches!(
                task["state"].as_str(),
                Some("SUCCEEDED" | "FAILED" | "CANCELLED")
            ) || matches!(
                task["resolution"]["state"].as_str(),
                Some("active" | "waiting")
            )
        })
    {
        return Ok(false);
    }
    for original in tasks {
        if original["state"] != "FAILED"
            || original["kind"] == "planner"
            || original["agentName"] == "troubleshooter"
        {
            continue;
        }
        let recoveries = tasks
            .iter()
            .filter(|task| {
                task["agentName"] == "troubleshooter" && task["parentTaskId"] == original["id"]
            })
            .collect::<Vec<_>>();
        if recoveries.is_empty() {
            let mut create = false;
            let facts = json!({
                "failedWork":true,"ordinaryWork":true,"currentRun":true,
                "needsRecovery":true,"idUnused":true,"noRecoveryBarrier":true
            });
            let decision = dispatch_troubleshooter(graph_dir, &facts, || {
                create = true;
                Ok(())
            })?;
            if decision["accepted"] == true && create {
                return Ok(false);
            }
        } else if !recoveries.iter().any(|recovery| {
            matches!(
                recovery["state"].as_str(),
                Some("DRAFT" | "QUEUED" | "RUNNING" | "BLOCKED")
            )
        }) {
            let recovery = recoveries
                .into_iter()
                .max_by_key(|recovery| recovery["recoveryForAttempt"].as_i64().unwrap_or(-1));
            if recovery.is_some_and(|recovery| {
                matches!(recovery["state"].as_str(), Some("SUCCEEDED" | "CANCELLED"))
                    && recovery["recoveryForAttempt"].as_i64().unwrap_or(-1)
                        < original["attempt"].as_i64().unwrap_or(0)
            }) {
                return Ok(false);
            }
        }
    }
    for recovery in tasks {
        if recovery["agentName"] != "troubleshooter"
            || recovery["state"] != "FAILED"
            || recovery["attempt"].as_i64().unwrap_or(0)
                >= recovery["maxAttempts"].as_i64().unwrap_or(0)
        {
            continue;
        }
        if tasks.iter().any(|task| {
            task["id"] == recovery["parentTaskId"]
                && matches!(task["state"].as_str(), Some("FAILED" | "BLOCKED"))
        }) {
            return Ok(false);
        }
    }
    Ok(true)
}
pub fn review_needs_replan(job: &Value) -> bool {
    let Some(id) = task_id(job) else { return false };
    if job["review"]["revisionDisposition"] == "targeted" {
        return false;
    }
    requires_revision(job)
        && !arr(job, "plans").iter().any(|plan| {
            plan["trigger"]["source"] == "review"
                && plan["trigger"]["reviewTaskId"] == id
                && plan["status"] != "FAILED"
        })
}
pub fn review_plan_ready(job: &Value) -> bool {
    let plans = arr(job, "plans");
    let tasks = arr(job, "tasks");
    if plans.iter().any(|p| p["status"] == "PLANNING") {
        return false;
    }
    let latest = plans.last();
    let legacy = latest.is_none()
        && tasks
            .iter()
            .any(|t| t["kind"] == "planner" && t["state"] == "SUCCEEDED");
    if !legacy && latest.is_some_and(|p| p["status"] != "SUCCEEDED") {
        return false;
    }
    if !tasks.iter().any(|t| t["kind"] != "planner" && !reviewer(t)) {
        return false;
    }
    let Some(id) = task_id(job) else { return true };
    if job["review"]["revisionDisposition"] == "targeted" || !requires_revision(job) {
        return true;
    }
    plans.iter().any(|p| {
        p["status"] == "SUCCEEDED"
            && p["trigger"]["source"] == "review"
            && p["trigger"]["reviewTaskId"] == id
            && p["generatedTaskIds"].as_array().is_some_and(|ids| {
                !ids.is_empty()
                    && ids.iter().all(|id| {
                        tasks
                            .iter()
                            .any(|task| task["id"] == *id && task["state"] == "SUCCEEDED")
                    })
            })
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn empty_jobs() {
        assert!(!review_needs_replan(&json!({})));
        assert!(!review_plan_ready(&json!({})));
    }
    #[test]
    fn review_without_plan() {
        let j = json!({"tasks":[{"kind":"work","agentName":"worker","state":"SUCCEEDED"}]});
        assert!(review_plan_ready(&j));
    }
    #[test]
    fn immutable_replan() {
        let j = json!({"review":{"taskId":"12","outcome":"changes_required"},"tasks":[{"kind":"work","state":"SUCCEEDED"}],"plans":[]});
        assert!(review_needs_replan(&j));
        assert!(!review_plan_ready(&j));
    }
}
