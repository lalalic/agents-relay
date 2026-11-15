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
    // A head change must first travel through the canonical Review Graph. This
    // staged daemon deliberately refuses to overwrite Job head evidence.
    if snapshot["headSha"].as_str() != Some(&head) {
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
