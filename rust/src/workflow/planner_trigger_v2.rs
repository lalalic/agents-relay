// Direct port of Node src/workflow/planner-trigger-v2.ts: manual/unblock/initial/review/continuation path selection delegated to Mermaid.
use super::{
    graph_v2::GraphRuntime,
    policy_graph::{choose_policy, load_policy_graph},
};
use serde_json::Value;
use std::path::Path;
pub const PLANNER_TRIGGER_V2: &str = "planner-trigger";
pub fn planner_trigger_v2(directory: &Path) -> Result<GraphRuntime, String> {
    load_policy_graph(directory, PLANNER_TRIGGER_V2)
}
pub fn dispatch_planner_trigger(directory: &Path, facts: &Value) -> Result<Value, String> {
    choose_policy(
        directory,
        PLANNER_TRIGGER_V2,
        "idle",
        "plan.requested",
        facts,
        5,
        |state| state.starts_with("check_"),
    )
}
pub fn decide_planner_trigger(directory: &Path, facts: &Value) -> Result<Value, String> {
    dispatch_planner_trigger(directory, facts)
}
