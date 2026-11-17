// Shared constructor for Node workflow/*-v2.ts Graph wrappers. All transitions come from
// their canonical executable .mmd files, never from duplicate Rust policy tables.
use super::{
    dispatcher::{decide_workflow_graph, dispatch_workflow_graph_sync, DispatchOptions},
    graph_v2::{GraphRegistry, GraphRuntime, Guard},
};
use serde_json::{json, Value};
use std::{collections::HashSet, path::Path, sync::Arc};

fn js_number(value: Option<&Value>) -> f64 {
    match value {
        None | Some(Value::Null) => 0.0,
        Some(Value::Bool(true)) => 1.0,
        Some(Value::Bool(false)) => 0.0,
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => {
            let s = s.trim();
            if s.is_empty() {
                0.0
            } else {
                s.parse::<f64>().unwrap_or(f64::NAN)
            }
        }
        _ => f64::NAN,
    }
}
fn guard_fact(semantic_id: &str) -> Guard {
    let key = semantic_id.to_owned();
    Arc::new(move |context| {
        let facts = &context["durableFacts"];
        if key == "delivery.retryAvailable" {
            return js_number(facts.get("attempts")) < js_number(facts.get("maxAttempts"));
        }
        let field = key.strip_prefix("delivery.").unwrap_or(&key);
        // Main's delivery Graph maps prefixed guard names to unprefixed durable facts.
        facts.get(field).and_then(Value::as_bool) == Some(true)
    })
}
/// Every state/action/event/guard is sourced from the parsed canonical Graph,
/// with the Node wrapper's standard strict-true boolean guard and retry guard.
pub fn load_policy_graph(directory: &Path, name: &str) -> Result<GraphRuntime, String> {
    let source = std::fs::read_to_string(directory.join(format!("{name}.mmd")))
        .map_err(|e| e.to_string())?;
    load_policy_graph_source(&source)
}
pub fn load_policy_graph_source(source: &str) -> Result<GraphRuntime, String> {
    let graph = super::graph_v2::parse_graph_v2(source)?;
    let mut registry = GraphRegistry {
        states: graph
            .nodes
            .iter()
            .filter(|node| node.kind == "state")
            .map(|node| node.semantic_id.clone())
            .collect::<HashSet<_>>(),
        ..Default::default()
    };
    for node in &graph.nodes {
        match node.kind.as_str() {
            "guard" => {
                registry
                    .guards
                    .insert(node.semantic_id.clone(), guard_fact(&node.semantic_id));
            }
            "action" => {
                registry
                    .actions
                    .insert(node.semantic_id.clone(), (None, None));
            }
            "emit" => {
                registry.events.insert(node.semantic_id.clone(), None);
            }
            _ => {}
        }
    }
    for edge in &graph.edges {
        if let Some(semantic) = edge.semantic_id.as_ref() {
            match edge.kind.as_str() {
                "on" | "emit" => {
                    registry.events.insert(semantic.to_string(), None);
                }
                "request" => {
                    registry.actions.insert(semantic.to_string(), (None, None));
                }
                _ => {}
            }
        }
    }
    GraphRuntime::new(source, registry)
}
pub fn choose_policy(
    directory: &Path,
    name: &str,
    state: &str,
    event: &str,
    facts: &Value,
    max_steps: usize,
    transient: impl FnMut(&str) -> bool,
) -> Result<Value, String> {
    let runtime = load_policy_graph(directory, name)?;
    let mut options = DispatchOptions::event(state, event, facts, max_steps);
    options.graph_name = Some(name.into());
    decide_workflow_graph(&runtime, &options, transient)
}
// Node's dispatch options expose eight independent policy dimensions.
// Keep their names visible to the file-by-file parity fixtures rather than
// folding them into a second state-policy abstraction.
#[allow(clippy::too_many_arguments)]
pub fn execute_policy(
    directory: &Path,
    name: &str,
    state: &str,
    event: &str,
    facts: &Value,
    max_steps: usize,
    transient: impl FnMut(&str) -> bool,
    mut execute: impl FnMut(&str) -> Result<Value, String>,
) -> Result<Value, String> {
    let runtime = load_policy_graph(directory, name)?;
    let mut options = DispatchOptions::event(state, event, facts, max_steps);
    options.graph_name = Some(name.into());
    dispatch_workflow_graph_sync(
        &runtime,
        &options,
        transient,
        |_, _| Ok(()),
        |id| execute(id),
        |_, _| Ok(()),
    )
}
pub fn no_action(_name: &str) -> Result<Value, String> {
    Ok(json!({}))
}
