// Direct port of Node src/workflow/blocker-recovery.ts: durable authorized blocker creation/adoption via canonical Mermaid.
use super::{
    graph_v2::GraphRuntime,
    policy_graph::{execute_policy, load_policy_graph},
};
use serde_json::Value;
use std::path::Path;
pub const BLOCKER_RECOVERY_GRAPH: &str = "blocker-recovery";
pub fn blocker_recovery_graph(directory: &Path) -> Result<GraphRuntime, String> {
    load_policy_graph(directory, BLOCKER_RECOVERY_GRAPH)
}
pub async fn dispatch_blocker_recovery<F>(
    directory: &Path,
    facts: &Value,
    mut execute: F,
) -> Result<Value, String>
where
    F: FnMut(&str) -> Result<Value, String>,
{
    execute_policy(
        directory,
        BLOCKER_RECOVERY_GRAPH,
        "entry",
        "blocker.recovery.ensure",
        facts,
        16,
        |state| {
            state.starts_with("check_") || state.starts_with("validate_") || state == "register"
        },
        |action| execute(action),
    )
}
