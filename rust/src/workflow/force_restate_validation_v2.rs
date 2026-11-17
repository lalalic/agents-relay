// Direct port of Node src/workflow/force-restate-validation-v2.ts: transient check_ states follow canonical Mermaid Plan Graph.
use super::{
    graph_v2::GraphRuntime,
    policy_graph::{choose_policy, load_policy_graph},
};
use serde_json::Value;
use std::path::Path;
pub const FORCE_RESTATE_VALIDATION_V2: &str = "force-restate-validation";
pub fn force_restate_validation_v2(directory: &Path) -> Result<GraphRuntime, String> {
    load_policy_graph(directory, FORCE_RESTATE_VALIDATION_V2)
}
pub fn decide_force_restate_validation(directory: &Path, facts: &Value) -> Result<Value, String> {
    choose_policy(
        directory,
        FORCE_RESTATE_VALIDATION_V2,
        "idle",
        "plan.apply",
        facts,
        12,
        |state| state.starts_with("check_"),
    )
}
