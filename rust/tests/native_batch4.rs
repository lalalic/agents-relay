// New Rust-native Batch 4 regression coverage: Graph condition callbacks, UTF-16 wire fidelity, worker regex and DAG guards.
use agents_relay_rust2::{
    planner_task_context::planner_task_context_json_wire,
    worker_rejection::classify_worker_rejection,
    workflow::conditions::{
        boolean_condition, verify_action_effect, ConditionCheck, ConditionRegistry, ConditionSpec,
    },
};
use serde_json::json;
use std::sync::Arc;

#[test]
fn matches_mixed_separator_worker_errors() {
    assert_eq!(
        classify_worker_rejection("quota-exceeded"),
        "rate_limit_exceeded"
    );
    assert_eq!(
        classify_worker_rejection("model not_found"),
        "model_not_found"
    );
    assert_eq!(
        classify_worker_rejection("provider is refused"),
        "provider_unavailable"
    );
    assert_eq!(
        classify_worker_rejection("not an actual worker rejection"),
        "worker_process_failed"
    );
}

#[test]
fn bounded_planner_context_wire_preserves_high_surrogate() {
    let task = json!({"id":"one","state":"QUEUED","input":format!("a{}", "😀".repeat(2000))});
    let wire = planner_task_context_json_wire(&task);
    assert!(wire.contains("\\ud83d\\n...[truncated 1 chars]"));
    assert!(!wire.contains('�'));
}

#[test]
fn graph_condition_registry_supports_independent_custom_callbacks() {
    let custom: ConditionCheck = Arc::new(|facts| {
        if facts["evidence"]["sha"] == "verified" {
            "Verified"
        } else {
            "Failed"
        }
    });
    let custom_specs = vec![ConditionSpec {
        id: "receipt".into(),
        check: custom,
    }];
    let registry = ConditionRegistry::new_custom(custom_specs).unwrap();
    assert_eq!(registry.discover(), vec!["receipt"]);
    let accepted = json!({"evidence":{"sha":"verified"}});
    assert_eq!(registry.check("receipt", &accepted).unwrap(), "Verified");
    assert!(registry.guard("receipt", &accepted).unwrap());
    assert!(!registry.guard("receipt", &json!({})).unwrap());
    let effect = verify_action_effect(&registry, "merge", "receipt", &accepted).unwrap();
    assert_eq!(effect["outcome"], "Verified");
    assert!(registry.inspect_custom_check("receipt").unwrap().is_some());
    assert!(registry.inspect_custom_check("missing").is_err());
    assert!(ConditionRegistry::new_custom(vec![
        ConditionSpec {
            id: "duplicate".into(),
            check: Arc::new(|_| "Verified")
        },
        ConditionSpec {
            id: "duplicate".into(),
            check: Arc::new(|_| "Failed")
        },
    ])
    .is_err());
}

#[test]
fn boolean_conditions_still_use_strict_tristate() {
    let registry = ConditionRegistry::new(vec![boolean_condition("ready")]).unwrap();
    assert_eq!(
        registry.check("ready", &json!({"ready":true})).unwrap(),
        "Verified"
    );
    assert_eq!(
        registry.check("ready", &json!({"ready":false})).unwrap(),
        "Failed"
    );
    assert_eq!(
        registry.check("ready", &json!({"ready":"true"})).unwrap(),
        "Unknown"
    );
}
