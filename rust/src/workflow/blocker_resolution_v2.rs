// Direct port of Node src/workflow/blocker-resolution-v2.ts: strict blocker target validation and graph-authorized draft release.
use super::{
    graph_v2::GraphRuntime,
    policy_graph::{choose_policy, execute_policy, load_policy_graph},
};
use serde_json::Value;
use std::path::Path;
pub const BLOCKER_RESOLUTION_V2: &str = "blocker-resolution";
pub fn blocker_resolution_v2(directory: &Path) -> Result<GraphRuntime, String> {
    load_policy_graph(directory, BLOCKER_RESOLUTION_V2)
}
pub fn decide_blocker_resolution(directory: &Path, facts: &Value) -> Result<Value, String> {
    choose_policy(
        directory,
        BLOCKER_RESOLUTION_V2,
        "waiting",
        "blocker.resolved",
        facts,
        10,
        |state| state.starts_with("check_"),
    )
}
pub async fn dispatch_blocker_resolution<F>(
    directory: &Path,
    facts: &Value,
    mut execute: F,
) -> Result<Value, String>
where
    F: FnMut(&str) -> Result<Value, String>,
{
    execute_policy(
        directory,
        BLOCKER_RESOLUTION_V2,
        "waiting",
        "blocker.resolved",
        facts,
        10,
        |state| state.starts_with("check_"),
        |action| execute(action),
    )
}
