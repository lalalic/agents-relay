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
