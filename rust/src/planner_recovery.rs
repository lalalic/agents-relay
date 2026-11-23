// Direct src/planner-recovery.ts port. IDs allocated through shared SQLite global
// task sequence; never invent IDs or mutate FAILED Plan. Fixture caller must
// supply an isolated store directory and the canonical graph directory.
use crate::{
    job_task_id_sequence::allocate_entity_id, local_merge_lock::iso8601_now,
    workflow::entity_creation::create_task_entity,
};
use serde_json::{json, Value};
use std::{collections::HashSet, path::Path};
pub fn create_failed_plan_recovery(
    root: &Path,
    store_dir: &Path,
    job: &Value,
    plan: &Value,
) -> Result<Value, String> {
    if plan["status"] != "FAILED" {
        return Err("Plan recovery requires a terminal FAILED Plan".into());
    }
    if let Some(existing) = job["tasks"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|t| t["recoveryPlanId"] == plan["id"])
    {
        return Ok(existing.clone());
    }
    let jid = job["id"].as_str().unwrap_or("undefined");
    let repo = job["repository"].as_str().unwrap_or("");
    let plan_id = plan["id"].as_str().unwrap_or("undefined");
    let key = format!("planner-recovery:{jid}:{plan_id}");
    let occupied = job["tasks"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|t| t["id"].as_str().map(str::to_string))
        .collect::<HashSet<_>>();
    let id = allocate_entity_id(store_dir, repo, "task", Some(&key), &occupied)?;
    let now = iso8601_now();
    let failure = plan["error"]
        .as_str()
        .or_else(|| plan["assessment"].as_str())
        .unwrap_or("undefined");
    let input=format!("Recover FAILED Plan {plan_id} in Job {jid}, repository {repo}.
Original Plan failure: {failure}.
Inspect durable Plan history and original model/runtime error; repair or verify the actual blocker.
Do not fabricate Planner success, create another Job, or publish blocked.
Report task.completed only after verified technical recovery, with data.verified=true and non-empty data.evidence explaining the repair.
Relay will create a NEW authoritative Plan round after your completed recovery evidence; it will not re-label the FAILED Plan as successful.");
    let mut task = json!({
        "jobId":job["id"],"id":id,"title":"Troubleshooter","recoveryPlanId":plan["id"],"kind":"work",
        "priority":"P0","storySize":"M","projectName":job["title"],"agentName":"troubleshooter",
        "parentTaskId":null,"dependencies":[],"capabilities":["troubleshoot","recovery"],
        "workerRequirements":{"capabilities":["model","local_repo","iterative_tools"],"runtime":"codex"},
        "adapter":"codex","input":input,"output":{"kind":"task_pr"},"continuation":null,
        "continuationDeliveredAt":null,"attempt":0,"maxAttempts":3,"executionId":null,"threadId":null,"result":null,"plannerResult":null,"error":null,
        "timeoutMs":900000,"createdAt":now,"updatedAt":now
    });
    // TS createTaskEntity may add defaults/mutate status using task Graph.
    task = create_task_entity(root, job, &task, false, &now)?;
    Ok(task)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_nonterminal() {
        assert_eq!(
            create_failed_plan_recovery(
                Path::new("/tmp"),
                Path::new("/tmp"),
                &json!({}),
                &json!({"status":"PLANNING"})
            )
            .unwrap_err(),
            "Plan recovery requires a terminal FAILED Plan"
        );
    }
}
