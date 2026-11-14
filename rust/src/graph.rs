//! Strict parser/evaluator for the executable Mermaid subset in graph-v2.ts.
//! Graph data, not Rust code, owns transition policy. Evaluating never performs
//! an action or mutates durable state; side effects remain separate receipts.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Serialize)]
pub struct Node {
    pub id: String,
    pub kind: String,
    #[serde(rename = "semanticId")]
    pub semantic_id: String,
    pub line: usize,
}
#[derive(Debug, Clone, Serialize)]
pub struct Edge {
    pub from: String,
    pub to: String,
    pub kind: String,
    #[serde(rename = "semanticId")]
    pub semantic_id: Option<String>,
    pub line: usize,
}
#[derive(Debug, Clone, Serialize)]
pub struct Graph {
    pub direction: String,
    pub initial: String,
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphInput {
    pub transport: String,
    pub id: String,
    pub payload: Value,
}
#[derive(Debug, Clone, Serialize)]
pub struct ActionDecision {
    pub id: String,
    pub input: GraphInput,
    #[serde(rename = "emittedEvents")]
    pub emitted_events: Vec<String>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum Decision {
    Accepted {
        accepted: bool,
        source: String,
        target: String,
        actions: Vec<ActionDecision>,
    },
    Rejected {
        accepted: bool,
        source: String,
        reason: String,
    },
}
mod parser;
use parser::is_id;

impl Graph {
    fn path(
        &self,
        start: &str,
        input: &GraphInput,
        guards: &HashMap<String, bool>,
    ) -> Result<Option<(String, Vec<ActionDecision>)>, String> {
        let nodes: HashMap<_, _> = self.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
        let mut seen = HashSet::new();
        let mut current = start;
        let mut actions = Vec::new();
        loop {
            if !seen.insert(current) {
                return Err(format!("cyclic graph path at '{current}'"));
            }
            let node = nodes.get(current).ok_or("invalid path target")?;
            match node.kind.as_str() {
                "state" => return Ok(Some((node.semantic_id.clone(), actions))),
                "guard" => {
                    let value = guards
                        .get(&node.semantic_id)
                        .ok_or_else(|| format!("missing guard fact '{}'", node.semantic_id))?;
                    let kind = if *value { "true" } else { "false" };
                    if let Some(next) = self
                        .edges
                        .iter()
                        .find(|e| e.from == current && e.kind == kind)
                    {
                        current = &next.to;
                    } else {
                        return Ok(None);
                    }
                }
                "action" => {
                    actions.push(ActionDecision {
                        id: node.semantic_id.clone(),
                        input: input.clone(),
                        emitted_events: self
                            .edges
                            .iter()
                            .filter(|e| e.from == current && e.kind == "emit")
                            .filter_map(|e| e.semantic_id.clone())
                            .collect(),
                    });
                    current = &self
                        .edges
                        .iter()
                        .find(|e| {
                            e.from == current && matches!(e.kind.as_str(), "to" | "unlabelled")
                        })
                        .ok_or("missing action continuation")?
                        .to;
                }
                _ => return Err("emit node cannot be executed".into()),
            }
        }
    }

    /// Shadow CLI registry derived from canonical executable Graph declarations.
    /// Mirrors the TypeScript differential harness's auto-registered symbols.
    pub(crate) fn recognizes_event(&self, id: &str) -> bool {
        self.nodes
            .iter()
            .any(|n| n.kind == "emit" && n.semantic_id == id)
            || self.edges.iter().any(|e| {
                matches!(e.kind.as_str(), "on" | "emit") && e.semantic_id.as_deref() == Some(id)
            })
    }

    pub(crate) fn recognizes_action(&self, id: &str) -> bool {
        self.nodes
            .iter()
            .any(|n| n.kind == "action" && n.semantic_id == id)
            || self
                .edges
                .iter()
                .any(|e| e.kind == "request" && e.semantic_id.as_deref() == Some(id))
    }

