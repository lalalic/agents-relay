// Direct port of Node src/workflow/dispatcher.ts. The Graph chooses every transition and effect;
// this adapter alone invokes effects, persists transitions, emits events and advances transient states.
use super::graph_v2::GraphRuntime;
use serde_json::{json, Value};

#[derive(Clone, Debug)]
pub struct DispatchOptions<'a> {
    pub initial_state: &'a str,
    pub input: Value,
    pub durable_facts: Value,
    pub max_steps: usize,
    pub observe: bool,
    pub graph_name: Option<String>,
}
impl<'a> DispatchOptions<'a> {
    pub fn event(
        initial_state: &'a str,
        event: &str,
        durable_facts: &Value,
        max_steps: usize,
    ) -> Self {
        Self {
            initial_state,
            input: json!({"transport":"event","id":event,"payload":{}}),
            durable_facts: durable_facts.clone(),
            max_steps,
            observe: true,
            graph_name: None,
        }
    }
}

/// Direct Node dispatcher observeDecision stage/level/message contract.
/// Use the existing native structured observer, without creating a second log stack.
pub fn observe_decision(graph_name: Option<&str>, input: &Value, decision: &Value) {
    use crate::observability::observability;
    let graph = graph_name.unwrap_or("workflow");
    let event = input
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("undefined");
    let transport = input.get("transport").cloned().unwrap_or(Value::Null);
    let source = decision.get("source").and_then(Value::as_str).unwrap_or("");
    let input = if decision["accepted"] == true {
        let target = decision["target"].as_str().unwrap_or("");
        let actions = decision["actions"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|row| row["id"].as_str())
            .collect::<Vec<_>>();
        let no_op = source == target && actions.is_empty();
        json!({"stage":"graph","event":event,"level":if no_op{"debug"}else{"info"},
            "outcome":if no_op{"noop"}else{"succeeded"},
            "message":format!("Graph {graph} accepted {}{source} -> {target}",if no_op{"no-op "}else{""}),
            "transition":{"graph":graph_name,"from":source,"to":target,"actions":actions},
            "data":{"transport":transport}})
    } else if decision["reason"] == "ambiguous" {
        json!({"stage":"graph","event":event,"level":"warn","outcome":"failed",
            "message":format!("Graph {graph} found ambiguous path from {source}"),
            "transition":{"graph":graph_name,"from":source,"to":null},
            "data":{"transport":transport,"reason":decision["reason"]}})
    } else {
        json!({"stage":"graph","event":event,"level":"debug","outcome":"noop",
            "message":format!("Graph {graph} has no transition from {source} on {event}"),
            "transition":{"graph":graph_name,"from":source,"to":null},
            "data":{"transport":transport,"reason":decision["reason"]}})
    };
    observability().record(&input);
}
/// The callback arguments mirror Node GraphDispatcherPorts, including a synchronous
/// action receipt; no callback is ever invoked before the Graph accepts a transition.
pub fn dispatch_workflow_graph_sync<P, A, E, T>(
    runtime: &GraphRuntime,
    options: &DispatchOptions<'_>,
    mut is_transient: T,
    mut persist: P,
    mut execute: A,
    mut publish: E,
) -> Result<Value, String>
where
    P: FnMut(&str, &str) -> Result<(), String>,
    A: FnMut(&str) -> Result<Value, String>,
    E: FnMut(&str, &Value) -> Result<(), String>,
    T: FnMut(&str) -> bool,
{
    let mut current = options.initial_state.to_string();
    for _ in 0..options.max_steps {
        let facts = json!({"currentState":current,"input":options.input,"durableFacts":options.durable_facts});
        let decision = runtime.evaluate_sync(&facts)?;
        if decision.get("accepted") != Some(&Value::Bool(true)) {
            if options.observe {
                observe_decision(options.graph_name.as_deref(), &options.input, &decision);
            }
            return Ok(decision);
        }
        let source = decision["source"].as_str().ok_or("missing source state")?;
        let target = decision["target"].as_str().ok_or("missing target state")?;
        persist(source, target)?;
        for step in decision["actions"].as_array().into_iter().flatten() {
            let action_id = step["id"].as_str().ok_or("missing action id")?;
            let receipt = execute(action_id)?;
            if receipt.get("ok") == Some(&Value::Bool(false)) {
                let failure = &receipt["failureEvent"];
                let event_id = failure
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("undefined");
                let definition = runtime
                    .registry
                    .events
                    .get(event_id)
                    .ok_or_else(|| format!("unknown failure event '{event_id}'"))?;
                if definition
                    .as_ref()
                    .is_some_and(|validator| !validator(&failure["payload"]))
                {
                    return Err(format!("invalid payload for failure event '{event_id}'"));
                }
                publish(event_id, &failure["payload"])?;
                if options.observe {
                    observe_decision(options.graph_name.as_deref(), &options.input, &decision);
                }
                return Ok(decision);
            }
            let payloads = receipt.get("payloads").unwrap_or(&Value::Null);
            for emitted in step["emittedEvents"].as_array().into_iter().flatten() {
                let Some(event_id) = emitted.as_str() else {
                    continue;
                };
                if payloads.get(event_id).is_none() {
                    return Err(format!("action '{action_id}' did not supply payload for emitted event '{event_id}'"));
                }
                let definition = runtime
                    .registry
                    .events
                    .get(event_id)
                    .ok_or("unknown emitted event")?;
                if definition
                    .as_ref()
                    .is_some_and(|validator| !validator(&payloads[event_id]))
                {
                    return Err(format!("invalid payload for emitted event '{event_id}'"));
                }
            }
            for emitted in step["emittedEvents"].as_array().into_iter().flatten() {
                if let Some(event_id) = emitted.as_str() {
                    publish(event_id, &payloads[event_id])?;
                }
            }
        }
        if options.observe {
            observe_decision(options.graph_name.as_deref(), &options.input, &decision);
        }
        current = target.to_string();
        if !is_transient(&current) {
            return Ok(decision);
        }
    }
    Ok(json!({"accepted":false,"source":current,"reason":"no_transition"}))
}
/// Native async Graph dispatcher: persists before effects, awaits every caller
/// callback, validates all emitted payloads and never retries a failed effect.
pub async fn dispatch_workflow_graph<P, PFut, A, AFut, E, EFut, T>(
    runtime: &GraphRuntime,
    options: &DispatchOptions<'_>,
    mut transient: T,
    mut persist: P,
    mut execute: A,
    mut publish: E,
) -> Result<Value, String>
where
    P: FnMut(String, String) -> PFut,
    PFut: std::future::Future<Output = Result<(), String>>,
    A: FnMut(String) -> AFut,
    AFut: std::future::Future<Output = Result<Value, String>>,
    E: FnMut(String, Value) -> EFut,
    EFut: std::future::Future<Output = Result<(), String>>,
    T: FnMut(&str) -> bool,
{
    let mut current = options.initial_state.to_string();
    for _ in 0..options.max_steps {
        let facts = json!({"currentState":current,"input":options.input,"durableFacts":options.durable_facts});
        let decision = runtime.evaluate(&facts).await?;
        if decision["accepted"] != true {
            if options.observe {
                observe_decision(options.graph_name.as_deref(), &options.input, &decision);
            }
            return Ok(decision);
        }
        let source = decision["source"].as_str().ok_or("missing source")?;
        let target = decision["target"].as_str().ok_or("missing target")?;
        persist(source.to_owned(), target.to_owned()).await?;
        let mut failed = false;
        for step in decision["actions"].as_array().into_iter().flatten() {
            let action_id = step["id"].as_str().ok_or("missing action id")?;
            let receipt = execute(action_id.to_owned()).await?;
            if receipt["ok"] == false {
                let failed_event = &receipt["failureEvent"];
                let event_id = failed_event["id"].as_str().unwrap_or("undefined");
                let definition = runtime
                    .registry
                    .events
                    .get(event_id)
                    .ok_or_else(|| format!("unknown failure event '{event_id}'"))?;
                if definition
                    .as_ref()
                    .is_some_and(|check| !check(&failed_event["payload"]))
                {
                    return Err(format!("invalid payload for failure event '{event_id}'"));
                }
                publish(event_id.to_owned(), failed_event["payload"].clone()).await?;
                failed = true;
                break;
            }
            let payloads = receipt.get("payloads").unwrap_or(&Value::Null);
            for emitted in step["emittedEvents"].as_array().into_iter().flatten() {
                let Some(event_id) = emitted.as_str() else {
                    continue;
                };
                let payload=payloads.get(event_id).ok_or_else(||format!("action '{action_id}' did not supply payload for emitted event '{event_id}'"))?;
                let definition = runtime
                    .registry
                    .events
                    .get(event_id)
                    .ok_or("unknown emitted event")?;
                if definition.as_ref().is_some_and(|check| !check(payload)) {
                    return Err(format!("invalid payload for emitted event '{event_id}'"));
                }
            }
            for emitted in step["emittedEvents"].as_array().into_iter().flatten() {
                if let Some(event_id) = emitted.as_str() {
                    publish(event_id.to_owned(), payloads[event_id].clone()).await?;
                }
            }
        }
        if options.observe {
            observe_decision(options.graph_name.as_deref(), &options.input, &decision);
        }
        if failed {
            return Ok(decision);
        }
        current = target.to_owned();
        if !transient(&current) {
            return Ok(decision);
        }
    }
    Ok(json!({"accepted":false,"source":current,"reason":"no_transition"}))
}
pub fn decide_workflow_graph<T>(
    runtime: &GraphRuntime,
    options: &DispatchOptions<'_>,
    transient: T,
) -> Result<Value, String>
where
    T: FnMut(&str) -> bool,
{
    dispatch_workflow_graph_sync(
        runtime,
        options,
        transient,
        |_, _| Ok(()),
        |_| Ok(json!({})),
        |_, _| Ok(()),
    )
}
pub fn dispatch_workflow_target_override<P>(
    runtime: &GraphRuntime,
    current: &str,
    target: &str,
    kind: &str,
    mut persist: P,
) -> Result<(), String>
where
    P: FnMut(&str, &str) -> Result<(), String>,
{
    super::definitions_v2::assert_v2_state_transition(&runtime.graph, current, target, kind)?;
    persist(current, target)
}
