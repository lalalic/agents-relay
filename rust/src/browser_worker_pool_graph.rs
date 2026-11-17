// Direct port of Node src/browser-worker-pool-graph.ts. Canonical Mermaid owns decisions;
// this module only binds facts and validates the selected single effect.
use crate::workflow::{
    dispatcher::{dispatch_workflow_graph_sync, DispatchOptions},
    graph_v2::GraphRuntime,
    policy_graph::load_policy_graph_source,
};
use serde_json::{json, Value};

pub const SOURCE: &str = include_str!("../../workflow/browser-worker-pool.mmd");

pub fn browser_pool_graph() -> Result<GraphRuntime, String> {
    load_policy_graph_source(SOURCE)
}

pub fn pool_decision(state: &str, event: &str, facts: &Value) -> Result<Value, String> {
    let graph = browser_pool_graph()?;
    let mut options = DispatchOptions::event(state, event, facts, 1);
    options.input = json!({"transport":"event","id":event,"payload":null});
    options.observe = false;
    options.graph_name = Some("browser-worker-pool".into());
    dispatch_workflow_graph_sync(
        &graph,
        &options,
        |_| false,
        |_, _| Ok(()),
        |_| Ok(json!({})),
        |_, _| Ok(()),
    )
}

/// Equivalent to requirePoolDecision: a rejected, missing or unexpected action is an error.
pub fn require_pool_decision(
    state: &str,
    event: &str,
    expected_action: &str,
    provider_healthy: bool,
) -> Result<Value, String> {
    let decision = pool_decision(state, event, &json!({"providerHealthy":provider_healthy}))?;
    let actions = decision["actions"].as_array();
    if decision["accepted"] != true
        || actions.is_none_or(|items| items.len() != 1)
        || decision["actions"][0]["id"] != format!("pool.{expected_action}")
    {
        return Err(format!(
            "Browser Pool Graph rejected {state}/{event}: expected pool.{expected_action}"
        ));
    }
    Ok(decision)
}

pub fn monitor_pool_decision(recovery_due: bool) -> Result<&'static str, String> {
    let d = pool_decision("LEASED", "pool.poll", &json!({"recoveryDue":recovery_due}))?;
    if d["accepted"] != true
        || d["target"] != "LEASED"
        || d["actions"].as_array().is_none_or(|a| a.len() != 1)
    {
        return Err("Invalid Pool monitoring graph".into());
    }
    match d["actions"][0]["id"].as_str() {
        Some("pool.recoverTurn") => Ok("recoverTurn"),
        Some("pool.keepMonitoring") => Ok("keepMonitoring"),
        Some(id) => Err(format!("Unknown Pool monitoring action {id}")),
        None => Err("Invalid Pool monitoring graph".into()),
    }
}

pub fn progress_pool_decision(fresh_output: bool) -> Result<&'static str, String> {
    let d = pool_decision(
        "LEASED",
        "pool.progressObserved",
        &json!({"freshOutput":fresh_output}),
    )?;
    if d["accepted"] != true
        || d["target"] != "LEASED"
        || d["actions"].as_array().is_none_or(|a| a.len() != 1)
    {
        return Err("Invalid Pool progress graph".into());
    }
    match d["actions"][0]["id"].as_str() {
        Some("pool.extendTimeout") => Ok("extendTimeout"),
        Some("pool.keepMonitoring") => Ok("keepMonitoring"),
        Some(id) => Err(format!("Unknown Pool progress action {id}")),
        None => Err("Invalid Pool progress graph".into()),
    }
}
