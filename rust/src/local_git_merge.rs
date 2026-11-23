// Direct port of src/local-git-merge.ts. Git porcelain is the authority for checked-out
// targets; no force ref updates, no PR lifecycle, and no external delivery.
use crate::local_merge_lock::with_local_merge_lock;
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalMergeResult {
    pub source_sha: String,
    pub merged_commit_sha: String,
}

pub(crate) fn git(repo: &Path, args: &[&str]) -> Result<String, String> {
    // Node execFileSync uses a 30-second deadline, a 1-MiB output limit and
    // GIT_TERMINAL_PROMPT=0. Git is an actual Relay-owned child group, never a
    // free-running Command.output() that could strand an entire reconciler.
    let mut manager = crate::owned_process::OwnedProcessManager::default();
    let mut argv = vec!["-C".to_string(), repo.to_string_lossy().into_owned()];
    argv.extend(args.iter().map(|arg| (*arg).to_string()));
    let refs: Vec<&str> = argv.iter().map(String::as_str).collect();
    let mut environment: std::collections::HashMap<_, _> = std::env::vars().collect();
    environment.insert("GIT_TERMINAL_PROMPT".into(), "0".into());
    let response = crate::continuation::run_delivery_owned_process(
        &mut manager,
        "git",
        &refs,
        None,
        "local-git-merge.git",
        crate::continuation::DeliveryProcessOptions {
            timeout: Some(Duration::from_secs(30)),
            cancelled: None,
            supervisor_path: None,
            environment: Some(&environment),
        },
    )?;
    if response.stdout.len() > 1024 * 1024 || response.stderr.len() > 1024 * 1024 {
        return Err("git maxBuffer length exceeded (1048576 bytes)".into());
    }
    if response.code != 0 {
        return Err(format!(
            "git {} exited {:?}: {}",
            args.join(" "),
            Some(response.code),
            response.stderr.trim()
        ));
    }
    Ok(response.stdout.trim().to_owned())
}
fn checked_ref(name: &str) -> Result<&str, String> {
    let valid = name.strip_prefix("refs/heads/").is_some_and(|s| {
        !s.is_empty()
            && s.as_bytes()[0].is_ascii_alphanumeric()
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._/-".contains(&b))
    });
    if !valid || name.contains("..") || name.ends_with(".lock") {
        Err("Local merge requires explicit refs/heads/ branch references".into())
    } else {
        Ok(name)
    }
}
pub fn local_working_head(repo: &Path) -> Result<String, String> {
    git(repo, &["rev-parse", "--verify", "HEAD"])
}
pub fn local_source_head(repo: &Path, source_ref: &str) -> Result<String, String> {
    git(repo, &["rev-parse", "--verify", checked_ref(source_ref)?])
}
pub fn requires_local_git_merge(job: &Value) -> bool {
    let local = job
        .get("localMerge")
        .is_some_and(|v| !v.is_null() && v != &Value::Bool(false));
    local
        || crate::runtime_status::implementation_tasks(job)
            .iter()
            .any(|task| task["output"]["kind"] == "task_pr")
}
pub fn local_merge_facts(
    job: &Value,
    head_sha: Option<&str>,
    now_ms: i64,
    implementation_complete: bool,
    completion_gate_satisfied: bool,
) -> Value {
    let local = &job["localMerge"];
    let present = !local.is_null();
    let ready = present
        && local["status"] != "succeeded"
        && (local["nextAttemptAt"].as_str().is_none_or(|s| {
            chrono::DateTime::parse_from_rfc3339(s)
                .map(|date| date.timestamp_millis() <= now_ms)
                .unwrap_or(false)
        }));
    json!({
        "jobActive":job["state"]=="ACTIVE",
        "autoMergeEnabled":job["autoMerge"]!=false,
        "implementationComplete":implementation_complete,
        "completionGateSatisfied":completion_gate_satisfied,
        "reviewSatisfied":job["reviewEnabled"]==false || job["review"]["outcome"]=="approved",
        "localMergeRequired":requires_local_git_merge(job),
        "localMergeSucceeded":local["status"]=="succeeded",
        "localMergePresent":present,
        "reviewHeadCurrent":job["reviewEnabled"]==false || job["review"]["headSha"]==head_sha.map(Value::from).unwrap_or(Value::Null),
        "mergeAttemptReady":ready
    })
}
/// For older Jobs created without --local-merge-source, derive a merge
/// request ONLY from a physically checked-out Git branch whose tip is the
/// exact independently approved immutable head. Never infer a ref from a
/// title, branch guess, or stale SQLite status. A detached checkout or
/// source already moved after review fails closed.
pub fn reviewed_checkout_merge_request(repo:&Path,job:&Value)
    ->Result<Option<Value>,String>{
    if job["state"]!="ACTIVE"||job["autoMerge"]==false
        ||job.get("localMerge").is_some_and(|v|!v.is_null())
        ||!crate::task_transitions::latest_head_approved_by_final_review(job)
        ||!crate::runtime_status::implementation_complete(job){return Ok(None);}
    // Validate that main actually exists: a Job with an unavailable target
    // must not be considered locally COMPLETED.
    let main=git(repo,&["rev-parse","--verify","refs/heads/main"])?;
    let reviewed=job["review"]["headSha"].as_str().unwrap_or("");
    let current=git(repo,&["symbolic-ref","--quiet","HEAD"])
        .map_err(|_|"Approved Job has no checked-out source branch; explicit reviewed source required")?;
    let source=checked_ref(&current)?;
    let head=git(repo,&["rev-parse","--verify",source])?;
    if head!=reviewed{
        return Err("Reviewed source branch HEAD changed after Final Review; refusing merge".into());
    }
    if source=="refs/heads/main"{
        if head!=main{
            return Err("Reviewed HEAD on main does not equal main ref".into());
        }
        return Ok(None); // Already delivered and physically checked out.
    }
    Ok(Some(json!({
        "sourceRef":source,"targetRef":"refs/heads/main",
        "sourceSha":reviewed,"status":"pending","attempts":0,
        "reviewTaskId":job["review"]["taskId"],
        "provenance":"reviewed_checked_out_git_head",
        "createdAt":crate::local_merge_lock::iso8601_now()
    })))
}

