// Direct port of Node src/workflow/authoritative-unblock-v2.ts; only the canonical Graph may authorize a blocked Task release.
use super::{
    graph_v2::GraphRuntime,
    policy_graph::{choose_policy, execute_policy, load_policy_graph},
};
use serde_json::{json, Value};
use std::path::Path;
pub const AUTHORITATIVE_UNBLOCK_V2: &str = "authoritative-unblock";
pub fn authoritative_unblock_v2(directory: &Path) -> Result<GraphRuntime, String> {
    load_policy_graph(directory, AUTHORITATIVE_UNBLOCK_V2)
}
pub fn decide_authoritative_unblock(
    directory: &Path,
    blocked_troubleshooter: bool,
) -> Result<Value, String> {
    choose_policy(
        directory,
        AUTHORITATIVE_UNBLOCK_V2,
        "blocked",
        "task.authoritative_unblock",
        &json!({"blockedTroubleshooter":blocked_troubleshooter}),
        1,
        |_| false,
    )
}
pub async fn dispatch_authoritative_unblock<F>(
    directory: &Path,
    blocked_troubleshooter: bool,
    mut execute: F,
) -> Result<Value, String>
where
    F: FnMut(&str) -> Result<Value, String>,
{
    execute_policy(
        directory,
        AUTHORITATIVE_UNBLOCK_V2,
        "blocked",
        "task.authoritative_unblock",
        &json!({"blockedTroubleshooter":blocked_troubleshooter}),
        1,
        |_| false,
        |id| execute(id),
    )
}
