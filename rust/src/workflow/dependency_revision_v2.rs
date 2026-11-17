// Direct port of Node src/workflow/dependency-revision-v2.ts: canonical Graph-only dependency validity/revision decisions.
use super::{
    graph_v2::GraphRuntime,
    policy_graph::{choose_policy, load_policy_graph},
};
use serde_json::Value;
use std::path::Path;
pub const DEPENDENCY_REVISION_LIFECYCLE: &str = "dependency-revision";
pub fn dependency_revision_lifecycle(directory: &Path) -> Result<GraphRuntime, String> {
    load_policy_graph(directory, DEPENDENCY_REVISION_LIFECYCLE)
}
pub fn decide_dependency_revision(
    directory: &Path,
    event: &str,
    facts: &Value,
    state: &str,
) -> Result<Value, String> {
    choose_policy(
        directory,
        DEPENDENCY_REVISION_LIFECYCLE,
        state,
        event,
        facts,
        1,
        |_| false,
    )
}
