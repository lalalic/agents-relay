// Direct port of src/job-worktree-cleanup.ts: Graph-selected effect, never
// an independent completion decision. Canonical path resolution and cleanup
// are host-owned adapters; blocked statuses are recoverable failures.
use serde_json::Value;
pub fn cleanup_merged_job_worktree<R, C>(
    job: &Value,
    mut cwd_for_job: Option<R>,
    mut cleanup_completed_worktree: C,
) -> Result<(), String>
where
    R: FnMut(&Value) -> Result<String, String>,
    C: FnMut(&str, &Value) -> Result<Value, String>,
{
    let resolver = cwd_for_job
        .as_mut()
        .ok_or("No canonical project resolver for Worktree cleanup")?;
    let cwd = resolver(job)?;
    let result = cleanup_completed_worktree(&cwd, job)?;
    if result["status"] == "blocked" {
        let reason = result["reason"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or("Unsafe Worktree cleanup");
        return Err(reason.into());
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn canonical_resolver_required_and_blocked_propagated() {
        let job = json!({"id":"42","projectRoot":"/tmp/fake-root"});
        assert_eq!(
            cleanup_merged_job_worktree(
                &job,
                None::<fn(&Value) -> Result<String, String>>,
                |_, _| panic!("should not be called")
            )
            .unwrap_err(),
            "No canonical project resolver for Worktree cleanup"
        );
        assert_eq!(
            cleanup_merged_job_worktree(&job, Some(|_: &Value| Ok("/safe".into())), |path, _| {
                assert_eq!(path, "/safe");
                Ok(json!({"status":"blocked","reason":"dirty"}))
            })
            .unwrap_err(),
            "dirty"
        );
        assert!(cleanup_merged_job_worktree(
            &job,
            Some(|_: &Value| Ok("/safe".into())),
            |_, _| Ok(json!({"status":"completed"}))
        )
        .is_ok());
    }
}

// Graph-selected native effect: all paths are derived from the canonical Job
// identity and the caller's explicit workspace root. No arbitrary path deletion.
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
};

fn cleanup_git(repo: &Path, args: &[&str]) -> Result<String, String> {
    // src/workspace.ts uses an owned process for every Git effect. Share the
    // 30-second owned subprocess transport with local merge, rather than the
    // previous unbounded Command.output() implementation.
    crate::local_git_merge::git(repo, args)
}

pub fn managed_local_job_worktree_path(
    workspace_root: &Path,
    repository: &str,
    job_id: &str,
) -> Result<PathBuf, String> {
    if repository.is_empty()
        || !repository
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
        || job_id.trim().is_empty()
    {
        return Err("Invalid local Job checkout identity".into());
    }
    let mut safe_job = String::new();
    let mut was_invalid = false;
    for c in job_id.chars() {
        let valid = c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-');
        if valid {
            safe_job.push(c);
        } else if !was_invalid {
            safe_job.push('-');
        }
        was_invalid = !valid;
    }
    safe_job.truncate(safe_job.len().min(72));
    let digest = Sha256::digest(job_id.as_bytes());
    let short_hash = digest
        .iter()
        .take(6)
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let name = format!(
        "{repository}-job-{}-{short_hash}",
        if safe_job.is_empty() {
            "job"
        } else {
            &safe_job
        }
    );
    Ok(workspace_root
        .join(".worktrees")
        .join("agents-relay")
        .join(name)
        .join("job"))
}

/// Exact conservative cleanup of a local-merge Job. An outcome is either
/// absent, removed, or blocked with an explanatory reason; never force-remove.
pub fn cleanup_completed_job_worktree(
    project_path: &Path,
    job: &Value,
    workspace_root: &Path,
) -> Result<Value, String> {
    let blocked = |reason: &str| serde_json::json!({"status":"blocked","reason":reason});
    if job["state"] != "COMPLETED" {
        return Ok(blocked("Job is not completed"));
    }
    let local = job
        .pointer("/localMerge/sourceRef")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.is_empty());
    let expected = if local {
        job.pointer("/localMerge/sourceSha")
            .and_then(Value::as_str)
            .or_else(|| job.pointer("/review/headSha").and_then(Value::as_str))
            .or_else(|| job["headSha"].as_str())
    } else {
        job["headSha"].as_str()
    };
    let Some(expected) = expected.filter(|s| !s.is_empty()) else {
        return Ok(blocked("No durable Job head SHA"));
    };
    let owns_lease = |record: &Value| {
        record.get("executionId").is_some_and(|v| !v.is_null())
    };
    if job["tasks"]
        .as_array()
        .is_some_and(|tasks| tasks.iter().any(owns_lease))
    {
        return Ok(blocked("Task still owns an execution or lease"));
    }
    if job["plans"]
        .as_array()
        .is_some_and(|plans| plans.iter().any(owns_lease))
    {
        return Ok(blocked("Planner still owns an execution or lease"));
    }
    let repository = job["repository"].as_str().ok_or("Job repository missing")?;
    let worktree = if local {
        managed_local_job_worktree_path(
            workspace_root,
            repository,
            &job["id"]
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| job["id"].to_string()),
        )?
    } else {
        // Legacy PR checkouts use an explicit local-only path. No network or PR query.
        let number = job["prNumber"]
            .as_i64()
            .ok_or("Invalid managed Job checkout identity")?;
        let parts = repository.split('/').collect::<Vec<_>>();
        if parts.len() != 2
            || parts.iter().any(|part| {
                part.is_empty()
                    || !part
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
            })
            || number <= 0
        {
            return Err("Invalid managed Job checkout identity".into());
        }
        workspace_root
            .join(".worktrees/agents-relay")
            .join(format!("{}-{}-pr-{number}", parts[0], parts[1]))
            .join("job")
    };
    let meta = match fs::symlink_metadata(&worktree) {
        Ok(meta) => meta,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(serde_json::json!({"status":"absent"}))
        }
        Err(err) => return Err(err.to_string()),
    };
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Ok(blocked("Worktree path is not an owned directory"));
    }
    let primary = cleanup_git(project_path, &["rev-parse", "--show-toplevel"])?;
    let canonical = fs::canonicalize(&primary).map_err(|e| e.to_string())?;
    let recorded_root =
        fs::canonicalize(job["projectRoot"].as_str().unwrap_or("")).map_err(|e| e.to_string())?;
    if canonical != recorded_root
        || canonical.file_name().and_then(|s| s.to_str()) != Some(repository)
    {
        return Ok(blocked("Canonical local repository identity mismatch"));
    }
    let owned_root = fs::canonicalize(&worktree).map_err(|e| e.to_string())?;
    let registered = cleanup_git(&canonical, &["worktree", "list", "--porcelain"])?;
    let found = registered
        .lines()
        .filter_map(|l| l.strip_prefix("worktree "))
        .filter_map(|p| fs::canonicalize(p).ok())
        .any(|p| p == owned_root);
    if !found {
        return Ok(blocked(
            "Worktree is not registered with the canonical repository",
        ));
    }
    if cleanup_git(&worktree, &["rev-parse", "HEAD"])? != expected {
        return Ok(blocked("Worktree contains unique or stale commits"));
    }
    if !cleanup_git(&worktree, &["status", "--porcelain"])?.is_empty() {
        return Ok(blocked("Worktree has uncommitted or untracked changes"));
    }
    cleanup_git(
        &canonical,
        &[
            "worktree",
            "remove",
            worktree.to_str().ok_or("Invalid worktree path")?,
        ],
    )?;
    Ok(serde_json::json!({"status":"removed"}))
}

