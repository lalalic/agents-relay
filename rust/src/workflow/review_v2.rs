// Direct port of Node src/workflow/review-v2.ts: graph-owned Review lifecycle with immutable approval/revision head checks.
use super::{
    graph_v2::GraphRuntime,
    policy_graph::{choose_policy, execute_policy, load_policy_graph},
};
use serde_json::Value;
use std::path::Path;
pub const REVIEW_LIFECYCLE_V2: &str = "review-lifecycle";
pub fn review_lifecycle_v2(directory: &Path) -> Result<GraphRuntime, String> {
    load_policy_graph(directory, REVIEW_LIFECYCLE_V2)
}
pub fn review_graph_state(outcome: Option<&str>) -> String {
    outcome.unwrap_or("NONE").to_uppercase()
}
pub fn review_outcome(state: &str) -> Result<Option<String>, String> {
    match state {
        "NONE" => Ok(None),
        "PENDING" | "STARTED" | "APPROVED" | "CHANGES_REQUIRED" | "BLOCKED" | "STALE" => {
            Ok(Some(state.to_lowercase()))
        }
        _ => Err(format!("Unknown review graph state {state}")),
    }
}
pub fn decide_review_lifecycle(
    directory: &Path,
    outcome: Option<&str>,
    event: &str,
    facts: &Value,
) -> Result<Value, String> {
    let state = review_graph_state(outcome);
    choose_policy(
        directory,
        REVIEW_LIFECYCLE_V2,
        &state,
        event,
        facts,
        1,
        |_| false,
    )
}
pub async fn dispatch_review_lifecycle<F>(
    directory: &Path,
    outcome: Option<&str>,
    event: &str,
    facts: &Value,
    mut execute: F,
) -> Result<Value, String>
where
    F: FnMut(&str) -> Result<Value, String>,
{
    let state = review_graph_state(outcome);
    execute_policy(
        directory,
        REVIEW_LIFECYCLE_V2,
        &state,
        event,
        facts,
        1,
        |_| false,
        |action| execute(action),
    )
}
