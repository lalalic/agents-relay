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
            // ActionReceipt is a typed object in GraphDispatcher's contract.
            // Null/arrays/scalars must not silently become a successful
            // action merely because this step emits no follow-up events.
            if !receipt.is_object() {
                return Err(format!(
                    "action '{}' returned invalid ActionReceipt",
                    action.id
                ));
            }
            if receipt.get("ok").is_some_and(|value| !value.is_boolean()) {
                return Err(format!("action '{}' returned invalid ok flag", action.id));
            }
            if receipt
                .get("payloads")
                .is_some_and(|value| !value.is_object())
            {
                return Err(format!("action '{}' returned invalid payloads", action.id));
            }
            receipts.push(receipt.clone());
            if receipt.get("ok") == Some(&Value::Bool(false)) {
                let failure = receipt
                    .pointer("/failureEvent/id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        format!("action '{}' returned invalid failureEvent", action.id)
                    })?;
                // The Event registry includes all declared emit nodes, even
                // unused ones, as well as on:/emit: edges. Share the exact
                // same registration logic with the decision evaluator.
                let defined = self.recognizes_event(failure);
                if !defined {
                    return Err(format!("unknown failure event '{failure}'"));
                }
                let payload = receipt.pointer("/failureEvent/payload").ok_or_else(|| {
                    format!(
                        "action '{}' returned missing failureEvent payload",
                        action.id
                    )
                })?;
                ports.publish_event(failure, payload)?;
                return Ok(DispatchResult { decision, receipts });
            }
            // TypeScript validates *every* emitted payload before publishing
            // any event from this action. Publishing incrementally here would
            // make a later missing payload leave partially published events.
            let payloads = action
                .emitted_events
                .iter()
                .map(|event_id| {
                    receipt
                        .get("payloads")
                        .and_then(|p| p.get(event_id))
                        .map(|payload| (event_id, payload))
                        .ok_or_else(|| {
                            format!(
                                "action '{}' did not supply payload for emitted event '{event_id}'",
                                action.id
                            )
                        })
                })
                .collect::<Result<Vec<_>, String>>()?;
            for (event_id, payload) in payloads {
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
    #[test]
    fn missing_later_payload_does_not_publish_earlier_event() {
        let source = r#"flowchart LR
%% relay: initial start
start["state: START"]
end["state: END"]
a["action: mutation.do"]
one["emit: first"]
two["emit: second"]
start -->|on: go| a
a -->|emit: first| one
a -->|emit: second| two
a --> end"#;
        let graph = Graph::parse(source).unwrap();
        let mut ports = Ports {
            trace: vec![],
            receipts: HashMap::from([(
                "mutation.do".into(),
                json!({"payloads": {"first": {"value": 1}}}),
            )]),
        };
        assert!(graph
            .dispatch("START", input(), &HashMap::new(), &mut ports)
            .is_err());
        assert_eq!(ports.trace, ["persist START->END", "action mutation.do"]);

        ports.trace.clear();
        ports.receipts.insert(
            "mutation.do".into(),
            json!({
                "payloads": {"first":{"value":1}, "second":{"value":2}}
            }),
        );
        graph
            .dispatch("START", input(), &HashMap::new(), &mut ports)
            .unwrap();
        assert_eq!(
            ports.trace,
            [
                "persist START->END",
                "action mutation.do",
                "emit first",
                "emit second"
            ]
        );
    }
    #[test]
    fn malformed_receipts_fail_closed_without_false_success() {
        let mut ports = Ports {
            trace: vec![],
            receipts: HashMap::from([("mutation.do".into(), json!(null))]),
        };
        let error = graph()
            .dispatch("START", input(), &HashMap::new(), &mut ports)
            .unwrap_err();
        assert!(error.contains("invalid ActionReceipt"));
        assert_eq!(ports.trace, ["persist START->END", "action mutation.do"]);

        ports.trace.clear();
        ports
            .receipts
            .insert("mutation.do".into(), json!({"ok": "false"}));
        assert!(graph()
            .dispatch("START", input(), &HashMap::new(), &mut ports)
            .unwrap_err()
            .contains("invalid ok flag"));
        assert_eq!(ports.trace, ["persist START->END", "action mutation.do"]);

        ports.trace.clear();
        ports
            .receipts
            .insert("mutation.do".into(), json!({"payloads": 123}));
        assert!(graph()
            .dispatch("START", input(), &HashMap::new(), &mut ports)
            .unwrap_err()
            .contains("invalid payloads"));
        assert_eq!(ports.trace, ["persist START->END", "action mutation.do"]);
    }

    #[test]
    fn failure_receipt_requires_explicit_payload() {
        let source = r#"flowchart LR
%% relay: initial start
start["state: START"]
end["state: END"]
a["action: mutation.do"]
start -->|on: go| a
a --> end"#;
        let graph = Graph::parse(source).unwrap();
        let mut ports = Ports {
            trace: vec![],
            receipts: HashMap::from([(
                "mutation.do".into(),
                json!({"ok":false,"failureEvent":{"id":"go"}}),
            )]),
        };
        assert!(graph
            .dispatch("START", input(), &HashMap::new(), &mut ports)
            .unwrap_err()
            .contains("missing failureEvent payload"));
        assert_eq!(ports.trace, ["persist START->END", "action mutation.do"]);
        ports.trace.clear();
        ports.receipts.insert(
            "mutation.do".into(),
            json!({"ok":false,"failureEvent":{"id":"go","payload":null}}),
        );
        graph
            .dispatch("START", input(), &HashMap::new(), &mut ports)
            .unwrap();
        assert_eq!(
            ports.trace,
            ["persist START->END", "action mutation.do", "emit go"]
        );
    }
}
