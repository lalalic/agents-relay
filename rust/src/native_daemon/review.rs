//! Only verified, durable host decisions may resume native Agent Tasks.
use super::adapter::{NativeAdapterKind, ScriptManifest};
use super::NativeTick;
use crate::authority::NativeTaskSpec;
use crate::authority::RelayAuthority;
use crate::final_review::propose_final_review;
use crate::graph::{Decision, Graph, GraphInput};
use crate::local_git::verified_local_head;
use crate::supervised_script::after_time;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;

fn valid_git_sha(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

pub(crate) fn reconcile_native_final_review(
    authority: &mut RelayAuthority,
    job_id: &str,
    isolated_root: &Path,
    agents: &ScriptManifest,
    report: &mut NativeTick,
) -> Result<(), String> {
    let snapshot = authority.read_job(job_id)?.ok_or("Review Job missing")?;
    if snapshot["reviewEnabled"] == false {
        return Ok(());
    }
    let Some(project_root) = snapshot["projectRoot"].as_str() else {
        return Ok(());
    };
    let Ok(project_root) = Path::new(project_root).canonicalize() else {
        return Ok(());
    };
    if !project_root.starts_with(isolated_root) || !project_root.join(".git").exists() {
        return Ok(());
    }
    let head = match verified_local_head(&project_root) {
        Ok(head) => head,
        Err(error) => {
            report
                .blocked
                .push(format!("{job_id}: local Review head unavailable: {error}"));
            return Ok(());
        }
    };
    if snapshot["headSha"].as_str() != Some(&head) {
        if snapshot.get("review").is_none_or(Value::is_null)
            && snapshot
                .get("prNumber")
                .and_then(Value::as_i64)
                .unwrap_or(0)
                == 0
        {
            // With no prior review, the verified local Git HEAD is current
            // artifact evidence for a local-only Job. Persist the fact so the
            // Review Graph can evaluate creation on the next reconciliation.
            record_native_local_head(authority, job_id, &head)?;
            return Ok(());
        }
        if apply_native_review_head_changed(authority, job_id, &head)? {
            report.blocked.push(format!(
                "{job_id}: local Git head changed; previous Review is stale and must be re-created"
            ));
        }
        return Ok(());
    }
    let Some((name, reviewer)) = ["job-acceptance-reviewer", "reviewer"]
        .into_iter()
        .find_map(|name| agents.agents.get(name).map(|agent| (name, agent)))
    else {
        return Ok(());
    };
    if reviewer.kind != NativeAdapterKind::Model
        || reviewer.prompt_cli.is_none()
        || reviewer.prompt_node.is_none()
    {
        report.blocked.push(format!(
            "{job_id}: Final Review needs a trusted Model Reviewer and shared prompt Action"
        ));
        return Ok(());
    }
    let Some(routing) = reviewer.routing.as_ref() else {
        report
            .blocked
            .push(format!("{job_id}: Final Review Model route missing"));
        return Ok(());
    };
    let Some(selection) = reviewer.worker_selection.as_ref() else {
        report
            .blocked
            .push(format!("{job_id}: Final Review Worker selection missing"));
        return Ok(());
    };
    if schedule_native_final_review(authority, job_id, &head, name, routing, selection)? {
        report.reviews_queued += 1;
    }
    Ok(())
}

fn record_native_local_head(
    authority: &mut RelayAuthority,
    job_id: &str,
    head: &str,
) -> Result<bool, String> {
    if !valid_git_sha(head) {
        return Err("local Job head requires a full verified Git SHA".into());
    }
    let snapshot = authority.read_job(job_id)?.ok_or("Review Job missing")?;
    if snapshot
        .get("prNumber")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        != 0
        || snapshot.get("review").is_some_and(|value| !value.is_null())
        || snapshot["state"] != "ACTIVE"
        || snapshot.get("pause").is_some_and(|value| !value.is_null())
        || snapshot["headSha"].as_str() == Some(head)
    {
        return Ok(false);
    }
    let at = after_time(
        snapshot["updatedAt"]
            .as_str()
            .ok_or("Job timestamp missing")?,
    )?;
    let head = head.to_owned();
    authority.commit_job(job_id, &at, |current| {
        if current.get("prNumber").and_then(Value::as_i64).unwrap_or(0) != 0
            || current.get("review").is_some_and(|value| !value.is_null())
            || current["state"] != "ACTIVE"
            || current.get("pause").is_some_and(|value| !value.is_null())
            || current["headSha"] != snapshot["headSha"]
        {
            return Err("local Job head facts changed during observation".into());
        }
        let mut next = current.clone();
        next["headSha"] = json!(head);
        next["updatedAt"] = json!(at);
        Ok((next, vec![]))
    })?;
    Ok(true)
}

/// Apply a locally observed head change only through the canonical Review
/// Graph. The running reviewer generation is left to reach its correlated
/// terminal event; its old immutable SHA prevents its result from authorizing
/// the new head. Unleased queued reviewer work is cancelled by the Task Graph.
fn apply_native_review_head_changed(
    authority: &mut RelayAuthority,
    job_id: &str,
    new_head: &str,
) -> Result<bool, String> {
    if !valid_git_sha(new_head) {
        return Err("head.changed requires a full verified Git SHA".into());
    }
    let snapshot = authority.read_job(job_id)?.ok_or("Review Job missing")?;
    let Some(review) = snapshot.get("review").filter(|value| !value.is_null()) else {
        return Ok(false);
    };
    let Some(old_head) = review.get("headSha").and_then(Value::as_str) else {
        return Ok(false);
    };
    if old_head == new_head || snapshot["headSha"].as_str() == Some(new_head) {
        return Ok(false);
    }
    let outcome = review["outcome"].as_str().ok_or("Review outcome missing")?;
    let state = outcome.to_ascii_uppercase();
    let graph = Graph::parse(include_str!("../../../workflow/review-lifecycle.mmd"))?;
    let decision = graph.decide(
        &state,
        GraphInput {
            transport: "event".into(),
            id: "head.changed".into(),
            payload: json!({}),
        },
        &HashMap::new(),
    )?;
    let Decision::Accepted {
        target, actions, ..
    } = decision
    else {
        return Ok(false);
    };
    if target != "STALE" || actions.len() != 1 || actions[0].id != "review.cancelStale" {
        return Err("Review Graph selected an unsupported head-change effect".into());
    }
    let task_id = review
        .get("taskId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let stale_outcome = target.to_ascii_lowercase();
    let at = after_time(
        snapshot["updatedAt"]
            .as_str()
            .ok_or("Job timestamp missing")?,
    )?;
    let review_head = old_head.to_owned();
    let new_head = new_head.to_owned();
    let graph_text = include_str!("../../../workflow/task-lifecycle.mmd");
    let committed = authority.commit_job(job_id, &at, |current| {
        let current_review = current
            .get("review")
            .ok_or("Review missing during head change")?;
        if current["headSha"] != snapshot["headSha"]
            || current_review["headSha"] != review_head
            || current_review["taskId"] != review["taskId"]
            || current_review["outcome"] != outcome
        {
            return Err("Review changed while applying local head observation".into());
        }
        let mut next = current.clone();
        let review = next.get_mut("review").ok_or("Review missing")?;
        review["outcome"] = json!(stale_outcome);
        review["updatedAt"] = json!(at);
        next["headSha"] = json!(new_head);
        if let Some(task_id) = task_id.as_deref() {
            let task = next["tasks"]
                .as_array_mut()
                .and_then(|tasks| tasks.iter_mut().find(|task| task["id"] == task_id));
            if let Some(task) = task {
                if matches!(
                    task["agentName"].as_str(),
                    Some("reviewer" | "job-acceptance-reviewer")
                ) && task["reviewHeadSha"] == review_head
                    && matches!(task["state"].as_str(), Some("DRAFT" | "QUEUED"))
                    && task.get("executionId").is_none_or(Value::is_null)
                    && task.get("leaseOwner").is_none_or(Value::is_null)
                    && task.get("leaseExpiresAt").is_none_or(Value::is_null)
                {
                    let task_graph = Graph::parse(graph_text)?;
                    let task_decision = task_graph.decide(
                        task["state"].as_str().ok_or("Task state missing")?,
                        GraphInput {
                            transport: "event".into(),
                            id: "cancel".into(),
                            payload: json!({}),
                        },
                        &HashMap::new(),
                    )?;
                    let Decision::Accepted { target, .. } = task_decision else {
                        return Err("Task Graph denied stale reviewer cancellation".into());
                    };
                    if target != "CANCELLED" {
                        return Err("Task Graph selected an invalid stale-review state".into());
                    }
                    task["state"] = json!(target);
                    task["error"] =
                        json!("Review evidence became stale after the local Git head changed");
                    task["updatedAt"] = json!(at);
                }
            }
        }
        next["updatedAt"] = json!(at);
        Ok((next, vec![]))
    })?;
    Ok(committed.job["headSha"] == new_head)
}

/// Execute the already-selected Review Graph creation effect. The caller
/// supplies the SHA from the read-only local Git adapter and the trusted
/// Model route from the isolated executor manifest.
pub(crate) fn schedule_native_final_review(
    authority: &mut RelayAuthority,
    job_id: &str,
    head_sha: &str,
    reviewer_name: &str,
    routing: &Value,
    worker_selection: &Value,
) -> Result<bool, String> {
    if !matches!(reviewer_name, "reviewer" | "job-acceptance-reviewer") {
        return Err("native Final Review role is not an accepted Reviewer".into());
    }
    if !valid_git_sha(head_sha) {
        return Err("native Final Review requires a full verified local SHA".into());
    }
    let snapshot = authority.read_job(job_id)?.ok_or("Review Job missing")?;
    if snapshot["headSha"].as_str() != Some(head_sha) {
        return Ok(false);
    }
    let proposal = propose_final_review(&snapshot, head_sha)?;
    if !proposal.allowed || proposal.actions.len() != 1 || proposal.actions[0].id != "review.create"
    {
        return Ok(false);
    }
    let priority = snapshot["priority"].as_str().unwrap_or("P1");
    let at = after_time(
        snapshot["updatedAt"]
            .as_str()
            .ok_or("Job timestamp missing")?,
    )?;
    let input = format!(
        "# Final Review\nReview Job {job_id} at immutable Git head {head_sha}. Inspect the durable Job objective and terminal Task evidence. Return a structured verdict with `verdict` equal to `approved` or `changes_required`, `head_sha` exactly `{head_sha}`, and `findings` as an array. For changes_required, include actionable findings with stable `id` and non-empty `summary`. Do not claim approval for an unverified result."
    );
    authority.create_native_task(NativeTaskSpec {
        job_id,
        title: Some("Final Review"),
        input: &input,
        output_kind: "task-pr",
        output_path: None,
        priority,
        story_size: "L",
        parent_task_id: None,
        dependencies: &[],
        dependency_validity: None,
        draft: false,
        at: &at,
        agent_name: Some(reviewer_name),
        review_head_sha: Some(head_sha),
        routing: Some(routing),
        worker_selection: Some(worker_selection),
    })?;
    Ok(true)
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

/// Bind a trusted Model route to a same-Task interactive revision after the
/// Task Graph has accepted `interactive.resume`. Script routes are deliberately
/// not reused for semantic edits. This is idempotent so a daemon restart after
/// the resume transition but before route persistence can recover the Task.
pub(crate) fn reconcile_native_review_revision_routes(
    authority: &mut RelayAuthority,
    job_id: &str,
    agents: &ScriptManifest,
    report: &mut NativeTick,
) -> Result<usize, String> {
    let snapshot = authority.read_job(job_id)?.ok_or("Review Job missing")?;
    let candidates: Vec<(String, String)> = snapshot["tasks"]
        .as_array()
        .ok_or("Review Tasks missing")?
        .iter()
        .filter(|task| {
            task["state"] == "QUEUED"
                && task["adapter"] == "codex"
                && task["interactiveInvocation"]["status"] == "changes_requested"
                && task["routing"].is_null()
                && task["workerSelection"].is_null()
                && task["reviewRevisionOriginalExecutionConfig"].is_object()
                && task["reviewRevisionOriginalExecutionConfig"]["adapter"] != "codex"
        })
        .filter_map(|task| {
            Some((
                task["id"].as_str()?.to_owned(),
                task["agentName"].as_str()?.to_owned(),
            ))
        })
        .collect();
    let mut routed = 0;
    for (task_id, agent_name) in candidates {
        let Some(agent) = agents.agents.get(&agent_name) else {
            report.blocked.push(format!(
                "{job_id}/{task_id}: no trusted revision Model route for {agent_name}"
            ));
            continue;
        };
        let (Some(routing), Some(selection)) = (&agent.routing, &agent.worker_selection) else {
            report.blocked.push(format!(
                "{job_id}/{task_id}: trusted revision Model route or Worker selection missing for {agent_name}"
            ));
            continue;
        };
        if agent.kind != NativeAdapterKind::Model
            || agent.prompt_cli.is_none()
            || agent.prompt_node.is_none()
        {
            report.blocked.push(format!(
                "{job_id}/{task_id}: revision requires a trusted Model executor and shared prompt Action for {agent_name}"
            ));
            continue;
        }
        // A Job can have multiple same-Task revisions queued after one
        // decision. Each durable snapshot write needs a timestamp newer than
        // the prior write, so read the current snapshot for every candidate.
        let current_snapshot = authority
            .read_job(job_id)?
            .ok_or("Review Job missing during revision route binding")?;
        let at = after_time(
            current_snapshot["updatedAt"]
                .as_str()
                .ok_or("Review Job timestamp missing")?,
        )?;
        let route = routing.clone();
        let worker = selection.clone();
        let committed = authority.commit_job(job_id, &at, |current| {
            let task = current["tasks"]
                .as_array()
                .and_then(|tasks| tasks.iter().find(|task| task["id"] == task_id))
                .ok_or("Review revision Task missing")?;
            if current["state"] != "ACTIVE"
                || task["state"] != "QUEUED"
                || task["adapter"] != "codex"
                || task["interactiveInvocation"]["status"] != "changes_requested"
                || task.get("routing").is_some_and(|value| !value.is_null())
                || task
                    .get("workerSelection")
                    .is_some_and(|value| !value.is_null())
                || task["agentName"] != agent_name
                || task["reviewRevisionOriginalExecutionConfig"]["adapter"] == "codex"
            {
                return Ok((current.clone(), vec![]));
            }
            let mut next = current.clone();
            let task = next["tasks"]
                .as_array_mut()
                .and_then(|tasks| tasks.iter_mut().find(|task| task["id"] == task_id))
                .ok_or("Review revision Task missing")?;
            task["routing"] = route.clone();
            task["workerSelection"] = worker.clone();
            task["updatedAt"] = json!(at);
            next["updatedAt"] = json!(at);
            Ok((next, vec![]))
        })?;
        if committed.job["tasks"].as_array().is_some_and(|tasks| {
            tasks.iter().any(|task| {
                task["id"] == task_id
                    && task["routing"] == route
                    && task["workerSelection"] == worker
            })
        }) {
            routed += 1;
        }
    }
    report.review_revision_routes += routed;
    Ok(routed)
}

/// Consume a durable reviewer Task result through the canonical Review Graph.
/// A worker receipt is evidence only: it must carry the exact immutable head
/// bound to the current reviewer Task, and the Graph must accept its verdict.
pub(crate) fn apply_native_reviewer_result(
    authority: &mut RelayAuthority,
    job_id: &str,
) -> Result<bool, String> {
    let snapshot = authority.read_job(job_id)?.ok_or("Review Job missing")?;
    if snapshot["reviewEnabled"] == false {
        return Ok(false);
    }
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
        // The Node action records the merge request as review state; actual
        // local delivery/completion is a separate Job Graph reconciliation.
        // PR-backed merge delivery remains unsupported here and therefore
        // cannot complete through this Review action.
        "approved" => {
            actions.is_empty() || (actions.len() == 1 && actions[0].id == "review.requestMerge")
        }
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
            || current_task
                .is_none_or(|task| task["state"] != "SUCCEEDED" || task["reviewHeadSha"] != head)
            || current_review["outcome"]
                .as_str()
                .unwrap_or("none")
                .to_ascii_uppercase()
                != current_outcome
        {
            return Ok((current.clone(), vec![]));
        }
        let mut next = current.clone();
        next["review"] = json!({
            "outcome":expected_outcome,
            "headSha":head,
            "taskId":task_id,
            "evidence":{"summary":format!("Review {expected_outcome}"),"data":data},
            "updatedAt":at
        });
        if expected_outcome == "changes_required" {
            next["review"]["revisionDisposition"] = json!("needs-ownership");
        }
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

    fn review_ready_authority() -> (tempfile::TempDir, RelayAuthority) {
        let dir = tempdir().unwrap();
        let path = dir.path().join("relay.sqlite");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL);").unwrap();
        let job = json!({
            "id":"91","repository":"example","title":"Review fixture","priority":"P1",
            "projectRoot":dir.path(),"state":"ACTIVE","updatedAt":AT,"headSha":HEAD,
            "reviewEnabled":true,"autoMerge":false,"plans":[],"review":null,
            "tasks":[{"id":"work-1","kind":"work","agentName":"implementation",
                "state":"SUCCEEDED","dependencies":[],"attempt":1,"maxAttempts":3}]
        });
        conn.execute(
            "INSERT INTO job_snapshot(job_id,json,updated_at) VALUES('91',?1,?2)",
            rusqlite::params![job.to_string(), AT],
        )
        .unwrap();
        drop(conn);
        (dir, RelayAuthority::open_existing(&path).unwrap())
    }

    #[test]
    fn reviewer_approval_is_graph_selected_head_bound_and_restart_deduped() {
        let (dir, mut authority) = authority("approved", HEAD, json!([]));
        assert!(apply_native_reviewer_result(&mut authority, "91").unwrap());
        assert_eq!(
            authority.read_job("91").unwrap().unwrap()["review"]["outcome"],
            "approved"
        );
        assert!(authority.read_job("91").unwrap().unwrap()["review"]
            .get("revisionDisposition")
            .is_none());
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
    fn requeued_script_revision_recovers_trusted_model_route_after_restart() {
        use super::super::adapter::NativeScriptAdapter;
        use std::collections::BTreeMap;
        use std::path::PathBuf;

        let dir = tempdir().unwrap();
        let path = dir.path().join("relay.sqlite");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL);").unwrap();
        let job = json!({
            "id":"91","repository":"example","state":"ACTIVE","updatedAt":AT,
            "review":{"outcome":"changes_required","taskId":"review-1","revisionDisposition":"needs-ownership"},
            "tasks":[{"id":"work-1","kind":"work","agentName":"implementation",
                "state":"QUEUED","adapter":"codex","routing":null,"workerSelection":null,
                "interactiveInvocation":{"status":"changes_requested"},
                "reviewRevisionOriginalExecutionConfig":{"adapter":"script"}},
                {"id":"work-2","kind":"work","agentName":"implementation",
                "state":"QUEUED","adapter":"codex","routing":null,"workerSelection":null,
                "interactiveInvocation":{"status":"changes_requested"},
                "reviewRevisionOriginalExecutionConfig":{"adapter":"script"}}]
        });
        conn.execute(
            "INSERT INTO job_snapshot(job_id,json,updated_at) VALUES('91',?1,?2)",
            rusqlite::params![job.to_string(), AT],
        )
        .unwrap();
        drop(conn);
        let prompt_cli = dir.path().join("cli.js");
        std::fs::write(&prompt_cli, "").unwrap();
        std::fs::write(dir.path().join("model-routing.js"), "").unwrap();
        let routing = json!({"provider":"fixture","model":"fixture-model",
            "decidedBy":"fixture-router","decidedAt":AT});
        let selection = json!({"workerId":"fixture-worker","adapter":"codex",
            "selectedBy":"fixture-router","selectedAt":AT,"capabilities":["model"]});
        let agents = ScriptManifest {
            agents: BTreeMap::from([(
                "implementation".into(),
                NativeScriptAdapter {
                    kind: NativeAdapterKind::Model,
                    executable: PathBuf::from("/bin/true"),
                    args: vec![],
                    env: BTreeMap::new(),
                    routing: Some(routing.clone()),
                    worker_selection: Some(selection.clone()),
                    prompt_cli: Some(prompt_cli),
                    prompt_node: Some(PathBuf::from("/usr/bin/node")),
                },
            )]),
        };
        let mut restarted = RelayAuthority::open_existing(&path).unwrap();
        let mut report = NativeTick::default();
        assert_eq!(
            reconcile_native_review_revision_routes(&mut restarted, "91", &agents, &mut report)
                .unwrap(),
            2
        );
        let job = restarted.read_job("91").unwrap().unwrap();
        assert_eq!(job["tasks"][0]["id"], "work-1");
        assert_eq!(job["tasks"][0]["routing"], routing);
        assert_eq!(job["tasks"][0]["workerSelection"], selection);
        assert_eq!(job["tasks"][1]["routing"], routing);
        assert_eq!(job["tasks"][1]["workerSelection"], selection);
        drop(restarted);
        let mut after_route_commit = RelayAuthority::open_existing(&path).unwrap();
        let mut retry_report = NativeTick::default();
        assert_eq!(
            reconcile_native_review_revision_routes(
                &mut after_route_commit,
                "91",
                &agents,
                &mut retry_report
            )
            .unwrap(),
            0
        );
        assert_eq!(
            after_route_commit.read_job("91").unwrap().unwrap()["tasks"][0]["routing"],
            routing
        );
        assert_eq!(
            after_route_commit.read_job("91").unwrap().unwrap()["tasks"][1]["routing"],
            routing
        );
        assert!(retry_report.blocked.is_empty());
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
    fn graph_selected_merge_request_records_approval_without_completing_pr_job() {
        let (_dir, mut authority) = authority("approved", HEAD, json!([]));
        authority
            .commit_job("91", "2026-11-15T11:00:00.001Z", |current| {
                let mut next = current.clone();
                next["autoMerge"] = json!(true);
                next["prNumber"] = json!(42);
                next["updatedAt"] = json!("2026-11-15T11:00:00.001Z");
                Ok((next, vec![]))
            })
            .unwrap();
        assert!(apply_native_reviewer_result(&mut authority, "91").unwrap());
        let approved = authority.read_job("91").unwrap().unwrap();
        assert_eq!(approved["review"]["outcome"], "approved");
        assert_eq!(approved["state"], "ACTIVE");
        assert!(!crate::native_job::complete_approved_local_job(&mut authority, "91").unwrap());
        assert_eq!(
            authority.read_job("91").unwrap().unwrap()["state"],
            "ACTIVE"
        );
    }

    #[test]
    fn disabled_review_gate_does_not_accept_a_reviewer_result() {
        let (_dir, mut authority) = authority("approved", HEAD, json!([]));
        authority
            .commit_job("91", "2026-11-15T11:00:00.001Z", |current| {
                let mut next = current.clone();
                next["reviewEnabled"] = json!(false);
                next["updatedAt"] = json!("2026-11-15T11:00:00.001Z");
                Ok((next, vec![]))
            })
            .unwrap();
        assert!(!apply_native_reviewer_result(&mut authority, "91").unwrap());
        assert_eq!(
            authority.read_job("91").unwrap().unwrap()["review"]["outcome"],
            "pending"
        );
    }

    #[test]
    fn verified_local_head_change_uses_review_and_task_graphs_and_fences_old_review() {
        let (dir, mut authority) = authority_with_bound_head("approved", HEAD, json!([]), HEAD);
        let at = after_time(AT).unwrap();
        authority
            .commit_job("91", &at, |current| {
                let mut next = current.clone();
                next["review"]["outcome"] = json!("approved");
                next["tasks"][0]["state"] = json!("QUEUED");
                next["tasks"][0]["executionId"] = Value::Null;
                next["tasks"][0]["leaseOwner"] = Value::Null;
                next["tasks"][0]["leaseExpiresAt"] = Value::Null;
                next["updatedAt"] = json!(at);
                Ok((next, vec![]))
            })
            .unwrap();
        let new_head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        assert!(apply_native_review_head_changed(&mut authority, "91", new_head).unwrap());
        let job = authority.read_job("91").unwrap().unwrap();
        assert_eq!(job["headSha"], new_head);
        assert_eq!(job["review"]["headSha"], HEAD);
        assert_eq!(job["review"]["outcome"], "stale");
        assert_eq!(job["tasks"][0]["state"], "CANCELLED");
        let second_head = "cccccccccccccccccccccccccccccccccccccccc";
        assert!(apply_native_review_head_changed(&mut authority, "91", second_head).unwrap());
        assert!(!apply_native_review_head_changed(&mut authority, "91", second_head).unwrap());
        drop(authority);
        let reopened = RelayAuthority::open_existing(&dir.path().join("relay.sqlite")).unwrap();
        let recovered = reopened.read_job("91").unwrap().unwrap();
        assert_eq!(recovered["headSha"], second_head);
        assert_eq!(recovered["review"]["outcome"], "stale");
    }

    #[test]
    fn verified_head_is_recorded_for_local_job_before_first_review_only() {
        let (dir, mut authority) = authority_with_bound_head("approved", HEAD, json!([]), HEAD);
        let at = after_time(AT).unwrap();
        authority
            .commit_job("91", &at, |current| {
                let mut next = current.clone();
                next["review"] = Value::Null;
                next["headSha"] = json!("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
                next["updatedAt"] = json!(at);
                Ok((next, vec![]))
            })
            .unwrap();
        let observed = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        assert!(record_native_local_head(&mut authority, "91", observed).unwrap());
        assert!(!record_native_local_head(&mut authority, "91", observed).unwrap());
        let job = authority.read_job("91").unwrap().unwrap();
        assert_eq!(job["headSha"], observed);
        assert!(job["review"].is_null());

        let pr_at = after_time(job["updatedAt"].as_str().unwrap()).unwrap();
        authority
            .commit_job("91", &pr_at, |current| {
                let mut next = current.clone();
                next["prNumber"] = json!(42);
                next["headSha"] = json!("cccccccccccccccccccccccccccccccccccccccc");
                next["updatedAt"] = json!(pr_at);
                Ok((next, vec![]))
            })
            .unwrap();
        assert!(!record_native_local_head(&mut authority, "91", observed).unwrap());
        drop(authority);
        let reopened = RelayAuthority::open_existing(&dir.path().join("relay.sqlite")).unwrap();
        let recovered = reopened.read_job("91").unwrap().unwrap();
        assert_eq!(
            recovered["headSha"],
            "cccccccccccccccccccccccccccccccccccccccc"
        );
    }

    #[test]
    fn running_old_head_reviewer_is_not_cancelled_but_cannot_authorize_new_head() {
        let (dir, mut authority) = authority_with_bound_head("approved", HEAD, json!([]), HEAD);
        let at = after_time(AT).unwrap();
        authority
            .commit_job("91", &at, |current| {
                let mut next = current.clone();
                next["review"]["outcome"] = json!("started");
                next["tasks"][0]["state"] = json!("RUNNING");
                next["tasks"][0]["executionId"] = json!("review-exec");
                next["tasks"][0]["leaseOwner"] = json!("reviewer-worker");
                next["tasks"][0]["leaseExpiresAt"] = json!("2026-11-15T13:00:00.000Z");
                next["updatedAt"] = json!(at);
                Ok((next, vec![]))
            })
            .unwrap();
        let new_head = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        assert!(apply_native_review_head_changed(&mut authority, "91", new_head).unwrap());
        let job = authority.read_job("91").unwrap().unwrap();
        assert_eq!(job["review"]["outcome"], "stale");
        assert_eq!(job["tasks"][0]["state"], "RUNNING");
        assert_eq!(job["tasks"][0]["reviewHeadSha"], HEAD);
        assert!(!apply_native_reviewer_result(&mut authority, "91").unwrap());
        drop(authority);
        let reopened = RelayAuthority::open_existing(&dir.path().join("relay.sqlite")).unwrap();
        let recovered = reopened.read_job("91").unwrap().unwrap();
        assert_eq!(recovered["headSha"], new_head);
        assert_eq!(recovered["review"]["outcome"], "stale");
    }

    #[test]
    fn graph_selected_final_review_creation_is_sha_bound_atomic_and_deduplicated() {
        let (_dir, mut authority) = review_ready_authority();
        let routing = json!({"provider":"fixture","model":"fixture-model",
            "decidedBy":"fixture-router","decidedAt":AT});
        let selection = json!({"workerId":"fixture-reviewer","adapter":"codex",
            "selectedBy":"fixture-router","selectedAt":AT,"capabilities":["model"]});
        assert!(schedule_native_final_review(
            &mut authority,
            "91",
            HEAD,
            "job-acceptance-reviewer",
            &routing,
            &selection,
        )
        .unwrap());
        let job = authority.read_job("91").unwrap().unwrap();
        let review_id = job["review"]["taskId"].as_str().unwrap();
        assert_eq!(job["review"]["outcome"], "pending");
        assert_eq!(job["review"]["headSha"], HEAD);
        let task = job["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|task| task["id"] == review_id)
            .unwrap();
        assert_eq!(task["state"], "QUEUED");
        assert_eq!(task["agentName"], "job-acceptance-reviewer");
        assert_eq!(task["reviewHeadSha"], HEAD);
        assert_eq!(task["routing"], routing);
        assert_eq!(task["workerSelection"], selection);
        assert!(!schedule_native_final_review(
            &mut authority,
            "91",
            HEAD,
            "job-acceptance-reviewer",
            &routing,
            &selection,
        )
        .unwrap());
        let claim_at = after_time(
            authority.read_job("91").unwrap().unwrap()["updatedAt"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        let claim = authority
            .claim_queued_codex(&crate::authority::ScriptClaimRequest {
                job_id: "91",
                task_id: review_id,
                execution_id: "review-execution-1",
                owner: "native-reviewer",
                at: &claim_at,
                lease_expires_at: "2099-11-15T11:30:00.000Z",
            })
            .unwrap();
        assert!(claim.is_some(), "exact SHA-bound Review Task is claimable");
    }

    #[test]
    fn daemon_final_review_reconcile_resolves_local_head_and_requires_trusted_prompt_route() {
        use super::super::adapter::{NativeScriptAdapter, ScriptManifest};
        use std::collections::BTreeMap;
        use std::fs;
        use std::path::PathBuf;

        let (dir, mut authority) = review_ready_authority();
        let git = dir.path().join(".git");
        fs::create_dir_all(&git).unwrap();
        fs::write(git.join("HEAD"), format!("{HEAD}\n")).unwrap();
        let changed_at = after_time(AT).unwrap();
        authority
            .commit_job("91", &changed_at, |current| {
                let mut next = current.clone();
                next["headSha"] = json!("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
                next["updatedAt"] = json!(changed_at);
                Ok((next, vec![]))
            })
            .unwrap();
        let cli = dir.path().join("relay-cli.js");
        fs::write(&cli, "").unwrap();
        fs::write(dir.path().join("model-routing.js"), "").unwrap();
        let routing = json!({"provider":"fixture","model":"fixture-model",
            "decidedBy":"fixture-router","decidedAt":AT});
        let selection = json!({"workerId":"fixture-reviewer","adapter":"codex",
            "selectedBy":"fixture-router","selectedAt":AT,"capabilities":["model"]});
        let manifest = ScriptManifest {
            agents: BTreeMap::from([(
                "job-acceptance-reviewer".into(),
                NativeScriptAdapter {
                    kind: NativeAdapterKind::Model,
                    executable: PathBuf::from("/bin/echo"),
                    args: vec![],
                    env: BTreeMap::new(),
                    routing: Some(routing),
                    worker_selection: Some(selection),
                    prompt_cli: Some(cli),
                    prompt_node: Some(PathBuf::from("/usr/bin/node")),
                },
            )]),
        };
        let mut report = NativeTick::default();
        let canonical_root = dir.path().canonicalize().unwrap();
        reconcile_native_final_review(
            &mut authority,
            "91",
            &canonical_root,
            &manifest,
            &mut report,
        )
        .unwrap();
        assert_eq!(
            report.reviews_queued, 0,
            "head observation precedes Graph scheduling"
        );
        assert_eq!(
            authority.read_job("91").unwrap().unwrap()["headSha"],
            HEAD,
            "verified local HEAD is persisted before the next reconciliation"
        );
        reconcile_native_final_review(
            &mut authority,
            "91",
            &canonical_root,
            &manifest,
            &mut report,
        )
        .unwrap();
        assert_eq!(report.reviews_queued, 1, "blocked={:?}", report.blocked);
        let job = authority.read_job("91").unwrap().unwrap();
        assert_eq!(job["review"]["headSha"], HEAD);
        assert_eq!(job["review"]["outcome"], "pending");
        assert_eq!(job["tasks"].as_array().unwrap().len(), 2);
        reconcile_native_final_review(
            &mut authority,
            "91",
            &canonical_root,
            &manifest,
            &mut report,
        )
        .unwrap();
        assert_eq!(
            report.reviews_queued, 1,
            "active Reviewer is not duplicated"
        );
        assert_eq!(
            authority.read_job("91").unwrap().unwrap()["tasks"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }
}
