// Direct port of Node src/workflow/revision-v2.ts: immutable review revision request/queue/run/verify/stale transitions.
use super::{
    graph_v2::GraphRuntime,
    policy_graph::{choose_policy, execute_policy, load_policy_graph},
};
use serde_json::Value;
use std::path::Path;
pub const REVISION_LIFECYCLE: &str = "revision-lifecycle";
pub fn revision_lifecycle(directory: &Path) -> Result<GraphRuntime, String> {
    load_policy_graph(directory, REVISION_LIFECYCLE)
}
pub fn decide_revision_lifecycle(
    directory: &Path,
    state: &str,
    event: &str,
    facts: &Value,
) -> Result<Value, String> {
    choose_policy(
        directory,
        REVISION_LIFECYCLE,
        state,
        event,
        facts,
        1,
        |_| false,
    )
}
pub async fn dispatch_revision_lifecycle<F>(
    directory: &Path,
    state: &str,
    event: &str,
    facts: &Value,
    mut execute: F,
) -> Result<Value, String>
where
    F: FnMut(&str) -> Result<Value, String>,
{
    execute_policy(
        directory,
        REVISION_LIFECYCLE,
        state,
        event,
        facts,
        1,
        |_| false,
        |action| execute(action),
    )
}
