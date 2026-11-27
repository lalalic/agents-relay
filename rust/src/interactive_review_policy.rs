//! Execution-bound interactive review capability. Independent of Job Final Review.
use crate::reconciler_context::WorkerContextRoots;
use serde_json::{json, Value};

pub fn agent_supports_review(metadata: &Value) -> Result<bool, String> {
    match metadata.get("interactive_review") {
        None => Ok(false),
        Some(Value::Bool(v)) => Ok(*v),
        Some(Value::String(v)) if v == "true" => Ok(true),
        Some(Value::String(v)) if v == "false" => Ok(false),
        _ => Err("Agent interactive_review must be true or false".into()),
    }
}
pub fn enabled(job: &Value, task: &Value) -> bool {
    job["interactiveReviewEnabled"] == true && task["interactiveReviewEnabled"] == true
}
/// Resolve the same inherited Agent source as the Worker before persisting its lease.
pub fn bind_claim(
    job: &mut Value,
    task_id: &str,
    roots: &WorkerContextRoots,
) -> Result<(), String> {
    let project = job["projectRoot"]
        .as_str()
        .ok_or("Job requires projectRoot")?;
    let index = job["tasks"]
        .as_array()
        .and_then(|a| a.iter().position(|t| t["id"] == task_id))
        .ok_or("Claimed Task missing")?;
    let task = &job["tasks"][index];
    let name = task["agentName"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or("implementation");
    let supports = if job["interactiveReviewEnabled"] == true {
        let layers = crate::agent_content_resolver::agent_source_layers(
            project,
            &json!({"workspaceRoot":roots.workspace,"globalRoot":roots.global}),
        );
        let agent = crate::agent_content_resolver::resolve_agent_markdown(
            name,
            &crate::runtime_resources::bundled_agents_root()?,
            project,
            Some(&layers),
        )?;
        agent_supports_review(&agent["metadata"])?
    } else {
        false
    };
    job["tasks"][index]["interactiveReviewEnabled"] = json!(supports);
    Ok(())
}
pub fn require_current(job: &Value, task_id: &str, execution_id: &str) -> Result<(), String> {
    let task = job["tasks"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|t| t["id"] == task_id)
        .ok_or("Interactive review Task not found")?;
    if job["state"] != "ACTIVE"
        || task["state"] != "RUNNING"
        || task["executionId"] != execution_id
        || execution_id.is_empty()
    {
        return Err("Interactive review requires current ACTIVE/RUNNING Task execution".into());
    }
    if !enabled(job, task) {
        return Err("INTERACTIVE_REVIEW_DISABLED: Job and Agent must both opt in".into());
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn two_switches_and_fence() {
        for j in [false, true] {
            for a in [false, true] {
                let job = json!({"state":"ACTIVE","interactiveReviewEnabled":j,"tasks":[{"id":"1","state":"RUNNING","executionId":"exec","interactiveReviewEnabled":a}]});
                assert_eq!(require_current(&job, "1", "exec").is_ok(), j && a);
                assert!(require_current(&job, "1", "stale").is_err());
            }
        }
        assert!(!agent_supports_review(&json!({})).unwrap());
        assert!(agent_supports_review(&json!({"interactive_review":"true"})).unwrap());
        assert!(agent_supports_review(&json!({"interactive_review":"yes"})).is_err());
    }
}
