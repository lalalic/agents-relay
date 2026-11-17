// Direct port of Node src/workflow/troubleshooter-v2.ts: failed execution diagnoses and user-authoritative unblocks, Graph-selected only.
use super::{
    graph_v2::GraphRuntime,
    policy_graph::{execute_policy, load_policy_graph},
};
use serde_json::{json, Value};
use std::path::Path;
pub const TROUBLESHOOTER_V2: &str = "troubleshooter";
pub fn troubleshooter_v2(directory: &Path) -> Result<GraphRuntime, String> {
    load_policy_graph(directory, TROUBLESHOOTER_V2)
}
pub fn decide_troubleshooter(directory: &Path, facts: &Value) -> Result<Value, String> {
    // Node decideTroubleshooter calls dispatchTroubleshooter with an empty onCreate callback.
    dispatch_troubleshooter(directory, facts, || Ok(()))
}
pub fn dispatch_troubleshooter<F>(
    directory: &Path,
    facts: &Value,
    mut on_create: F,
) -> Result<Value, String>
where
    F: FnMut() -> Result<(), String>,
{
    execute_policy(
        directory,
        TROUBLESHOOTER_V2,
        "idle",
        "troubleshooter.reconcile",
        facts,
        6,
        |state| state.starts_with("check_"),
        |action| {
            if action == "troubleshooter.create" {
                on_create()?;
                Ok(json!({}))
            } else {
                Err(format!("Unsupported troubleshooter graph action {action}"))
            }
        },
    )
}
