// Direct pure facts and reducer of src/review-revision-settlement.ts.
// Caller must place the reducer inside an authoritative SQLite mutateJob transaction.
// Graph owns revision.settled transition and approval boundaries.
use crate::local_merge_lock::iso8601_now;
use crate::review_revision_policy::repeated_finding_rounds;
use crate::task_comments::append_task_comment;
use crate::workflow::review_v2::decide_review_lifecycle;
use serde_json::{json, Value};
use std::path::Path;
fn arr<'a>(v: &'a Value, k: &str) -> &'a [Value] {
    v[k].as_array().map(Vec::as_slice).unwrap_or(&[])
}
pub fn settlement_facts(
    job: &Value,
    task_id: &str,
    max_rounds: u64,
    max_no_progress_rounds: u64,
) -> Value {
    let requests = arr(job, "reviewRevisionRequests")
        .iter()
        .filter(|r| r["reviewTaskId"] == task_id)
        .collect::<Vec<_>>();
    let verified = !requests.is_empty()
        && requests.iter().all(|r| {
            r["status"] == "verified"
                && arr(job, "tasks")
                    .iter()
                    .any(|t| t["id"] == r["revisionTaskId"] && t["state"] == "SUCCEEDED")
        });
    let rounds = arr(job, "reviewRevisionRounds")
        .iter()
        .filter(|r| r["status"] == "changes_required")
        .collect::<Vec<_>>();
    let current = rounds.iter().find(|r| r["reviewTaskId"] == task_id);
    json!({"targetedRevisionsVerified":verified,"reviewRoundWithinLimit":rounds.len()<(max_rounds as usize),
        "reviewNoProgressWithinLimit":current.is_none_or(|r|repeated_finding_rounds(job,r)<max_no_progress_rounds)})
}
pub fn settle_review_revision_round(
    root: &Path,
    job: &mut Value,
    max_rounds: u64,
    max_no_progress_rounds: u64,
) -> Result<bool, String> {
    let review = job["review"].clone();
    let id = review["taskId"].as_str().unwrap_or("");
    if review["outcome"] != "changes_required"
        || review["revisionDisposition"] != "targeted"
        || id.is_empty()
    {
        return Ok(false);
    }
    let facts = settlement_facts(job, id, max_rounds, max_no_progress_rounds);
    let decision =
        decide_review_lifecycle(root, Some("changes_required"), "revision.settled", &facts)?;
    if decision["accepted"] != true {
        return Ok(false);
    }
    let actions = decision["actions"].as_array();
    let has = |name: &str| actions.is_some_and(|a| a.iter().any(|v| v["id"] == name));
    let prepare = decision["target"] == "STALE" && has("review.prepareRereview");
    let exhausted =
        decision["target"] == "CHANGES_REQUIRED" && has("review.requireOwnerResolution");
    if !prepare && !exhausted {
        return Ok(false);
    }
    if job["review"] != review
        || settlement_facts(job, id, max_rounds, max_no_progress_rounds) != facts
    {
        return Ok(false);
    }
    let now = iso8601_now();
    if exhausted {
        job["review"]["revisionDisposition"] = json!("needs-ownership");
        job["review"]["updatedAt"] = json!(now);
        let reason = if facts["reviewRoundWithinLimit"] == false {
            format!("Targeted review loop reached its configured {max_rounds}-round limit")
        } else {
            format!("The same blocking findings recurred without progress {max_no_progress_rounds} time(s)")
        };
        append_task_comment(job,id,&format!("{reason}; explicit Planner/owner recovery required. No approval or merge authorized."),
            &json!({"author":"relay","idempotencyKey":format!("review-round-limit/{id}")}))?;
    } else {
        job["review"]["outcome"] = json!("stale");
        job["review"]["updatedAt"] = json!(now);
    }
    Ok(true)
}

/// Node settleReviewRevisionRound preflights the graph against the supplied
/// snapshot, then fences the immutable review head and facts inside mutateJob.
/// A concurrent generation or fact update cannot authorize a stale verdict.
pub fn settle_review_revision_round_atomic<W, E>(
    store: &mut crate::relay_workflow_operations::SQLiteWorkflowOperations<'_, W, E>,
    graph_dir: &Path,
    job_id: &str,
    snapshot: &Value,
    max_rounds: u64,
    max_no_progress_rounds: u64,
) -> Result<Value, String>
where
    W: FnMut(&Value, &str) -> Result<(), String>,
    E: FnMut(&Value, &str) -> Result<(), String>,
{
    let review = &snapshot["review"];
    let Some(task_id) = review["taskId"].as_str().filter(|s| !s.is_empty()) else {
        return Ok(snapshot.clone());
    };
    if review["outcome"] != "changes_required" || review["revisionDisposition"] != "targeted" {
        return Ok(snapshot.clone());
    }
    let facts = settlement_facts(snapshot, task_id, max_rounds, max_no_progress_rounds);
    let decision = decide_review_lifecycle(
        graph_dir,
        Some("changes_required"),
        "revision.settled",
        &facts,
    )?;
    let actions = decision["actions"].as_array();
    let prepare = decision["target"] == "STALE"
        && actions.is_some_and(|a| a.iter().any(|v| v["id"] == "review.prepareRereview"));
    let exhausted = decision["target"] == "CHANGES_REQUIRED"
        && actions.is_some_and(|a| a.iter().any(|v| v["id"] == "review.requireOwnerResolution"));
    if decision["accepted"] != true || (!prepare && !exhausted) {
        return Ok(snapshot.clone());
    }
    store.mutate_job(job_id, |mut current| {
        let live = &current["review"];
        if live["outcome"] != "changes_required"
            || live["revisionDisposition"] != "targeted"
            || live["taskId"] != review["taskId"]
            || live["headSha"] != review["headSha"]
            || settlement_facts(&current, task_id, max_rounds, max_no_progress_rounds) != facts
        {
            return Ok(current);
        }
        settle_review_revision_round(graph_dir, &mut current, max_rounds, max_no_progress_rounds)?;
        Ok(current)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn requires_verified_child() {
        let j = json!({"reviewRevisionRequests":[{"reviewTaskId":"r","status":"verified","revisionTaskId":"c"}],"tasks":[{"id":"c","state":"FAILED"}]});
        assert_eq!(
            settlement_facts(&j, "r", 5, 1)["targetedRevisionsVerified"],
            false
        );
    }
}
