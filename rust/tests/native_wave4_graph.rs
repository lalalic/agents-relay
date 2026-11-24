// Wave4 live native mechanics: no user's SQLite, browser, or managed Relay Job.
use agents_relay_rust2::workflow::planner_orchestration_v2::{
    dispatch_planner_orchestration_async, planner_orchestration_v2,
};
use serde_json::{json, Value};
use std::{
    future::Future,
    path::Path,
    pin::pin,
    sync::mpsc,
    task::{Context, Poll, Waker},
    thread,
    time::Duration,
};
fn graph() -> &'static Path {
    Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../workflow"))
}
fn ready<T>(future: impl Future<Output = T>) -> T {
    let mut future = pin!(future);
    let mut ctx = Context::from_waker(Waker::noop());
    match future.as_mut().poll(&mut ctx) {
        Poll::Ready(value) => value,
        Poll::Pending => panic!("isolated async effect must resolve synchronously"),
    }
}
#[test]
fn planner_public_runtime_declares_all_node_exports_and_strict_boolean_guards() {
    let runtime = planner_orchestration_v2(graph()).unwrap();
    assert_eq!(runtime.registry.states.len(), 17);
    assert_eq!(runtime.registry.guards.len(), 13);
    assert_eq!(runtime.registry.actions.len(), 3);
    assert_eq!(runtime.registry.events.len(), 1);
    let guard = runtime
        .registry
        .guards
        .get("recoverablePendingPlan")
        .unwrap();
    assert!(guard(
        &json!({"durableFacts":{"recoverablePendingPlan":true}})
    ));
    assert!(!guard(
        &json!({"durableFacts":{"recoverablePendingPlan":1}})
    ));
    assert!(!guard(
        &json!({"durableFacts":{"recoverablePendingPlan":"true"}})
    ));
    assert!(!guard(&json!({"durableFacts":{}})));
}
#[test]
fn planner_async_receipt_error_is_the_original_node_dispatcher_contract() {
    let facts = json!({"legacyPlanningPending":false,"recoverablePendingPlan":true});
    let mut observed = Vec::new();
    let rejected = ready(dispatch_planner_orchestration_async(
        graph(),
        &facts,
        |action| {
            observed.push(action);
            async { Ok(json!({"ok":false})) }
        },
    ));
    assert_eq!(observed, vec!["planner.recoverPending"]);
    assert_eq!(
        rejected,
        Err("action returned failure receipt: reconciliation required".into())
    );
    let forwarded = ready(dispatch_planner_orchestration_async(
        graph(),
        &facts,
        |action| {
            assert_eq!(action, "planner.recoverPending");
            async { Err("temporary isolated callback failure".into()) }
        },
    ));
    assert_eq!(forwarded, Err("temporary isolated callback failure".into()));
}
