// Direct port of Node src/workflow/graph-v2.ts: executable Graph registry, runtime and dispatcher; grammar/topology stays in graph_v2_parser.
pub use super::graph_v2_parser::{Graph, GraphEdge, GraphNode};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
// Public exports mirror the three Node parser/runtime entry points; source
// grammar and topology stay in the companion parser, never a second policy.
pub fn parse_graph_v2(source: &str) -> Result<Graph, String> {
    super::graph_v2_parser::parse_graph_v2(source)
}
pub fn parse_executable_graph(source: &str) -> Result<Graph, String> {
    parse_graph_v2(source)
}
pub fn load_graph_v2(source: &str, registry: GraphRegistry) -> Result<GraphRuntime, String> {
    GraphRuntime::new(source, registry)
}
pub type Guard = Arc<dyn Fn(&Value) -> bool + Send + Sync>;
pub type Validator = Arc<dyn Fn(&Value) -> bool + Send + Sync>;
pub type ActionExecute = Arc<dyn Fn(&Value) -> Result<Value, String> + Send + Sync>;
#[derive(Default)]
pub struct GraphRegistry {
    pub states: HashSet<String>,
    pub guards: HashMap<String, Guard>,
    pub actions: HashMap<String, (Option<Validator>, Option<ActionExecute>)>,
    pub events: HashMap<String, Option<Validator>>,
}
pub struct GraphRuntime {
    pub graph: Graph,
    pub registry: GraphRegistry,
}
impl GraphRuntime {
    pub fn new(source: &str, registry: GraphRegistry) -> Result<Self, String> {
        let graph = parse_graph_v2(source)?;
        for node in &graph.nodes {
            let found = match node.kind.as_str() {
                "state" => registry.states.contains(&node.semantic_id),
                "guard" => registry.guards.contains_key(&node.semantic_id),
                "action" => registry.actions.contains_key(&node.semantic_id),
                "emit" => registry.events.contains_key(&node.semantic_id),
                _ => false,
            };
            if !found {
                return Err(format!(
                    "unknown {} '{}'",
                    if node.kind == "emit" {
                        "emitted event"
                    } else {
                        &node.kind
                    },
                    node.semantic_id
                ));
            }
        }
        for edge in &graph.edges {
            let Some(id) = edge.semantic_id.as_deref() else {
                continue;
            };
            if matches!(edge.kind.as_str(), "on" | "emit") && !registry.events.contains_key(id) {
                return Err(format!("unknown event '{id}'"));
            }
            if edge.kind == "request" && !registry.actions.contains_key(id) {
                return Err(format!("unknown action '{id}'"));
            }
        }
        Ok(Self { graph, registry })
    }
    fn path_from(
        &self,
        start: &str,
        facts: &Value,
    ) -> Result<Option<(String, Vec<Value>)>, String> {
        let mut current = start.to_owned();
        let mut visited = HashSet::new();
        let mut actions = Vec::new();
        loop {
            if !visited.insert(current.clone()) {
                return Err(format!("cyclic graph path at '{current}'"));
            }
            let node = self
                .graph
                .node(&current)
                .ok_or_else(|| format!("unbound Graph node '{current}'"))?;
            match node.kind.as_str() {
                "state" => return Ok(Some((node.semantic_id.clone(), actions))),
                "guard" => {
                    let guard = self
                        .registry
                        .guards
                        .get(&node.semantic_id)
                        .ok_or("guard not registered")?;
                    let branch = if guard(facts) { "true" } else { "false" };
                    let Some(next) = self
                        .graph
                        .edges
                        .iter()
                        .find(|edge| edge.from == node.id && edge.kind == branch)
                    else {
                        return Ok(None);
                    };
                    current = next.to.clone();
                }
                "action" => {
                    let emitted_events = self
                        .graph
                        .edges
                        .iter()
                        .filter(|edge| edge.from == node.id && edge.kind == "emit")
                        .filter_map(|edge| edge.semantic_id.clone())
                        .collect::<Vec<_>>();
                    actions.push(json!({"id":node.semantic_id,"input":facts["input"],"emittedEvents":emitted_events}));
                    let next = self
                        .graph
                        .edges
                        .iter()
                        .find(|edge| {
                            edge.from == node.id
                                && matches!(edge.kind.as_str(), "to" | "unlabelled")
                        })
                        .ok_or("missing action continuation")?;
                    current = next.to.clone();
                }
                "emit" => {
                    return Err(format!(
                        "invalid executable path through emit node '{}'",
                        node.semantic_id
                    ))
                }
                _ => return Err("unknown Graph node kind".into()),
            }
        }
    }
    pub fn evaluate_sync(&self, facts: &Value) -> Result<Value, String> {
        let input = &facts["input"];
        let transport = input.get("transport").and_then(Value::as_str).unwrap_or("");
        let id = input.get("id").and_then(Value::as_str).unwrap_or("");
        let validator = if transport == "event" {
            self.registry
                .events
                .get(id)
                .ok_or_else(|| format!("unknown {transport} '{id}'"))?
                .as_ref()
        } else {
            self.registry
                .actions
                .get(id)
                .ok_or_else(|| format!("unknown {transport} '{id}'"))?
                .0
                .as_ref()
        };
        if validator.is_some_and(|validator| !validator(&input["payload"])) {
            return Err(format!("invalid payload for {transport} '{id}'"));
        }
        let current = facts
            .get("currentState")
            .and_then(Value::as_str)
            .unwrap_or("");
        let source = self
            .graph
            .nodes
            .iter()
            .find(|node| node.kind == "state" && node.semantic_id == current)
            .ok_or_else(|| format!("unknown state '{current}'"))?;
        let kind = if transport == "event" {
            "on"
        } else {
            "request"
        };
        let mut results = Vec::new();
        for edge in self.graph.edges.iter().filter(|edge| {
            edge.from == source.id && edge.kind == kind && edge.semantic_id.as_deref() == Some(id)
        }) {
            if let Some(result) = self.path_from(&edge.to, facts)? {
                results.push(result);
            }
        }
        if results.is_empty() {
            return Ok(json!({"accepted":false,"source":current,"reason":"no_transition"}));
        }
        if results.len() > 1 {
            return Ok(json!({"accepted":false,"source":current,"reason":"ambiguous"}));
        }
        let (target, actions) = results.pop().expect("nonempty results");
        Ok(json!({"accepted":true,"source":current,"target":target,"actions":actions}))
    }
    pub async fn evaluate(&self, facts: &Value) -> Result<Value, String> {
        self.evaluate_sync(facts)
    }
}
pub struct GraphDispatcher<'a> {
    pub runtime: &'a GraphRuntime,
}
impl GraphDispatcher<'_> {
    pub fn dispatch_sync<P, E>(
        &self,
        facts: &Value,
        mut persist: P,
        mut publish: E,
    ) -> Result<Value, String>
    where
        P: FnMut(&Value) -> Result<(), String>,
        E: FnMut(&Value) -> Result<(), String>,
    {
        let decision = self.runtime.evaluate_sync(facts)?;
        let mut receipts = Vec::new();
        if decision.get("accepted") == Some(&Value::Bool(false)) {
            return Ok(json!({"decision":decision,"receipts":receipts}));
        }
        persist(&json!({"source":decision["source"],"target":decision["target"]}))?;
        for step in decision["actions"].as_array().into_iter().flatten() {
            let name = step["id"].as_str().unwrap_or("");
            let (_, execute) = self
                .runtime
                .registry
                .actions
                .get(name)
                .ok_or("unknown registered action")?;
            let context = json!({"facts":facts,"actionId":name,"input":step["input"]});
            let receipt = if let Some(execute) = execute {
                execute(&context)?
            } else {
                json!({})
            };
            receipts.push(receipt.clone());
            if receipt.get("ok") == Some(&Value::Bool(false)) {
                let failed = &receipt["failureEvent"];
                let id = failed["id"].as_str().unwrap_or("");
                let validator = self
                    .runtime
                    .registry
                    .events
                    .get(id)
                    .ok_or_else(|| format!("unknown failure event '{id}'"))?;
                if validator
                    .as_ref()
                    .is_some_and(|validator| !validator(&failed["payload"]))
                {
                    return Err(format!("invalid payload for failure event '{id}'"));
                }
                publish(failed)?;
                return Ok(json!({"decision":decision,"receipts":receipts}));
            }
            let payloads = &receipt["payloads"];
            for emitted in step["emittedEvents"].as_array().into_iter().flatten() {
                let Some(id) = emitted.as_str() else { continue };
                let value = payloads.get(id).ok_or_else(|| {
                    format!("action '{name}' did not supply payload for emitted event '{id}'")
                })?;
                let validator = self
                    .runtime
                    .registry
                    .events
                    .get(id)
                    .ok_or("unknown emitted event")?;
                if validator
                    .as_ref()
                    .is_some_and(|validator| !validator(value))
                {
                    return Err(format!("invalid payload for emitted event '{id}'"));
                }
            }
            for emitted in step["emittedEvents"].as_array().into_iter().flatten() {
                if let Some(id) = emitted.as_str() {
                    publish(&json!({"id":id,"payload":payloads[id]}))?;
                }
            }
        }
        Ok(json!({"decision":decision,"receipts":receipts}))
    }
}
