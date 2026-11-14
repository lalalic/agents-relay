//! Final Review readiness facts and canonical Review Graph evaluation.
//! This module returns a *proposal only*: the real reviewer Task must be
//! constructed, routed, executed, verified and durably accepted elsewhere.
//! It never manufactures an approval/merge receipt from a task exit status.
use crate::graph::{ActionDecision, Decision, Graph, GraphInput};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;

fn reviewer(task: &Value) -> bool {
    matches!(
        task.get("agentName").and_then(Value::as_str),
        Some("job-acceptance-reviewer" | "reviewer")
    )
}
fn terminal(task: &Value) -> bool {
    matches!(
        task.get("state").and_then(Value::as_str),
        Some("SUCCEEDED" | "FAILED" | "CANCELLED")
    )
}
fn normal_work(task: &Value) -> bool {
    task.get("kind").and_then(Value::as_str) != Some("planner") && !reviewer(task)
}
fn unresolved(task: &Value) -> bool {
    matches!(
        task.get("resolution")
            .and_then(|r| r.get("state"))
            .and_then(Value::as_str),
        Some("active" | "waiting")
    )
}
fn review_plan_ready(job: &Value, tasks: &[Value]) -> bool {
    let plans = job
        .get("plans")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    if plans.iter().any(|p| p["status"] == "PLANNING") {
        return false;
    }
    let legacy = plans.is_empty()
        && tasks
            .iter()
            .any(|t| t["kind"] == "planner" && t["state"] == "SUCCEEDED");
    if !legacy && plans.last().is_some_and(|p| p["status"] != "SUCCEEDED") {
        return false;
    }
    if !tasks.iter().any(normal_work) {
        return false;
    }
    let review = &job["review"];
    let review_id = review["taskId"].as_str();
    if review_id.is_none() || review["revisionDisposition"] == "targeted" {
        return true;
    }
    let requires_revision = review["outcome"] == "changes_required"
        || (review["outcome"] == "stale"
            && job
                .get("reviewRevisionRounds")
                .and_then(Value::as_array)
                .is_some_and(|rounds| {
                    rounds.iter().any(|r| {
                        r["reviewTaskId"] == review["taskId"] && r["status"] == "changes_required"
                    })
                }));
    if !requires_revision {
        return true;
    }
    plans.iter().any(|p| {
        p["status"] == "SUCCEEDED"
            && p["trigger"]["source"] == "review"
            && p["trigger"]["reviewTaskId"] == review["taskId"]
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
/// Port the read-only Troubleshooter pending facts used by the TypeScript
/// reviewWorkSettled gate. No recovery Task is created here; the Troubleshooter
/// Graph remains responsible for selecting that action.
fn recovery_barrier_pending(tasks: &[Value]) -> bool {
    for original in tasks
        .iter()
        .filter(|t| normal_work(t) && t["agentName"] != "troubleshooter" && t["state"] == "FAILED")
    {
        let recoveries = tasks
            .iter()
            .filter(|t| t["agentName"] == "troubleshooter" && t["parentTaskId"] == original["id"])
            .collect::<Vec<_>>();
        if recoveries.is_empty() {
            return true;
        }
        if recoveries.iter().any(|r| {
            matches!(
                r["state"].as_str(),
                Some("DRAFT" | "QUEUED" | "RUNNING" | "BLOCKED")
            )
        }) {
            continue; // The ordinary terminal check below handles this.
        }
        let latest = recoveries
            .iter()
            .max_by_key(|r| r["recoveryForAttempt"].as_i64().unwrap_or(-1));
        if latest.is_some_and(|r| {
            matches!(r["state"].as_str(), Some("SUCCEEDED" | "CANCELLED"))
                && r["recoveryForAttempt"].as_i64().unwrap_or(-1)
                    < original["attempt"].as_i64().unwrap_or(0)
        }) {
            return true;
        }
        if recoveries.iter().any(|r| {
            r["state"] == "FAILED"
                && r["attempt"].as_i64().unwrap_or(0) < r["maxAttempts"].as_i64().unwrap_or(0)
        }) {
            return true;
        }
    }
    false
}
fn review_work_settled(tasks: &[Value]) -> bool {
    let work = tasks
        .iter()
        .filter(|task| normal_work(task))
        .collect::<Vec<_>>();
    work.iter()
        .any(|task| task["agentName"] != "troubleshooter")
        && work.iter().all(|task| terminal(task) && !unresolved(task))
        && !recovery_barrier_pending(tasks)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalReviewProposal {
    pub job_id: String,
    pub head_sha: String,
    pub source: String,
    pub target: Option<String>,
    pub actions: Vec<ActionDecision>,
    pub facts: HashMap<String, bool>,
    pub allowed: bool,
}

/// `verified_local_head` must come from a caller-owned *local Git* adapter,
/// not remote GitHub projection, task input, or an untrusted review callback.
pub fn propose_final_review(
    job: &Value,
    verified_local_head: &str,
) -> Result<FinalReviewProposal, String> {
    if verified_local_head.len() > 256 || verified_local_head.chars().any(char::is_whitespace) {
        return Err("invalid verified local Git head".into());
    }
    let job_id = job
        .get("id")
        .and_then(Value::as_str)
        .ok_or("Final Review Job ID missing")?;
    let tasks = job
        .get("tasks")
        .and_then(Value::as_array)
        .ok_or("Final Review Job Tasks missing")?;
    let head = verified_local_head;
    let matches_head = |task: &&Value| task["reviewHeadSha"].as_str() == Some(head);
    let matching = tasks
        .iter()
        .filter(|task| reviewer(task) && matches_head(task))
        .collect::<Vec<_>>();
    let current = job["review"]["taskId"]
        .as_str()
        .and_then(|id| tasks.iter().find(|task| task["id"] == id));
    let work_ready = review_work_settled(tasks);
    let facts = HashMap::from([
        ("reviewEnabled".into(), job["reviewEnabled"] != false),
        (
            "jobActive".into(),
            job["state"] == "ACTIVE" || job["projectionRecovery"]["status"] == "repairing",
        ),
        ("reviewWorkSettled".into(), work_ready),
        ("headAvailable".into(), !head.is_empty()),
        ("reviewPlanReady".into(), review_plan_ready(job, tasks)),
        (
            "noActiveReviewTask".into(),
            !matching
                .iter()
                .any(|task| matches!(task["state"].as_str(), Some("DRAFT" | "QUEUED" | "RUNNING"))),
        ),
        (
            "currentReviewCancelled".into(),
            current
                .is_some_and(|task| task["reviewHeadSha"] == head && task["state"] == "CANCELLED"),
        ),
        (
            "noApprovedCurrentReview".into(),
            !matching.iter().any(|task| {
                task["state"] == "SUCCEEDED"
                    && job["review"]["headSha"] == head
                    && job["review"]["outcome"] == "approved"
            }),
        ),
    ]);
    let state = job["review"]["outcome"]
        .as_str()
        .unwrap_or("none")
        .to_ascii_uppercase();
    let source = if job["review"].is_null() {
        "NONE".into()
    } else {
        state
    };
    let graph = Graph::parse(include_str!("../../workflow/review-lifecycle.mmd"))?;
    let decision = graph.decide(
        &source,
        GraphInput {
            transport: "event".into(),
            id: "reconcile".into(),
            payload: json!({}),
        },
        &facts,
    )?;
    let (target, actions) = match decision {
        Decision::Accepted {
            target, actions, ..
        } => (Some(target), actions),
        Decision::Rejected { .. } => (None, vec![]),
    };
    // This flag is not an independent policy decision: it only identifies
    // the single action chosen by the canonical Review Graph.
    let allowed = target.as_deref() == Some("PENDING")
        && actions.len() == 1
        && actions[0].id == "review.create";
    Ok(FinalReviewProposal {
        job_id: job_id.into(),
        head_sha: head.into(),
        source,
        target,
        actions,
        facts,
        allowed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn basic() -> Value {
        json!({"id":"91","state":"ACTIVE","tasks":[
        {"id":"101","agentName":"editor","kind":"work","state":"SUCCEEDED"}],
        "plans":[],"reviewEnabled":true})
    }
    #[test]
    fn only_graph_selects_review_create_after_settlement() {
        let mut job = basic();
        let ready = propose_final_review(&job, "0123456").unwrap();
        assert!(ready.allowed);
        assert_eq!(ready.actions[0].id, "review.create");
        job["tasks"][0]["state"] = json!("RUNNING");
        assert!(!propose_final_review(&job, "0123456").unwrap().allowed);
        job["tasks"][0]["state"] = json!("SUCCEEDED");
        job["plans"] = json!([{"status":"PLANNING"}]);
        assert!(!propose_final_review(&job, "0123456").unwrap().allowed);
        job["plans"] = json!([]);
        job["review"] = json!({"outcome":"pending","headSha":"0123456","taskId":"102"});
        job["tasks"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id":"102","agentName":"job-acceptance-reviewer",
            "reviewHeadSha":"0123456","state":"RUNNING","kind":"work"}));
        assert!(!propose_final_review(&job, "0123456").unwrap().allowed);
    }
    #[test]
    fn final_review_is_head_fenced_and_no_approval_is_inferred() {
        let mut job = basic();
        job["review"] = json!({"outcome":"approved","headSha":"HEAD-A","taskId":"102"});
        job["tasks"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id":"102","agentName":"reviewer",
            "reviewHeadSha":"HEAD-A","state":"SUCCEEDED","kind":"work"}));
        let approved = propose_final_review(&job, "HEAD-A").unwrap();
        assert!(!approved.allowed, "never repeat approved current Review");
        assert!(!approved
            .actions
            .iter()
            .any(|action| action.id == "review.requestMerge"));
        assert!(
            !propose_final_review(&job, "HEAD-B").unwrap().allowed,
            "head change must pass through review.head.changed before new Review"
        );
        assert!(propose_final_review(&job, " ").is_err());
    }
}