    pub fn decide(
        &self,
        state: &str,
        input: GraphInput,
        guards: &HashMap<String, bool>,
    ) -> Result<Decision, String> {
        if !matches!(input.transport.as_str(), "event" | "action") || !is_id(&input.id) {
            return Err("invalid input transport/id".into());
        }
        // The shadow CLI derives its registry from the canonical Graph,
        // exactly as the TypeScript differential harness does. An event or
        // action absent from that registry is a contract error, not an
        // ordinary no-transition result.
        let registered = if input.transport == "event" {
            self.recognizes_event(&input.id)
        } else {
            self.recognizes_action(&input.id)
        };
        if !registered {
            return Err(format!("unknown {} '{}'", input.transport, input.id));
        }
        let node = self
            .nodes
            .iter()
            .find(|n| n.kind == "state" && n.semantic_id == state)
            .ok_or_else(|| format!("unknown state '{state}'"))?;
        let edge_kind = if input.transport == "event" {
            "on"
        } else {
            "request"
        };
        let mut paths = Vec::new();
        for e in &self.edges {
            if e.from == node.id
                && e.kind == edge_kind
                && e.semantic_id.as_deref() == Some(&input.id)
            {
                if let Some(result) = self.path(&e.to, &input, guards)? {
                    paths.push(result);
                }
            }
        }
        let result = match paths.len() {
            0 => Decision::Rejected {
                accepted: false,
                source: state.into(),
                reason: "no_transition".into(),
            },
            1 => {
                let (target, actions) = paths.remove(0);
                Decision::Accepted {
                    accepted: true,
                    source: state.into(),
                    target,
                    actions,
                }
            }
            _ => Decision::Rejected {
                accepted: false,
                source: state.into(),
                reason: "ambiguous".into(),
            },
        };
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn guarded_action_and_emit() {
        let src="flowchart LR\n%% relay: initial waiting\nwaiting[\"state: WAITING\"]\nok[\"state: OK\"]\nno[\"state: NO\"]\ng[\"guard: ready\"]\na[\"action: mutation.record\"]\nx[\"emit: task.done\"]\nwaiting -->|on: go| g\ng -->|true| a\ng -->|false| no\na -->|emit: task.done| x\na --> ok";
        let graph = Graph::parse(src).unwrap();
        let input = GraphInput {
            transport: "event".into(),
            id: "go".into(),
            payload: serde_json::json!({"x":1}),
        };
        let decision = graph
            .decide(
                "WAITING",
                input.clone(),
                &HashMap::from([("ready".into(), true)]),
            )
            .unwrap();
        assert_eq!(
            serde_json::to_value(decision).unwrap(),
            serde_json::json!({"accepted":true,"source":"WAITING","target":"OK","actions":[{"id":"mutation.record","input":{"transport":"event","id":"go","payload":{"x":1}},"emittedEvents":["task.done"]}]})
        );
        let rejected = graph
            .decide("WAITING", input, &HashMap::from([("ready".into(), false)]))
            .unwrap();
        assert_eq!(serde_json::to_value(rejected).unwrap()["target"], "NO");
    }
    #[test]
    fn rejects_undeclared_and_ambiguous_paths() {
        assert!(
            Graph::parse("flowchart LR\n%% relay: initial a\na[\"state: A\"]\na --> missing")
                .is_err()
        );
        assert!(Graph::parse("flowchart LR\n%% relay: initial a\na[\"state: A\"]\nb[\"state: B\"]\na -->|on: x| b\na -->|on: x| b").is_err());
    }
    #[test]
    fn unknown_input_fails_but_known_input_without_transition_is_rejected() {
        let graph = Graph::parse(
            "flowchart LR\n%% relay: initial s\ns[\"state: START\"]\ne[\"state: END\"]\ns -->|on: go| e"
        ).unwrap();
        let input = |id: &str| GraphInput {
            transport: "event".into(),
            id: id.into(),
            payload: serde_json::json!({}),
        };
        assert!(graph
            .decide("START", input("unregistered"), &HashMap::new())
            .unwrap_err()
            .contains("unknown event"));
        let output = graph.decide("END", input("go"), &HashMap::new()).unwrap();
        assert!(matches!(output,Decision::Rejected{reason,..} if reason=="no_transition"));
    }
}
