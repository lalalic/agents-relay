// Direct port of Node src/workflow/escalation.ts: escalation is invoked as a native Graph action;
// the result branch comes only from the executable escalation.mmd and owns who gets notified.
use super::{
    dispatcher::{dispatch_workflow_graph_sync, DispatchOptions},
    graph_v2::GraphRuntime,
    policy_graph::load_policy_graph,
};
use serde_json::{json, Value};
use std::{path::Path, sync::Arc};
pub const ESCALATION_GRAPH: &str = "escalation";
pub fn escalation_graph(directory: &Path) -> Result<GraphRuntime, String> {
    let mut graph = load_policy_graph(directory, ESCALATION_GRAPH)?;
    for (guard, status) in [
        ("escalationResolved", "resolved"),
        ("escalationFailed", "failed"),
        ("escalationNeedsUser", "needs_user"),
    ] {
        let status = status.to_string();
        graph.registry.guards.insert(
            guard.into(),
            Arc::new(move |facts| facts["durableFacts"]["escalationStatus"] == status),
        );
    }
    Ok(graph)
}
pub async fn run_escalation_graph<Invoke, Recover, Technical, Block>(
    directory: &Path,
    request: &Value,
    mut invoke: Invoke,
    mut recover: Recover,
    mut technical: Technical,
    mut block: Block,
) -> Result<Value, String>
where
    Invoke: FnMut(&Value) -> Result<Value, String>,
    Recover: FnMut(&Value) -> Result<(), String>,
    Technical: FnMut(&Value) -> Result<(), String>,
    Block: FnMut(&Value) -> Result<(), String>,
{
    let runtime = escalation_graph(directory)?;
    let request_opts = DispatchOptions::event(
        "suspected_human_blocker",
        "escalation.requested",
        &json!({}),
        1,
    );
    let mut result: Option<Value> = None;
    let request_decision = dispatch_workflow_graph_sync(
        &runtime,
        &request_opts,
        |_| false,
        |_, _| Ok(()),
        |id| {
            if id != "escalation.invoke" {
                return Err(format!("Unexpected escalation request action {id}"));
            }
            result = Some(invoke(request)?);
            Ok(json!({}))
        },
        |_, _| Ok(()),
    )?;
    if request_decision["accepted"] != true
        || request_decision["target"] != "invoking"
        || result.is_none()
    {
        return Err("Escalation graph did not invoke the escalation executor".into());
    }
    let result = result.expect("checked escalation result");
    let facts = json!({"escalationStatus":result.get("status").cloned().unwrap_or(Value::Null)});
    let result_opts = DispatchOptions::event("invoking", "escalation.result", &facts, 1);
    let result_decision = dispatch_workflow_graph_sync(
        &runtime,
        &result_opts,
        |_| false,
        |_, _| Ok(()),
        |id| {
            match id {
                "escalation.resume_recovery" => recover(&result)?,
                "escalation.technical_failure" => technical(&result)?,
                "escalation.block_for_user" => block(&result)?,
                _ => return Err(format!("Unexpected escalation result action {id}")),
            }
            Ok(json!({}))
        },
        |_, _| Ok(()),
    )?;
    if result_decision["accepted"] != true {
        return Err(format!(
            "Escalation graph rejected result {}",
            result["status"].as_str().unwrap_or("undefined")
        ));
    }
    let target = result_decision["target"].as_str().unwrap_or("undefined");
    if !matches!(target, "resolved" | "technical_failure" | "needs_user") {
        return Err(format!(
            "Escalation graph returned unexpected state {target}"
        ));
    }
    Ok(
        json!({"state":target,"result":result,"requestDecision":request_decision,"resultDecision":result_decision}),
    )
}