pub fn local_merge_commit_message(
    job_id: Option<&str>,
    display_pr: Option<i64>,
    source_sha: &str,
) -> String {
    let mut lines = vec![
        "Agents Relay local merge".to_owned(),
        String::new(),
        format!("Agents-Relay-Source-SHA: {source_sha}"),
    ];
    if let Some(id) = job_id.filter(|s| !s.is_empty()) {
        lines.push(format!("Agents-Relay-Job: {id}"));
    }
    if let Some(num) = display_pr.filter(|i| *i > 0) {
        lines.push(format!("Agents-Relay-Display-PR: {num}"));
    }
    lines.join("\n")
}
fn checked_out_target(repo: &Path, target_ref: &str) -> Result<Option<PathBuf>, String> {
    let text = git(repo, &["worktree", "list", "--porcelain"])?;
    let paths: Vec<_> = text
        .split("\n\n")
        .filter(|record| {
            record
                .lines()
                .any(|line| line == format!("branch {target_ref}"))
        })
        .filter_map(|record| {
            record
                .lines()
                .find_map(|line| line.strip_prefix("worktree "))
        })
        .map(PathBuf::from)
        .collect();
    if paths.len() > 1 {
        return Err("Local merge target has multiple checked-out worktrees".into());
    }
    Ok(paths.into_iter().next())
}
fn merge_checked_out_target(
    repo: &Path,
    target_ref: &str,
    source_sha: &str,
    target_sha: &str,
    message: &str,
) -> Result<String, String> {
    let wt = checked_out_target(repo, target_ref)?
        .ok_or("Target worktree disappeared before local merge")?;
    if git(&wt, &["symbolic-ref", "HEAD"])? != target_ref
        || git(&wt, &["rev-parse", "HEAD"])? != target_sha
    {
        return Err("Local merge target moved before delivery".into());
    }
    if !git(&wt, &["status", "--porcelain", "--untracked-files=no"])?.is_empty() {
        return Err("Local merge target worktree has tracked or index changes".into());
    }
    let merge_head = git(&wt, &["rev-parse", "--git-path", "MERGE_HEAD"])?;
    let merge_head = if Path::new(&merge_head).is_absolute() {
        PathBuf::from(merge_head)
    } else {
        wt.join(merge_head)
    };
    if merge_head.exists() {
        return Err("Existing MERGE_HEAD is not owned by Relay; manual resolution required".into());
    }
    let attempt = git(
        &wt,
        &["merge", "--no-ff", "--no-edit", "-m", message, source_sha],
    );
    if attempt.is_err() && merge_head.exists() {
        let msg = git(&wt, &["rev-parse", "--git-path", "MERGE_MSG"]).ok();
        let msg_path = msg.map(|s| {
            if Path::new(&s).is_absolute() {
                PathBuf::from(s)
            } else {
                wt.join(s)
            }
        });
        if fs::read_to_string(&merge_head).is_ok_and(|s| s.trim() == source_sha)
            && msg_path
                .as_ref()
                .and_then(|p| fs::read_to_string(p).ok())
                .is_some_and(|s| s.starts_with("Agents Relay local merge"))
            && git(&wt, &["rev-parse", "HEAD"]).is_ok_and(|s| s == target_sha)
        {
            let _ = git(&wt, &["merge", "--abort"]);
        }
    }
    attempt?;
    let result = git(&wt, &["rev-parse", "HEAD"])?;
    let parents = git(&wt, &["rev-list", "--parents", "-n", "1", &result])?;
    let ids: Vec<_> = parents.split(' ').collect();
    if ids.get(1) != Some(&target_sha) || ids.get(2) != Some(&source_sha) {
        return Err("Unexpected local merge commit parentage; manual verification required".into());
    }
    let _ = repo;
    Ok(result)
}
pub fn deliver_local_merge(repo: &Path, request: &Value) -> Result<LocalMergeResult, String> {
    let source_ref = checked_ref(request["sourceRef"].as_str().ok_or("sourceRef missing")?)?;
    let target_ref = checked_ref(request["targetRef"].as_str().ok_or("targetRef missing")?)?;
    if target_ref != "refs/heads/main" {
        return Err("Local Git merge target must always be refs/heads/main".into());
    }
    if source_ref == target_ref {
        return Err("Local merge source and target must differ".into());
    }
    let common = git(repo, &["rev-parse", "--git-common-dir"])?;
    let common = if Path::new(&common).is_absolute() {
        PathBuf::from(common)
    } else {
        repo.join(common)
    };
    let common = common.canonicalize().map_err(|e| e.to_string())?;
    with_local_merge_lock(
        &common,
        target_ref,
        || {
            let source_sha = local_source_head(repo, source_ref)?;
            if request["sourceSha"]
                .as_str()
                .is_some_and(|sha| sha != source_sha)
            {
                return Err("Local merge source SHA changed after review".into());
            }
            let target_sha = git(repo, &["rev-parse", "--verify", target_ref])?;
            if git(
                repo,
                &["merge-base", "--is-ancestor", &source_sha, &target_sha],
            )
            .is_ok()
            {
                return Ok(LocalMergeResult {
                    source_sha,
                    merged_commit_sha: target_sha,
                });
            }
            let message = local_merge_commit_message(
                request["correlationJobId"].as_str(),
                request["displayPrNumber"].as_i64(),
                &source_sha,
            );
            let merged_commit_sha = if checked_out_target(repo, target_ref)?.is_some() {
                merge_checked_out_target(repo, target_ref, &source_sha, &target_sha, &message)?
            } else {
                let tree = git(
                    repo,
                    &["merge-tree", "--write-tree", &target_sha, &source_sha],
                )?;
                let tree = tree.lines().next().unwrap_or("");
                if !(tree.len() == 40 || tree.len() == 64)
                    || !tree.bytes().all(|b| b.is_ascii_hexdigit())
                {
                    return Err("Local merge-tree returned no valid tree".into());
                }
                let merged = git(
                    repo,
                    &[
                        "commit-tree",
                        tree,
                        "-p",
                        &target_sha,
                        "-p",
                        &source_sha,
                        "-m",
                        &message,
                    ],
                )?;
                git(repo, &["update-ref", target_ref, &merged, &target_sha])?;
                merged
            };
            Ok(LocalMergeResult {
                source_sha,
                merged_commit_sha,
            })
        },
        Duration::from_secs(30),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    fn test_git(dir: &Path, args: &[&str]) -> String {
        git(dir, args).unwrap()
    }
    #[test]
    fn checked_out_merge_is_idempotent_and_ref_validated() {
        let tmp = std::env::temp_dir().join(format!(
            "rust2-local-git-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&tmp).unwrap();
        test_git(&tmp, &["init", "-q", "-b", "main"]);
        test_git(&tmp, &["config", "user.name", "Fixture"]);
        test_git(&tmp, &["config", "user.email", "fixture@example.test"]);
        fs::write(tmp.join("base.txt"), "base").unwrap();
        test_git(&tmp, &["add", "base.txt"]);
        test_git(&tmp, &["commit", "-qm", "base"]);
        test_git(&tmp, &["checkout", "-qb", "feature"]);
        fs::write(tmp.join("feature.txt"), "feature").unwrap();
        test_git(&tmp, &["add", "feature.txt"]);
        test_git(&tmp, &["commit", "-qm", "feature"]);
        let source = local_source_head(&tmp, "refs/heads/feature").unwrap();
        test_git(&tmp, &["checkout", "-q", "main"]);
        let before = local_working_head(&tmp).unwrap();
        let request = json!({"sourceRef":"refs/heads/feature","targetRef":"refs/heads/main","sourceSha":source,"correlationJobId":"42"});
        let result = deliver_local_merge(&tmp, &request).unwrap();
        assert_eq!(result.source_sha, source);
        assert_ne!(result.merged_commit_sha, before);
        assert!(tmp.join("feature.txt").exists());
        assert_eq!(
            deliver_local_merge(&tmp, &request).unwrap(),
            LocalMergeResult {
                source_sha: source,
                merged_commit_sha: result.merged_commit_sha
            }
        );
        fs::write(tmp.join("base.txt"), "dirty").unwrap();
        assert!(deliver_local_merge(
            &tmp,
            &json!({"sourceRef":"refs/heads/missing","targetRef":"refs/heads/main"})
        )
        .is_err());
        assert!(deliver_local_merge(
            &tmp,
            &json!({"sourceRef":"refs/heads/feature","targetRef":"refs/heads/dev"})
        )
        .is_err());
        let _ = fs::remove_dir_all(tmp);
    }
}

/// Exact public localMergeFacts facade. Reuse the separately verified
/// runtime-status and Task transition facts rather than requiring every CLI,
/// worker and reconciler caller to supply manually duplicated gate booleans.
pub fn local_merge_facts_bound(job: &Value, head_sha: Option<&str>, now_ms: i64) -> Value {
    local_merge_facts(
        job,
        head_sha,
        now_ms,
        crate::runtime_status::implementation_complete(job),
        crate::task_transitions::completion_gate_satisfied(job),
    )
}

#[cfg(test)]
mod native_bound_facts_tests {
    use super::*;
    #[test]
    fn binds_completion_facts_from_shared_modules() {
        let job = json!({"id":"9","state":"ACTIVE","reviewEnabled":false,
            "autoMerge":true,"plans":[{"round":1,"status":"SUCCEEDED","objectiveStatus":"satisfied"}],
            "tasks":[{"id":"12","kind":"work","state":"SUCCEEDED","adapter":"chatgpt","output":{"kind":"task_pr"}}],
            "localMerge":{"status":"pending","nextAttemptAt":"2026-11-16T00:00:00.000Z"}});
        let facts = local_merge_facts_bound(&job, None, 1_795_000_000_000);
        assert_eq!(facts["implementationComplete"], true);
        assert_eq!(facts["completionGateSatisfied"], true);
        assert_eq!(facts["mergeAttemptReady"], true);
    }
}
