// Direct port of Node src/workflow/projection-conflict-v2.ts: post-COMPLETED Git delivery classification and historical projection-outbox conflict.
use super::{
    graph_v2::GraphRuntime,
    policy_graph::{choose_policy, load_policy_graph},
};
use serde_json::Value;
use std::path::Path;
pub const PROJECTION_CONFLICT_V2: &str = "projection-conflict";
pub const PROJECTION_OUTBOX_CONFLICT_V2: &str = "projection-outbox-conflict";
pub fn projection_conflict_v2(directory: &Path) -> Result<GraphRuntime, String> {
    load_policy_graph(directory, PROJECTION_CONFLICT_V2)
}
pub fn projection_outbox_conflict_v2(directory: &Path) -> Result<GraphRuntime, String> {
    load_policy_graph(directory, PROJECTION_OUTBOX_CONFLICT_V2)
}
pub fn decide_projection_failure(directory: &Path, facts: &Value) -> Result<Value, String> {
    choose_policy(
        directory,
        PROJECTION_OUTBOX_CONFLICT_V2,
        "classify",
        "projection.failed",
        facts,
        1,
        |_| false,
    )
}
pub fn decide_projection_delivery(
    directory: &Path,
    state: &str,
    event: &str,
    facts: &Value,
) -> Result<Value, String> {
    choose_policy(
        directory,
        PROJECTION_CONFLICT_V2,
        state,
        event,
        facts,
        1,
        |_| false,
    )
}
