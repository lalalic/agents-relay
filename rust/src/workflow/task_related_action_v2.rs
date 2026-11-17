// Direct port of Node src/workflow/task-related-action-v2.ts: related Task selection is Graph-owned,
// including the Task lifecycle's authoritative cancel eligibility.
use super::{
    dispatcher::{decide_workflow_graph, DispatchOptions},
    graph_v2::GraphRuntime,
    lifecycle::decide_task_lifecycle,
    policy_graph::load_policy_graph,
};
use serde_json::{json, Value};
use std::path::Path;
pub const TASK_RELATED_ACTION_V2: &str = "task-related-action";
pub fn task_related_action_v2(directory: &Path) -> Result<GraphRuntime, String> {
    load_policy_graph(directory, TASK_RELATED_ACTION_V2)
}
pub fn related_task_action_facts(
    directory: &Path,
    task: &Value,
    candidate: &Value,
) -> Result<Value, String> {
    let cancel = decide_task_lifecycle(directory, candidate, "cancel", &json!({}))?;
    Ok(json!({"otherTask":candidate.get("id")!=task.get("id"),
        "recoveryForTask":candidate["agentName"]=="troubleshooter"&&candidate.get("parentTaskId")==task.get("id"),
        "candidateCancellable":cancel["accepted"]==true}))
}
pub fn decide_related_task_action(
    directory: &Path,
    task: &Value,
    candidate: &Value,
    action_id: &str,
) -> Result<Value, String> {
    let runtime = task_related_action_v2(directory)?;
    let facts = related_task_action_facts(directory, task, candidate)?;
    let options = DispatchOptions {
        initial_state: "evaluate",
        input: json!({"transport":"action","id":action_id,"payload":{}}),
        durable_facts: facts,
        max_steps: 3,
        observe: true,
        graph_name: Some(TASK_RELATED_ACTION_V2.into()),
    };
    decide_workflow_graph(&runtime, &options, |state| {
        matches!(state, "check_other" | "check_recovery")
    })
}
