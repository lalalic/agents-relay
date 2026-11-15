//! Only verified, durable host decisions may resume native Agent Tasks.
use super::NativeTick;
use crate::authority::RelayAuthority;
use crate::graph::{Decision, Graph, GraphInput};
use crate::supervised_script::after_time;
use serde_json::json;
use std::collections::HashMap;

fn valid_git_sha(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

/// A host Review receipt is not an approval until it is durably accepted
/// by the interactive Graph and the host-invocation ledger. This staged
/// daemon resumes either accepted decision on the same Task; changes_requested
/// routes into a semantic revision and is never auto-completed.
pub(crate) fn resume_accepted_native_reviews(
    authority: &mut RelayAuthority,
    job_id: &str,
    report: &mut NativeTick,
) -> Result<(), String> {
    let snapshot = authority.read_job(job_id)?.ok_or("Review Job missing")?;
    let pending: Vec<(String, String)> = snapshot["tasks"]
        .as_array()
        .ok_or("Review Tasks missing")?
        .iter()
        .filter(|task| task["state"] == "AWAITING_DECISION")
        .filter_map(|task| {
            Some((
                task["id"].as_str()?.to_owned(),
                task.get("interactiveInvocation")?
                    .get("status")?
                    .as_str()?
                    .to_owned(),
            ))
        })
        .collect();
    for (task_id, status) in pending {
        if !matches!(status.as_str(), "approved" | "changes_requested") {
            continue;
        }
        let job = authority
            .read_job(job_id)?
            .ok_or("Review Job missing before resume")?;
        let at = after_time(
            job["updatedAt"]
                .as_str()
                .ok_or("Review Job timestamp missing")?,
        )?;
        match authority.resume_review_task(job_id, &task_id, &at) {
            Ok(_) => report.reviews_resumed += 1,
            Err(error) => report.blocked.push(format!(
                "{job_id}/{task_id}: Review ledger not accepted: {error}"
            )),
        }
    }
    Ok(())
}

/// Consume a durable reviewer Task result through the canonical Review Graph.
/// A worker receipt is evidence only: it must carry the exact immutable head
/// bound to the current reviewer Task, and the Graph must accept its verdict.
pub(crate) fn apply_native_reviewer_result(
    authority: &mut RelayAuthority,
    job_id: &str,
) -> Result<bool, String> {
    let snapshot = authority.read_job(job_id)?.ok_or("Review Job missing")?;
    let review = &snapshot["review"];
    let Some(task_id) = review["taskId"].as_str() else {
        return Ok(false);
    };
    let Some(task) = snapshot["tasks"]
        .as_array()
        .and_then(|tasks| tasks.iter().find(|task| task["id"] == task_id))
    else {
        return Err("bound Review Task missing".into());
    };
    if !matches!(
        task["agentName"].as_str(),
        Some("job-acceptance-reviewer" | "reviewer")
    ) || task["state"] != "SUCCEEDED"
        || task["reviewHeadSha"].as_str().is_none()
    {
        return Ok(false);
    }
    let head = task["reviewHeadSha"]
        .as_str()
        .ok_or("Review head missing")?;
    if !valid_git_sha(head)
        || snapshot["headSha"].as_str() != Some(head)
        || review["headSha"] != head
    {
        return Ok(false);
    }
    let data = task
        .pointer("/result/data/output")
        .ok_or("Reviewer output missing")?;
    let verdict = data["verdict"].as_str().ok_or("Reviewer verdict missing")?;
    let submitted_head = data["head_sha"]
        .as_str()
        .or_else(|| data["headSha"].as_str())
        .ok_or("Reviewer immutable head missing")?;
    if submitted_head != head {
        return Err("Reviewer verdict head does not match its immutable Task target".into());
    }
    let (event, expected_outcome) = match verdict {
        "approved" | "pass" => ("review.approved", "approved"),
        "changes-required" | "changes_required" => ("review.changes_required", "changes_required"),
        _ => return Err("unsupported Reviewer verdict".into()),
    };
    let findings = data.get("findings").cloned().unwrap_or_else(|| json!([]));
    if expected_outcome == "approved" && findings.as_array().is_none_or(|items| !items.is_empty()) {
        return Err("approved Reviewer verdict cannot contain blocking findings".into());
    }
    if expected_outcome == "changes_required"
        && findings.as_array().is_none_or(|items| {
            items.is_empty()
                || items.iter().any(|item| {
                    item["id"]
                        .as_str()
                        .is_none_or(|value| value.trim().is_empty())
                        || item["summary"]
                            .as_str()
                            .is_none_or(|value| value.trim().is_empty())
                })
        })
    {
        return Err(
            "changes-required Reviewer verdict needs identified actionable findings".into(),
        );
    }
    let current_outcome = review["outcome"]
        .as_str()
        .unwrap_or("none")
        .to_ascii_uppercase();
    let graph = Graph::parse(include_str!("../../../workflow/review-lifecycle.mmd"))?;
    let decision = graph.decide(
        &current_outcome,
        GraphInput {
            transport: "event".into(),
            id: event.into(),
            payload: json!({"head_sha":head,"findings":findings}),
        },
        &HashMap::from([
            ("autoMerge".into(), snapshot["autoMerge"] != false),
            ("targetedRevisionRequestsReady".into(), false),
        ]),
    )?;
    let Decision::Accepted {
        target, actions, ..
    } = decision
    else {
        return Ok(false);
    };
    let selected_effect_matches = match expected_outcome {
        "approved" => actions.is_empty(),
        "changes_required" => {
            actions.len() == 1 && actions[0].id == "review.requireOwnerResolution"
        }
        _ => false,
    };
    if target != expected_outcome.to_ascii_uppercase() || !selected_effect_matches {
        return Err("Review Graph selected an unsupported native effect".into());
    }
    let at = after_time(
        snapshot["updatedAt"]
            .as_str()
            .ok_or("Review Job timestamp missing")?,
    )?;
    let mut committed = false;
    authority.commit_job(job_id, &at, |current| {
        let current_review = &current["review"];
        let current_task = current["tasks"]
            .as_array()
            .and_then(|tasks| tasks.iter().find(|task| task["id"] == task_id));
        if current["state"] != "ACTIVE"
            || current["headSha"].as_str() != Some(head)
            || current_review["taskId"] != task_id
            || current_review["headSha"] != head
            || current_task.is_none_or(|task| task["state"] != "SUCCEEDED" || task["reviewHeadSha"] != head)
            || current_review["outcome"].as_str().unwrap_or("none").to_ascii_uppercase() != current_outcome
        {
            return Ok((current.clone(), vec![]));
        }
        let mut next = current.clone();
        next["review"] = json!({
            "outcome":expected_outcome,
            "headSha":head,
            "taskId":task_id,
            "evidence":{"summary":format!("Review {expected_outcome}"),"data":data},
            "updatedAt":at,
            "revisionDisposition":if expected_outcome == "changes_required" {"needs-ownership"} else {"none"}
        });
        next["updatedAt"] = json!(at);
        committed = true;
        Ok((next, vec![]))
    })?;
    Ok(committed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use serde_json::Value;
    use tempfile::tempdir;

    const AT: &str = "2026-11-15T11:00:00.000Z";
    const HEAD: &str = "0123456789abcdef0123456789abcdef01234567";

    fn authority_with_bound_head(
        verdict: &str,
        submitted_head: &str,
        findings: Value,
        bound_head: &str,
    ) -> (tempfile::TempDir, RelayAuthority) {
        let dir = tempdir().unwrap();
        let path = dir.path().join("relay.sqlite");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL);").unwrap();
        let job = json!({
            "id":"91","repository":"example","state":"ACTIVE","updatedAt":AT,"headSha":bound_head,
            "reviewEnabled":true,"autoMerge":false,
            "review":{"outcome":"pending","headSha":bound_head,"taskId":"review-1","evidence":null,"updatedAt":AT},
            "tasks":[{"id":"review-1","agentName":"job-acceptance-reviewer","state":"SUCCEEDED",
                "reviewHeadSha":bound_head,"result":{"summary":"review completed","data":{"output":{
                    "verdict":verdict,"head_sha":submitted_head,"findings":findings
                }}}}]
        });
        conn.execute(
            "INSERT INTO job_snapshot(job_id,json,updated_at) VALUES('91',?1,?2)",
            rusqlite::params![job.to_string(), AT],
        )
        .unwrap();
        drop(conn);
        let authority = RelayAuthority::open_existing(&path).unwrap();
        (dir, authority)
    }

    fn authority(
        verdict: &str,
        submitted_head: &str,
        findings: Value,
    ) -> (tempfile::TempDir, RelayAuthority) {
        authority_with_bound_head(verdict, submitted_head, findings, HEAD)
    }

    #[test]
    fn reviewer_approval_is_graph_selected_head_bound_and_restart_deduped() {
        let (dir, mut authority) = authority("approved", HEAD, json!([]));
        assert!(apply_native_reviewer_result(&mut authority, "91").unwrap());
        assert_eq!(
            authority.read_job("91").unwrap().unwrap()["review"]["outcome"],
            "approved"
        );
        assert_eq!(
            authority.read_job("91").unwrap().unwrap()["state"],
            "ACTIVE"
        );
        drop(authority);
        let mut restarted =
            RelayAuthority::open_existing(&dir.path().join("relay.sqlite")).unwrap();
        assert!(!apply_native_reviewer_result(&mut restarted, "91").unwrap());
        assert_eq!(
            restarted.read_job("91").unwrap().unwrap()["state"],
            "ACTIVE"
        );
    }

    #[test]
    fn changes_required_requires_actionable_findings_and_records_owner_gate() {
        let (_dir, mut authority) = authority(
            "changes-required",
            HEAD,
            json!([{"id":"F1","summary":"Fix the rejected lifecycle transition"}]),
        );
        assert!(apply_native_reviewer_result(&mut authority, "91").unwrap());
        let job = authority.read_job("91").unwrap().unwrap();
        assert_eq!(job["review"]["outcome"], "changes_required");
        assert_eq!(job["review"]["revisionDisposition"], "needs-ownership");
        assert_eq!(job["state"], "ACTIVE");
    }

    #[test]
    fn stale_head_and_false_approval_are_rejected_without_mutation() {
        let (_dir, mut stale) = authority("approved", "stale-head", json!([]));
        assert!(apply_native_reviewer_result(&mut stale, "91").is_err());
        assert_eq!(
            stale.read_job("91").unwrap().unwrap()["review"]["outcome"],
            "pending"
        );

        let (_dir, mut false_approval) = authority(
            "approved",
            HEAD,
            json!([{"id":"F1","summary":"unresolved blocking defect"}]),
        );
        assert!(apply_native_reviewer_result(&mut false_approval, "91").is_err());
        assert_eq!(
            false_approval.read_job("91").unwrap().unwrap()["review"]["outcome"],
            "pending"
        );
    }

    #[test]
    fn malformed_sha_and_blank_finding_are_rejected() {
        let (_dir, mut malformed_sha) =
            authority_with_bound_head("approved", "not-a-git-sha", json!([]), "not-a-git-sha");
        assert!(!apply_native_reviewer_result(&mut malformed_sha, "91").unwrap());
        assert_eq!(
            malformed_sha.read_job("91").unwrap().unwrap()["review"]["outcome"],
            "pending"
        );

        let (_dir, mut blank_finding) = authority(
            "changes-required",
            HEAD,
            json!([{"id":"F1","summary":"  "}]),
        );
        assert!(apply_native_reviewer_result(&mut blank_finding, "91").is_err());
        assert_eq!(
            blank_finding.read_job("91").unwrap().unwrap()["review"]["outcome"],
            "pending"
        );
    }

    #[test]
    fn graph_selected_merge_is_not_silently_treated_as_plain_approval() {
        let (_dir, mut authority) = authority("approved", HEAD, json!([]));
        authority
            .commit_job("91", "2026-11-15T11:00:00.001Z", |current| {
                let mut next = current.clone();
                next["autoMerge"] = json!(true);
                next["updatedAt"] = json!("2026-11-15T11:00:00.001Z");
                Ok((next, vec![]))
            })
            .unwrap();
        assert!(apply_native_reviewer_result(&mut authority, "91").is_err());
        assert_eq!(
            authority.read_job("91").unwrap().unwrap()["review"]["outcome"],
            "pending"
        );
    }
}
