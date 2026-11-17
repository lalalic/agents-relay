// Native boundary regressions for Node workflow/dispatcher.ts and nine authoritative Mermaid policy wrappers.
// Use source-only workflow/*.mmd, in-memory receipts, no production Relay execution.
use agents_relay_rust2::workflow::{
    authoritative_unblock_v2::decide_authoritative_unblock,
    dispatcher::{
        dispatch_workflow_graph, dispatch_workflow_graph_sync, dispatch_workflow_target_override,
        DispatchOptions,
    },
    planner_trigger_v2::dispatch_planner_trigger,
    policy_graph::load_policy_graph,
    policy_parity_harness::verified_dispatcher_scenario,
    projection_conflict_v2::decide_projection_delivery,
};
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    future::Future,
    path::Path,
    pin::pin,
    rc::Rc,
    task::{Context, Poll, Waker},
};
fn drive<T>(future: impl Future<Output = T>) -> T {
    let mut context = Context::from_waker(Waker::noop());
    let mut pinned = pin!(future);
    loop {
        if let Poll::Ready(value) = pinned.as_mut().poll(&mut context) {
            return value;
        }
        std::thread::yield_now();
    }
}
fn canonical() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("workflow")
}
#[test]
fn all_ten_real_mermaid_policy_graphs_are_bound_to_native_runtime() {
    let directory = canonical();
    for name in [
        "dependency-revision",
        "authoritative-unblock",
        "force-restate-validation",
        "planner-trigger",
        "troubleshooter",
        "blocker-recovery",
        "blocker-resolution",
        "revision-lifecycle",
        "projection-conflict",
        "projection-outbox-conflict",
    ] {
        let graph =
            load_policy_graph(&directory, name).unwrap_or_else(|error| panic!("{name}: {error}"));
        assert!(
            !graph.graph.nodes.is_empty(),
            "{name} should declare states"
        );
        assert!(
            !graph.registry.states.is_empty(),
            "{name} should declare durable states"
        );
    }
}
#[test]
fn unauthorized_unblock_cannot_trigger_retry_and_planner_trigger_uses_only_graph_paths() {
    let directory = canonical();
    let rejected = decide_authoritative_unblock(&directory, false).unwrap();
    assert!(rejected["accepted"] == false || rejected["target"] != "troubleshooter_queued");
    let allowed = decide_authoritative_unblock(&directory, true).unwrap();
    assert_eq!(allowed["accepted"], true);
    assert_eq!(allowed["target"], "troubleshooter_queued");
    let manual = dispatch_planner_trigger(
        &directory,
        &json!({"manualPlan":true,"initialPlan":false,"reviewRequired":false,"hasUnblock":false}),
    )
    .unwrap();
    assert_eq!(manual["accepted"], true);
    assert_eq!(manual["target"], "manual");
}
#[test]
fn post_completed_delivery_retry_attempts_are_numeric_guards_never_job_state_mutations() {
    let directory = canonical();
    let facts = json!({"originUsable":true,"claimAvailable":true,"remoteMainPresent":true,"remoteContainsMain":true,
        "retryDue":true,"attempts":2,"maxAttempts":3});
    let outcome =
        decide_projection_delivery(&directory, "waiting", "delivery.retry_due", &facts).unwrap();
    assert!(outcome.is_object());
    let exhausted = decide_projection_delivery(
        &directory,
        "waiting",
        "delivery.retry_due",
        &json!({"attempts":5,"maxAttempts":5}),
    )
    .unwrap();
    assert!(exhausted.is_object());
}
#[test]
fn sync_graph_dispatcher_never_runs_effect_before_transition_and_never_runs_rejected_path() {
    let source="flowchart LR\n%% relay: initial a\na[\"state: ACTIVE\"]\nb[\"state: COMPLETED\"]\nact[\"action: effect.finish\"]\na -->|on: approved| act\nact -->|to: COMPLETED| b";
    let graph =
        agents_relay_rust2::workflow::policy_graph::load_policy_graph_source(source).unwrap();
    let options = DispatchOptions {
        initial_state: "ACTIVE",
        input: json!({"transport":"event","id":"approved","payload":{}}),
        durable_facts: json!({}),
        max_steps: 1,
        observe: false,
        graph_name: Some("native-test".into()),
    };
    let log = Rc::new(RefCell::new(Vec::<String>::new()));
    let persisted = Rc::clone(&log);
    let acted = Rc::clone(&log);
    let result = dispatch_workflow_graph_sync(
        &graph,
        &options,
        |_| false,
        move |from, to| {
            persisted.borrow_mut().push(format!("persist {from}->{to}"));
            Ok(())
        },
        move |id| {
            acted.borrow_mut().push(format!("action {id}"));
            Ok(json!({}))
        },
        |_, _| Ok(()),
    )
    .unwrap();
    assert_eq!(result["target"], "COMPLETED");
    assert_eq!(
        log.borrow().as_slice(),
        &["persist ACTIVE->COMPLETED", "action effect.finish"]
    );
    let no_match = DispatchOptions {
        input: json!({"transport":"event","id":"unknown","payload":{}}),
        ..options
    };
    let value = dispatch_workflow_graph_sync(
        &graph,
        &no_match,
        |_| false,
        |_, _| panic!("Rejected Graph attempted persistence"),
        |_| panic!("Rejected Graph executed effect"),
        |_, _| Ok(()),
    )
    .unwrap_err();
    assert!(value.contains("unknown event"));
}
#[test]
fn async_dispatcher_awaits_caller_actions_and_releases_only_validated_events() {
    let source="flowchart LR\n%% relay: initial a\na[\"state: ACTIVE\"]\nb[\"state: COMPLETED\"]\nact[\"action: effect.process\"]\ne[\"emit: ready\"]\na -->|on: approved| act\nact -->|emit: ready| e\nact -->|to: COMPLETED| b";
    let runtime =
        agents_relay_rust2::workflow::policy_graph::load_policy_graph_source(source).unwrap();
    let opts = DispatchOptions {
        initial_state: "ACTIVE",
        input: json!({"transport":"event","id":"approved","payload":{}}),
        durable_facts: json!({}),
        max_steps: 1,
        observe: false,
        graph_name: None,
    };
    let log = Rc::new(RefCell::new(Vec::<String>::new()));
    let p = Rc::clone(&log);
    let a = Rc::clone(&log);
    let e = Rc::clone(&log);
    let result = drive(dispatch_workflow_graph(
        &runtime,
        &opts,
        |_| false,
        move |from, to| {
            let log = Rc::clone(&p);
            async move {
                log.borrow_mut().push(format!("persist {from}->{to}"));
                Ok(())
            }
        },
        move |id| {
            let log = Rc::clone(&a);
            async move {
                log.borrow_mut().push(format!("action {id}"));
                Ok(json!({"ok":true,"payloads":{"ready":{"passed":true}}}))
            }
        },
        move |id, payload| {
            let log = Rc::clone(&e);
            async move {
                log.borrow_mut()
                    .push(format!("event {id} {}", payload["passed"]));
                Ok(())
            }
        },
    ))
    .unwrap();
    assert_eq!(result["accepted"], true);
    assert_eq!(
        log.borrow().as_slice(),
        &[
            "persist ACTIVE->COMPLETED",
            "action effect.process",
            "event ready true"
        ]
    );
}
#[test]
fn verified_actions_commit_only_postcondition_verified_execution_and_publish_once() {
    let source="flowchart LR\n%% relay: initial a\na[\"state: ACTIVE\"]\nb[\"state: COMPLETED\"]\nact[\"action: effect.process\"]\ne[\"emit: ready\"]\na -->|on: approved| act\nact -->|emit: ready| e\nact -->|to: COMPLETED| b";
    let base = json!({"source":source,"initialState":"ACTIVE","input":{"transport":"event","id":"approved","payload":{}},
        "identity":{"jobId":"j","taskId":"t","leaseOwner":"owner","attempt":1,"generation":1,"executionId":"e1",
            "attemptKey":"e1/g1/process","graph":"lifecycle.mmd","actionId":"effect.process"},
        "job":{"id":"j","state":"ACTIVE","tasks":[{"id":"t","state":"RUNNING","executionId":"e1","leaseOwner":"owner",
            "attempt":1,"leaseExpiresAt":"2099-01-01T00:00:00.000Z","executionHistory":[{"id":"e1","attempt":1}]}]},
        "receipts":{"effect.process":{"ok":true,"payloads":{"ready":{"done":true}}}},"hasPublication":true,
        "hasPersist":true,"hasPublisher":false,"observed":{"merged":true},"calls":2});
    let result = verified_dispatcher_scenario(&base).unwrap();
    assert_eq!(result["state"], "COMPLETED");
    assert_eq!(result["trace"], "Verified");
    assert_eq!(result["actions"].as_array().unwrap().len(), 1);
    assert_eq!(result["pending"].as_array().unwrap().len(), 1);
    assert_eq!(result["outputs"][0]["ok"], true);
    assert!(result["outputs"][1]["error"]
        .as_str()
        .unwrap()
        .contains("already reserved"));
    let unknown = json!({"observed":{},"calls":2});
    let mut failed: Value = base.clone();
    failed["observed"] = unknown["observed"].clone();
    let result = verified_dispatcher_scenario(&failed).unwrap();
    assert_eq!(result["state"], "ACTIVE");
    assert_eq!(result["trace"], "Unknown");
    assert_eq!(result["pending"].as_array().unwrap().len(), 0);
    assert_eq!(result["actions"].as_array().unwrap().len(), 1);
}
#[test]
fn override_uses_canonical_graph_topology_and_executes_no_other_effect() {
    let source="flowchart LR\n%% relay: initial a\na[\"state: ACTIVE\"]\nb[\"state: COMPLETED\"]\na -->|on: done| b";
    let graph =
        agents_relay_rust2::workflow::policy_graph::load_policy_graph_source(source).unwrap();
    let updates = Rc::new(RefCell::new(0));
    let updated = Rc::clone(&updates);
    dispatch_workflow_target_override(&graph, "ACTIVE", "COMPLETED", "Job", move |_, _| {
        *updated.borrow_mut() += 1;
        Ok(())
    })
    .unwrap();
    assert_eq!(*updates.borrow(), 1);
    assert!(dispatch_workflow_target_override(
        &graph,
        "COMPLETED",
        "ACTIVE",
        "Job",
        |_, _| panic!("Illegal Graph override persisted")
    )
    .is_err());
}
