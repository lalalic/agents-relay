// Direct port of Node src/cli-local-merge-config.ts: validate and set a Job local merge.
use serde_json::{json, Value};

pub fn configure_local_git_merge(
    job: &mut Value,
    source: &str,
    target: &str,
    _local_only: bool,
) -> Result<(), String> {
    if source.is_empty() {
        return Err("Local merge source is required".into());
    }
    if target != "refs/heads/main" {
        return Err("Local Git merge target must always be refs/heads/main".into());
    }
    if !matches!(job["state"].as_str(), Some("ACTIVE" | "DRAFT")) {
        return Err("Cannot reconfigure merge of a terminal Job".into());
    }
    job["localMerge"] = json!({"sourceRef": source, "targetRef": target, "status": "pending"});
    Ok(())
}
