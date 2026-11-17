// Native Rust regression for direct Node src/router-rules.ts, src/workflow/contracts.ts and src/workflow/mermaid.ts ports.
use agents_relay_rust2::{
    router_rules::{append_agent_model_preference, append_routing_instruction, parse_router_rules},
    workflow::{
        contracts::{
            classify_workflow_actions, empty_workflow_decision, workflow_effect_failure_event,
            WORKFLOW_EFFECT_NAMES,
        },
        mermaid::{parse_executable_mermaid, WorkflowAction, WorkflowEngine, WorkflowGuard},
    },
};
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[test]
fn router_body_preserves_raw_crlf_and_dedupes_choices() {
    let src="[choices]\r\nopenai: gpt-6 high, sol medium\r\nopenai: gpt-6 high\r\n[routing-instruction]\r\n  retain\r\n\r\n";
    let parsed = parse_router_rules(src);
    assert_eq!(parsed["choices"].as_array().unwrap().len(), 2);
    assert_eq!(parsed["choices"][0]["reasoning"], "high");
    assert_eq!(parsed["routingInstruction"], "  retain\r\n\r\n");
    assert_eq!(append_routing_instruction("x", ""), "x");
    assert_eq!(append_routing_instruction("x", "route"), "x\n\nroute");
    assert!(
        append_agent_model_preference("x", Some(&json!({"model":"local"})))
            .contains("Prefer model: local")
    );
}

#[test]
fn workflow_contracts_reject_unknown_effect_and_preserve_order() {
    let ordered = vec![
        "effect.launchTask".to_string(),
        "mutation.clearLease".to_string(),
        "effect.launchTask".to_string(),
    ];
    assert_eq!(
        classify_workflow_actions(&ordered).unwrap(),
        json!({"mutations":["mutation.clearLease"],"effects":["effect.launchTask","effect.launchTask"]})
    );
    assert!(classify_workflow_actions(&["effect.nope".into()])
        .unwrap_err()
        .contains("Unknown canonical workflow action"));
    for effect in WORKFLOW_EFFECT_NAMES {
        assert!(workflow_effect_failure_event(effect)
            .unwrap()
            .ends_with(".failed"));
    }
    assert_eq!(empty_workflow_decision("no_transition")["accepted"], false);
}

fn sample_graph() -> &'static str {
    "stateDiagram-v2\n[*] --> Idle\nIdle --> Working: start [ok] / record, announce\nWorking --> Done: finish\nDone --> [*]"
}

#[test]
fn mermaid_graph_validates_duplicates_and_missing_bindings() {
    let graph = parse_executable_mermaid(sample_graph()).unwrap();
    assert_eq!(graph.initial, "Idle");
    assert_eq!(graph.states, vec!["Idle", "Working", "Done"]);
    assert_eq!(graph.finals, vec!["Done"]);
    assert_eq!(graph.transitions[0].actions, vec!["record", "announce"]);
    assert!(parse_executable_mermaid(
        "stateDiagram-v2\n[*] --> Idle\nIdle --> Work: go\nIdle --> Work: go"
    )
    .unwrap_err()
    .contains("Duplicate executable transition"));
    assert!(WorkflowEngine::new(graph, HashMap::new(), HashMap::new())
        .err()
        .unwrap()
        .contains("Unknown workflow guard"));
}