/// Use the caller's verified canonical resolver, with the native cleanup
/// effect. Blocked cleanup propagates exactly like the Node wrapper.
pub fn cleanup_merged_job_worktree_native<R>(
    job: &Value,
    cwd_for_job: Option<R>,
    workspace_root: &Path,
) -> Result<(), String>
where
    R: FnMut(&Value) -> Result<String, String>,
{
    cleanup_merged_job_worktree(job, cwd_for_job, |cwd, job| {
        cleanup_completed_job_worktree(Path::new(cwd), job, workspace_root)
    })
}

#[cfg(test)]
mod native_cleanup_tests {
    use super::*;
    use serde_json::json;
    fn git(repo: &Path, args: &[&str]) -> String {
        cleanup_git(repo, args).unwrap()
    }
    #[test]
    fn local_worktree_cleanup_does_not_delete_dirty_or_unverified_paths() {
        let root = std::env::temp_dir().join(format!(
            "rust2-delivery-native-cleanup-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let workspace = root.join("workspace");
        let primary = root.join("myrepo");
        fs::create_dir_all(&primary).unwrap();
        fs::create_dir_all(&workspace).unwrap();
        git(&primary, &["init", "-q", "-b", "main"]);
        git(&primary, &["config", "user.name", "Fixture"]);
        git(&primary, &["config", "user.email", "fixture@example.test"]);
        fs::write(primary.join("base"), "first").unwrap();
        git(&primary, &["add", "base"]);
        git(&primary, &["commit", "-qm", "first"]);
        let root_path = fs::canonicalize(&primary).unwrap();
        let path = managed_local_job_worktree_path(&workspace, "myrepo", "92").unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        git(&primary, &["branch", "feature"]);
        git(
            &primary,
            &["worktree", "add", "-q", path.to_str().unwrap(), "feature"],
        );
        let head = git(&path, &["rev-parse", "HEAD"]);
        let job = json!({"state":"COMPLETED","repository":"myrepo","projectRoot":root_path,
            "id":"92","tasks":[],"plans":[],"localMerge":{"sourceRef":"refs/heads/feature","sourceSha":head}});
        fs::write(path.join("untracked"), "must preserve").unwrap();
        assert_eq!(
            cleanup_completed_job_worktree(&primary, &job, &workspace).unwrap()["reason"],
            "Worktree has uncommitted or untracked changes"
        );
        assert!(path.exists());
        fs::remove_file(path.join("untracked")).unwrap();
        let mut stale = job.clone();
        stale["localMerge"]["sourceSha"] = json!("bad");
        assert_eq!(
            cleanup_completed_job_worktree(&primary, &stale, &workspace).unwrap()["reason"],
            "Worktree contains unique or stale commits"
        );
        let mut leased = job.clone();
        leased["tasks"] = json!([{"executionId":"running"}]);
        assert_eq!(
            cleanup_completed_job_worktree(&primary, &leased, &workspace).unwrap()["reason"],
            "Task still owns an execution or lease"
        );
        assert_eq!(
            cleanup_completed_job_worktree(&primary, &job, &workspace).unwrap()["status"],
            "removed"
        );
        assert_eq!(
            cleanup_completed_job_worktree(&primary, &job, &workspace).unwrap()["status"],
            "absent"
        );
        assert!(!path.exists());
        let _ = fs::remove_dir_all(root);
    }
}
