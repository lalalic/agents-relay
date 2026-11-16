//! Real Git local merge: the Job Lifecycle Graph selects the merge effect;
//! native Rust owns delivery. No Node reconciler and no fabricated merge state.
//! Side effects are limited to a bound Git repository and refs/heads/main.
use super::{authorized_project, NativeTick};
use crate::authority::{RelayAuthority, WorkflowEvent};
use crate::graph::{Decision, Graph, GraphInput};
use crate::supervised_script::after_time;
use chrono::{Duration, SecondsFormat, Utc};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::os::fd::AsRawFd;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

const JOB_GRAPH: &str = include_str!("../../../workflow/job-lifecycle.mmd");
fn valid_sha(s: &str) -> bool {
    matches!(s.len(), 40 | 64)
        && s.bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
fn branch(s: &str) -> bool {
    s.starts_with("refs/heads/")
        && s.len() <= 255
        && !s.contains("..")
        && !s.contains("//")
        && !s.ends_with(".lock")
        && !s.ends_with('/')
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'/' | b'.'))
        && s.split('/')
            .all(|part| !part.is_empty() && !part.starts_with('.') && !part.ends_with('.'))
}
fn git(repo: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("/usr/bin/git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("local Git invocation: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "local Git {} rejected: {}",
            args.join(" "),
            stderr.chars().take(600).collect::<String>()
        ));
    }
    if output.stdout.len() > 1_048_576 {
        return Err("Git response oversized".into());
    }
    let output = String::from_utf8(output.stdout).map_err(|_| "non-UTF8 Git output")?;
    Ok(output.trim().to_owned())
}
fn source_and_target(repo: &Path, job: &Value) -> Result<(String, String, String), String> {
    let request = &job["localMerge"];
    let source = request["sourceRef"]
        .as_str()
        .ok_or("local merge sourceRef missing")?;
    let target = request["targetRef"]
        .as_str()
        .ok_or("local merge targetRef missing")?;
    if !branch(source) || target != "refs/heads/main" || source == target {
        return Err(
            "local merge requires distinct, safe refs/heads branches and target main".into(),
        );
    }
    let source_sha = git(repo, &["rev-parse", "--verify", source])?;
    let target_sha = git(repo, &["rev-parse", "--verify", target])?;
    if !valid_sha(&source_sha) || !valid_sha(&target_sha) {
        return Err("Git branch identity is not an exact commit SHA".into());
    }
    if source_sha != job["headSha"]
        || source_sha != job["review"]["headSha"]
        || job["review"]["outcome"] != "approved"
        || job["review"]["evidence"]["data"]["head_sha"] != source_sha
    {
        return Err("merge source must match verified current-head Review approval".into());
    }
    if let Some(bound) = request["sourceSha"].as_str() {
        if bound != source_sha {
            return Err("merge source ref moved after Review".into());
        }
    }
    Ok((source_sha, target_sha, source.to_owned()))
}
fn target_worktree(repo: &Path, target: &str) -> Result<Option<PathBuf>, String> {
    let output = git(repo, &["worktree", "list", "--porcelain"])?;
    let mut selected = None;
    for block in output.split("\n\n") {
        if block.lines().any(|line| line == format!("branch {target}")) {
            let path = block
                .lines()
                .find_map(|line| line.strip_prefix("worktree "))
                .ok_or("local target worktree path missing")?;
            if selected.is_some() {
                return Err("multiple checked-out main worktrees".into());
            }
            selected = Some(
                PathBuf::from(path)
                    .canonicalize()
                    .map_err(|e| e.to_string())?,
            );
        }
    }
    Ok(selected)
}
fn message(job_id: &str, source: &str) -> String {
    format!(
        "Agents Relay local merge\n\nAgents-Relay-Source-SHA: {source}\nAgents-Relay-Job: {job_id}"
    )
}
fn validate_existing_merge(
    repo: &Path,
    target_sha: &str,
    source_sha: &str,
    job_id: &str,
) -> Result<bool, String> {
    if git(
        repo,
        &["merge-base", "--is-ancestor", source_sha, target_sha],
    )
    .is_err()
    {
        return Ok(false);
    }
    let commit_message = git(repo, &["show", "-s", "--format=%B", target_sha])?;
    let marker = format!("Agents-Relay-Job: {job_id}");
    if commit_message.starts_with("Agents Relay local merge")
        && commit_message.contains(&format!("Agents-Relay-Source-SHA: {source_sha}"))
        && commit_message.contains(&marker)
    {
        return Ok(true);
    }
    Err("target already contains source without this Job's verifiable merge receipt".into())
}
fn deliver(
    repo: &Path,
    job_id: &str,
    source_sha: &str,
    target_sha: &str,
) -> Result<String, String> {
    if validate_existing_merge(repo, target_sha, source_sha, job_id)? {
        return Ok(target_sha.to_owned());
    }
    let common = git(
        repo,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )?;
    let common = PathBuf::from(common)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !common.is_dir() {
        return Err("shared Git metadata directory missing".into());
    }
    let digest = format!("{:x}", Sha256::digest(b"refs/heads/main"));
    // OS-released advisory lock: unlike an orphaned mkdir lockdir this is
    // released on SIGKILL/process crash without deleting any live owner's
    // lock. Git's own update-ref CAS remains the final ref-write fence.
    let lock = common.join(format!("agents-relay-merge-{}.flock", &digest[..24]));
    let guard = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .mode(0o600)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
        .open(&lock)
        .map_err(|e| format!("cannot open trusted Git merge lock: {e}"))?;
    if unsafe { nix::libc::flock(guard.as_raw_fd(), nix::libc::LOCK_EX | nix::libc::LOCK_NB) } != 0
    {
        return Err(format!(
            "local merge busy: {}",
            std::io::Error::last_os_error()
        ));
    }
    // Keep `guard` alive until the commit and parentage check completes.
    let _guard = guard;
    // Re-verify refs under the merge lock, with compare-and-swap target.
    if git(repo, &["rev-parse", "--verify", "refs/heads/main"])? != target_sha {
        return Err("main moved before local merge; no ref updated".into());
    }
    let who = git(repo, &["rev-parse", "--verify", source_sha])?;
    if who != source_sha {
        return Err("source SHA unavailable".into());
    }
    let msg = message(job_id, source_sha);
    let merged = if let Some(worktree) = target_worktree(repo, "refs/heads/main")? {
        if git(&worktree, &["symbolic-ref", "HEAD"])? != "refs/heads/main"
            || git(&worktree, &["rev-parse", "HEAD"])? != target_sha
        {
            return Err("checked-out main worktree changed before merge".into());
        }
        if !git(
            &worktree,
            &["status", "--porcelain", "--untracked-files=no"],
        )?
        .is_empty()
        {
            return Err("tracked or index changes in main worktree; refusing merge".into());
        }
        // Do not mutate a pre-existing MERGE_HEAD. Explicitly reject conflict
        // instead of guessing whether a pending merge belongs to Relay.
        if git(&worktree, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]).is_ok() {
            return Err("pre-existing Git merge requires manual resolution".into());
        }
        if let Err(merge_error) = git(
            &worktree,
            &["merge", "--no-ff", "--no-edit", "-m", &msg, source_sha],
        ) {
            // A conflict can leave MERGE_HEAD and the checked-out main index
            // dirty. Abort *only* the exact merge created by this Job and
            // source generation; never abort a pre-existing/user-owned merge.
            if git(&worktree, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]).as_deref()
                == Ok(source_sha)
                && git(&worktree, &["rev-parse", "HEAD"]).as_deref() == Ok(target_sha)
            {
                if let Ok(path) = git(&worktree, &["rev-parse", "--git-path", "MERGE_MSG"]) {
                    let path = PathBuf::from(path);
                    let path = if path.is_absolute() {
                        path
                    } else {
                        worktree.join(path)
                    };
                    if fs::symlink_metadata(&path).is_ok_and(|m| {
                        m.is_file() && !m.file_type().is_symlink() && m.len() <= 1_048_576
                    }) && fs::read_to_string(path).is_ok_and(|content| {
                        content.starts_with("Agents Relay local merge")
                            && content.contains(&format!("Agents-Relay-Source-SHA: {source_sha}"))
                            && content.contains(&format!("Agents-Relay-Job: {job_id}"))
                    }) {
                        git(&worktree, &["merge", "--abort"])?;
                    }
                }
            }
            return Err(merge_error);
        }
        git(&worktree, &["rev-parse", "HEAD"])?
    } else {
        let tree = git(
            repo,
            &["merge-tree", "--write-tree", target_sha, source_sha],
        )?;
        let tree = tree
            .lines()
            .next()
            .ok_or("Git merge-tree did not return a tree")?;
        if !valid_sha(tree) {
            return Err("Git merge-tree returned invalid object".into());
        }
        let merge = git(
            repo,
            &[
                "commit-tree",
                tree,
                "-p",
                target_sha,
                "-p",
                source_sha,
                "-m",
                &msg,
            ],
        )?;
        git(repo, &["update-ref", "refs/heads/main", &merge, target_sha])?;
        merge
    };
    if !valid_sha(&merged) || git(repo, &["rev-parse", "--verify", "refs/heads/main"])? != merged {
        return Err("local merge ref update could not be verified".into());
    }
    let parents = git(repo, &["rev-list", "--parents", "-n", "1", &merged])?;
    let mut tokens = parents.split_whitespace();
    if tokens.next() != Some(merged.as_str())
        || tokens.next() != Some(target_sha)
        || tokens.next() != Some(source_sha)
        || tokens.next().is_some()
    {
        return Err("unexpected local merge parentage; manual verification required".into());
    }
    Ok(merged)
}
fn review_and_work_ready(job: &Value) -> bool {
    if job["state"] != "ACTIVE"
        || job["autoMerge"] == false
        || job["reviewEnabled"] == false
        || job.get("pause").is_some_and(|v| !v.is_null())
        || job.get("publication").is_some_and(|v| !v.is_null())
        || job.get("prNumber").and_then(Value::as_i64).unwrap_or(0) != 0
        || job["review"]["outcome"] != "approved"
        || !job["headSha"].is_string()
    {
        return false;
    }
    if job["plans"]
        .as_array()
        .is_some_and(|plans| plans.iter().any(|p| p["status"] != "SUCCEEDED"))
    {
        return false;
    }
    let Some(tasks) = job["tasks"].as_array() else {
        return false;
    };
    tasks.iter().any(|t| {
        t["kind"] != "planner"
            && !matches!(
                t["agentName"].as_str(),
                Some("reviewer" | "job-acceptance-reviewer" | "troubleshooter")
            )
    }) && tasks.iter().all(|t| {
        t["state"] == "SUCCEEDED"
            && t.get("interactiveInvocation")
                .is_none_or(|v| v.is_null() || v["status"] == "approved")
            && t.get("resolution")
                .is_none_or(|v| v.is_null() || v["state"] == "resolved")
    })
}
pub(super) fn reconcile_local_merge(
    authority: &mut RelayAuthority,
    job_id: &str,
    root: &Path,
    report: &mut NativeTick,
) -> Result<(), String> {
    let snapshot = authority
        .read_job(job_id)?
        .ok_or("local merge Job missing")?;
    let request = &snapshot["localMerge"];
    if !request.is_object()
        || !review_and_work_ready(&snapshot)
        || !crate::native_job::reviewed_local_premerge_ready(&snapshot)
        || !authority.host_approvals_durable(job_id, &snapshot)?
        || request["status"] == "succeeded"
    {
        return Ok(());
    }
    if let Some(next) = request["nextAttemptAt"].as_str() {
        if chrono::DateTime::parse_from_rfc3339(next)
            .map_err(|_| "invalid local merge retry timestamp")?
            > chrono::DateTime::<Utc>::from(std::time::SystemTime::now()).fixed_offset()
        {
            return Ok(());
        }
    }
    let project = snapshot["projectRoot"]
        .as_str()
        .ok_or("local merge projectRoot missing")?;
    let project = authorized_project(root, Path::new(project))?;
    // Job Lifecycle Graph alone can authorize a delivery effect.
    let graph = Graph::parse(JOB_GRAPH)?;
    let decision = graph.decide(
        "ACTIVE",
        GraphInput {
            transport: "event".into(),
            id: "local.merge.requested".into(),
            payload: json!({}),
        },
        &HashMap::from([("localMergeReady".into(), true)]),
    )?;
    if !matches!(decision,Decision::Accepted{ref target,ref actions,..} if target=="ACTIVE" && actions.len()==1 && actions[0].id=="effect.deliverLocalMerge")
    {
        return Err("canonical Job Graph denied local merge delivery".into());
    }
    let merge = source_and_target(&project, &snapshot).and_then(|(source, target, _)| {
        deliver(&project, job_id, &source, &target).map(|merged| (source, target, merged))
    });
    let at = after_time(
        snapshot["updatedAt"]
            .as_str()
            .ok_or("Job timestamp missing")?,
    )?;
    let mut committed_outcome = None;
    authority.commit_job(job_id, &at, |current| {
        if current["state"] != "ACTIVE"
            || current["review"] != snapshot["review"]
            || current["headSha"] != snapshot["headSha"]
            || current["localMerge"] != snapshot["localMerge"]
            || !review_and_work_ready(current)
            || !crate::native_job::reviewed_local_premerge_ready(current)
        {
            return Err(
                "stale local merge evidence; ref may have changed, manual verification required"
                    .into(),
            );
        }
        let mut next = current.clone();
        match &merge {
            Ok((source, previous, merged)) => {
                next["localMerge"]["status"] = json!("succeeded");
                next["localMerge"]["sourceSha"] = json!(source);
                next["localMerge"]["previousTargetSha"] = json!(previous);
                next["localMerge"]["mergedCommitSha"] = json!(merged);
                next["localMerge"]["projectionStrategy"] = json!("target_ref_push");
                next["localMerge"]["error"] = Value::Null;
                next["localMerge"]["nextAttemptAt"] = Value::Null;
                committed_outcome = Some(true);
            }
            Err(error) => {
                let attempts = current["localMerge"]["attempts"].as_i64().unwrap_or(0) + 1;
                let delay = (1000_i64 * 2_i64.pow(attempts.min(8) as u32)).min(300_000);
                next["localMerge"]["status"] = json!("failed");
                next["localMerge"]["attempts"] = json!(attempts);
                next["localMerge"]["error"] = json!(error.chars().take(2000).collect::<String>());
                next["localMerge"]["nextAttemptAt"] =
                    json!((chrono::DateTime::<Utc>::from(std::time::SystemTime::now())
                        + Duration::milliseconds(delay))
                    .to_rfc3339_opts(SecondsFormat::Millis, true));
                committed_outcome = Some(false);
            }
        }
        next["localMerge"]["updatedAt"] = json!(at);
        next["updatedAt"] = json!(at);
        let outcome=if merge.is_ok(){"job.merge.succeeded"}else{"job.merge.failed"};
        let attempts=next["localMerge"]["attempts"].as_i64().unwrap_or(0);
        let basis=format!("{job_id}:{}:{attempts}:{outcome}:{}",next["localMerge"]["sourceSha"],next["localMerge"]["mergedCommitSha"]);
        let key=format!("workflow-local-merge-{:x}",Sha256::digest(basis.as_bytes()));
        let event=WorkflowEvent{
            key:key.clone(),event_id:key.clone(),
            payload:json!({"event_id":key,"type":outcome,"job_id":job_id,
                "status":if merge.is_ok(){"succeeded"}else{"failed"},
                "timestamp":at,"visibility":"user",
                "message":if merge.is_ok(){"Verified local Git merge succeeded"}else{"Local Git merge failed; retry is scheduled"},
                "data":{"sourceSha":next["localMerge"]["sourceSha"],
                    "mergedCommitSha":next["localMerge"]["mergedCommitSha"],
                    "error":next["localMerge"]["error"],"attempts":attempts,
                    "nextAttemptAt":next["localMerge"]["nextAttemptAt"]}}),
        };
        Ok((next, vec![event]))
    })?;
    if committed_outcome == Some(true) {
        report.local_merges_succeeded += 1
    } else if let Err(error) = merge {
        report
            .blocked
            .push(format!("{job_id}: local merge retry needed: {error}"));
        report.local_merges_failed += 1
    }
    Ok(())
}