#[test]
fn mermaid_workflow_engine_is_graph_authority_with_one_guard_and_ordered_effects() {
    let graph = parse_executable_mermaid(sample_graph()).unwrap();
    let mut guards = HashMap::new();
    guards.insert(
        "ok".to_string(),
        WorkflowGuard::Sync(Arc::new(|ctx| Ok(ctx["ok"] == true))),
    );
    let trace = Arc::new(Mutex::new(Vec::<String>::new()));
    let mut actions = HashMap::new();
    for action_name in ["record", "announce"] {
        let trace = Arc::clone(&trace);
        let label = action_name.to_string();
        actions.insert(
            label.clone(),
            WorkflowAction::Sync(Arc::new(move |_, _| {
                trace.lock().unwrap().push(label.clone());
                Ok(())
            })),
        );
    }
    let engine = WorkflowEngine::new(graph, guards, actions).unwrap();
    assert_eq!(
        engine
            .enabled_sync("Idle", "start", &json!({"ok":false}))
            .unwrap()
            .len(),
        0
    );
    assert_eq!(
        engine
            .transition_sync("Idle", "start", &json!({"ok":true}))
            .unwrap(),
        "Working"
    );
    assert_eq!(trace.lock().unwrap().as_slice(), &["record", "announce"]);
    assert!(engine
        .assert_state_transition("Idle", "Done", "workflow")
        .unwrap_err()
        .contains("Invalid workflow transition"));
    assert!(engine
        .transition_sync("Idle", "start", &json!({"ok":false}))
        .unwrap_err()
        .contains("No enabled workflow transition"));
}

#[test]
fn mermaid_engine_propagates_sync_and_async_handler_failures() {
    use std::{
        future::Future,
        pin::pin,
        task::{Context, Poll, Waker},
    };
    fn run<T>(future: impl Future<Output = T>) -> T {
        let mut pinned = pin!(future);
        let mut ctx = Context::from_waker(Waker::noop());
        loop {
            if let Poll::Ready(value) = pinned.as_mut().poll(&mut ctx) {
                return value;
            }
            std::thread::yield_now();
        }
    }
    let graph = parse_executable_mermaid(sample_graph()).unwrap();
    let mut actions = HashMap::new();
    actions.insert("record".to_string(), WorkflowAction::Declarative);
    actions.insert("announce".to_string(), WorkflowAction::Declarative);
    let mut failed_guard = HashMap::new();
    failed_guard.insert(
        "ok".to_string(),
        WorkflowGuard::Sync(Arc::new(|_| Err("guard refused".into()))),
    );
    let engine = WorkflowEngine::new(graph.clone(), failed_guard, actions).unwrap();
    assert_eq!(
        engine
            .transition_sync("Idle", "start", &json!({}))
            .unwrap_err(),
        "guard refused"
    );

    let mut failed_async_guard = HashMap::new();
    failed_async_guard.insert(
        "ok".to_string(),
        WorkflowGuard::Async(Arc::new(|_| {
            Box::pin(async { Err("async guard refused".into()) })
        })),
    );
    let mut neutral_actions = HashMap::new();
    neutral_actions.insert("record".into(), WorkflowAction::Declarative);
    neutral_actions.insert("announce".into(), WorkflowAction::Declarative);
    let engine = WorkflowEngine::new(graph.clone(), failed_async_guard, neutral_actions).unwrap();
    assert_eq!(
        run(engine.transition("Idle", "start", &json!({}))).unwrap_err(),
        "async guard refused"
    );

    let mut allowed = HashMap::new();
    allowed.insert("ok".into(), WorkflowGuard::Sync(Arc::new(|_| Ok(true))));
    let mut failed_action = HashMap::new();
    failed_action.insert(
        "record".into(),
        WorkflowAction::Sync(Arc::new(|_, _| Err("action refused".into()))),
    );
    failed_action.insert("announce".into(), WorkflowAction::Declarative);
    let engine = WorkflowEngine::new(graph.clone(), allowed, failed_action).unwrap();
    assert_eq!(
        engine
            .transition_sync("Idle", "start", &json!({}))
            .unwrap_err(),
        "action refused"
    );

    let mut allowed = HashMap::new();
    allowed.insert("ok".into(), WorkflowGuard::Sync(Arc::new(|_| Ok(true))));
    let mut failed_async_action = HashMap::new();
    failed_async_action.insert(
        "record".into(),
        WorkflowAction::Async(Arc::new(|_, _| {
            Box::pin(async { Err("async action refused".into()) })
        })),
    );
    failed_async_action.insert("announce".into(), WorkflowAction::Declarative);
    let engine = WorkflowEngine::new(graph, allowed, failed_async_action).unwrap();
    assert_eq!(
        run(engine.transition("Idle", "start", &json!({}))).unwrap_err(),
        "async action refused"
    );
}
