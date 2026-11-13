//! Graph-authorized dispatcher. Transport adapters implement these ports;
//! this module never selects retries, schedules tasks, or persists side effects.
use crate::graph::{Decision, Graph, GraphInput};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;

pub trait ActionPorts {
    fn persist_transition(&mut self, source: &str, target: &str) -> Result<(), String>;
    fn execute_action(&mut self, action_id: &str, input: &GraphInput) -> Result<Value, String>;
    fn publish_event(&mut self, event_id: &str, payload: &Value) -> Result<(), String>;
}

#[derive(Debug, Serialize)]
pub struct DispatchResult {
    pub decision: Decision,
    pub receipts: Vec<Value>,
}
impl Graph {
    /// Equivalent to TypeScript GraphDispatcher.dispatchSync: graph decides,
    /// then persist transition, execute authorized actions, publish receipts.
    pub fn dispatch<P: ActionPorts>(
        &self,
        state: &str,
        input: GraphInput,
        guards: &HashMap<String, bool>,
        ports: &mut P,
    ) -> Result<DispatchResult, String> {
        let decision = self.decide(state, input, guards)?;
        let Decision::Accepted {
            source,
            target,
            actions,
            ..
        } = &decision
        else {
            return Ok(DispatchResult {
                decision,
                receipts: vec![],
            });
        };
        ports.persist_transition(source, target)?;
        let mut receipts = Vec::new();
        for action in actions {
            let receipt = ports.execute_action(&action.id, &action.input)?;
            receipts.push(receipt.clone());
            if receipt.get("ok") == Some(&Value::Bool(false)) {
                let failure = receipt
                    .pointer("/failureEvent/id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        format!("action '{}' returned invalid failureEvent", action.id)
                    })?;
                // The event is defined by the shared Graph, never by a new
                // set of hard-coded Rust workflow transitions.
                let defined = self.edges.iter().any(|edge| {
                    matches!(edge.kind.as_str(), "on" | "emit")
                        && edge.semantic_id.as_deref() == Some(failure)
                });
                if !defined {
                    return Err(format!("unknown failure event '{failure}'"));
                }
                ports.publish_event(failure, &receipt["failureEvent"]["payload"])?;
                return Ok(DispatchResult { decision, receipts });
            }
            for event_id in &action.emitted_events {
                let payload = receipt
                    .get("payloads")
                    .and_then(|p| p.get(event_id))
                    .ok_or_else(|| {
                        format!(
                            "action '{}' did not supply payload for emitted event '{event_id}'",
                            action.id
                        )
                    })?;
                ports.publish_event(event_id, payload)?;
            }
        }
        Ok(DispatchResult { decision, receipts })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    struct Ports {
        trace: Vec<String>,
        receipts: HashMap<String, Value>,
    }
    impl ActionPorts for Ports {
        fn persist_transition(&mut self, source: &str, target: &str) -> Result<(), String> {
            self.trace.push(format!("persist {source}->{target}"));
            Ok(())
        }
        fn execute_action(&mut self, id: &str, _input: &GraphInput) -> Result<Value, String> {
            self.trace.push(format!("action {id}"));
            Ok(self.receipts.get(id).cloned().unwrap_or(json!({})))
        }
        fn publish_event(&mut self, id: &str, _payload: &Value) -> Result<(), String> {
            self.trace.push(format!("emit {id}"));
            Ok(())
        }
    }
    fn graph() -> Graph {
        Graph::parse("flowchart LR\n%% relay: initial start\nstart[\"state: START\"]\nend[\"state: END\"]\na[\"action: mutation.do\"]\nx[\"emit: out\"]\nstart -->|on: go| a\na -->|emit: out| x\na --> end").unwrap()
    }
    fn input() -> GraphInput {
        GraphInput {
            transport: "event".into(),
            id: "go".into(),
            payload: json!({}),
        }
    }
    #[test]
    fn commit_then_action_then_emit() {
        let mut ports = Ports {
            trace: vec![],
            receipts: HashMap::from([(
                "mutation.do".into(),
                json!({"payloads":{"out":{"success":true}}}),
            )]),
        };
        let result = graph()
            .dispatch("START", input(), &HashMap::new(), &mut ports)
            .unwrap();
        assert!(matches!(result.decision, Decision::Accepted { .. }));
        assert_eq!(result.receipts.len(), 1);
        assert_eq!(
            ports.trace,
            ["persist START->END", "action mutation.do", "emit out"]
        );
    }
    #[test]
    fn missing_payload_fails_closed_after_action() {
        let mut ports = Ports {
            trace: vec![],
            receipts: HashMap::new(),
        };
        assert!(graph()
            .dispatch("START", input(), &HashMap::new(), &mut ports)
            .is_err());
        assert_eq!(ports.trace, ["persist START->END", "action mutation.do"]);
    }
    #[test]
    fn failed_receipt_publishes_failure_without_success_event() {
        let src="flowchart LR\n%% relay: initial start\nstart[\"state: START\"]\nend[\"state: END\"]\na[\"action: mutation.do\"]\nx[\"emit: out\"]\nstart -->|on: go| a\na -->|emit: out| x\na --> end\nend -->|on: failed| start";
        let graph = Graph::parse(src).unwrap();
        let mut ports = Ports {
            trace: vec![],
            receipts: HashMap::from([(
                "mutation.do".into(),
                json!({"ok":false,"failureEvent":{"id":"failed","payload":{"reason":"x"}}}),
            )]),
        };
        graph
            .dispatch("START", input(), &HashMap::new(), &mut ports)
            .unwrap();
        assert_eq!(
            ports.trace,
            ["persist START->END", "action mutation.do", "emit failed"]
        );
    }
}
