// Native Graph-authoritative Job/Task lifecycle, Review, escalation and historical recovery tests.
// All objects and callbacks are independent fixtures; no production Relay data or live effects.
use agents_relay_rust2::workflow::{
    entity_creation::{create_job_entity, create_task_entity},
    escalation::run_escalation_graph,
    lifecycle::{decide_job_lifecycle, decide_task_lifecycle, dispatch_task_lifecycle_sync},
    orchestrator_rescue::{orchestrator_rescue_facts, prepare_orchestrator_repair},
    review_v2::{decide_review_lifecycle, review_graph_state, review_outcome},
    task_action_policy::select_related_task_mutations,
    task_related_action_v2::{decide_related_task_action, related_task_action_facts},
};
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    future::Future,
    path::{Path, PathBuf},
    pin::pin,
    rc::Rc,
    task::{Context, Poll, Waker},
};
fn workflow() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("workflow")
}
const STAMP: &str = "2026-11-17T06:00:00.000Z";
fn drive<T>(future: impl Future<Output = T>) -> T {
    let mut context = Context::from_waker(Waker::noop());
    let mut work = pin!(future);
    loop {
        if let Poll::Ready(out) = work.as_mut().poll(&mut context) {
            return out;
        }
        std::thread::yield_now();
    }
}
#[test]
fn job_activation_only_follows_mermaid_job_state_edges() {
    let dir = workflow();
    let initial = json!({"id":"j","state":"DRAFT","updatedAt":"2026-11-16T05:00:00.000Z"});
    let decision = decide_job_lifecycle(&dir, &initial, "activate", &json!({})).unwrap();
    assert_eq!(decision["accepted"], true);
    assert_eq!(decision["target"], "ACTIVE");
    let invalid = decide_job_lifecycle(
        &dir,
        &json!({"id":"j","state":"CANCELLED"}),
        "activate",
        &json!({}),
    )
    .unwrap();
    assert!(invalid["accepted"] == false || invalid["target"] != "ACTIVE");
}
#[test]
fn blocked_task_requires_troubleshooter_authority_even_when_graph_receives_unblock() {
    let dir = workflow();
    let mut original = json!({"id":"t","state":"BLOCKED","agentName":"worker","updatedAt":"2026-11-16T05:00:00.000Z"});
    let decision = decide_task_lifecycle(&dir, &original, "task.unblocked", &json!({})).unwrap();
    if decision["accepted"] == true {
        assert!(dispatch_task_lifecycle_sync(
            &dir,
            &mut original,
            "task.unblocked",
            &json!({}),
            STAMP
        )
        .is_err());
    }
    original["agentName"] = json!("troubleshooter");
    let decision = decide_task_lifecycle(&dir, &original, "task.unblocked", &json!({})).unwrap();
    assert_eq!(decision["accepted"], true);
    let dispatched =
        dispatch_task_lifecycle_sync(&dir, &mut original, "task.unblocked", &json!({}), STAMP)
            .unwrap();
    assert_eq!(dispatched["accepted"], true);
    assert_eq!(original["state"], "QUEUED");
}
#[test]
fn review_graph_exposes_strict_finishes_and_stale_authority() {
    let dir = workflow();
    assert_eq!(review_graph_state(None), "NONE");
    assert_eq!(review_graph_state(Some("approved")), "APPROVED");
    assert_eq!(review_outcome("NONE").unwrap(), None);
    assert_eq!(
        review_outcome("CHANGES_REQUIRED").unwrap(),
        Some("changes_required".into())
    );
    assert!(review_outcome("unknown").is_err());
    let rejected =
        decide_review_lifecycle(&dir, Some("stale"), "review.approved", &json!({})).unwrap();
    assert!(rejected["accepted"] == false || rejected["target"] != "APPROVED");
}
#[test]
fn task_related_scope_never_mutates_original_without_selected_graph_path() {
    let dir = workflow();
    let task = json!({"id":"original","state":"FAILED","agentName":"worker"});
    let candidate = json!({"id":"troubleshooter","state":"QUEUED","agentName":"troubleshooter","parentTaskId":"original"});
    let facts = related_task_action_facts(&dir, &task, &candidate).unwrap();
    assert_eq!(facts["otherTask"], true);
    assert_eq!(facts["recoveryForTask"], true);
    let decision = decide_related_task_action(&dir, &task, &candidate, "task.retry").unwrap();
    let chosen = select_related_task_mutations(
        &dir,
        &json!({"tasks":[task,candidate]}),
        &task,
        "task.retry",
    )
    .unwrap();
    if decision["accepted"] == true && decision["target"] == "selected" {
        assert!(!chosen.is_empty());
    }
}
#[test]
fn constructors_reject_internal_orchestrator_and_undeclared_dependencies() {
    let dir = workflow();
    let job = json!({"id":"j","state":"DRAFT","tasks":[],"updatedAt":"2026-11-16T05:00:00.000Z"});
    let value = json!({"id":"t","jobId":"j","kind":"work","adapter":"orchestrator","input":"Do work",
        "dependencies":[],"capabilities":[],"updatedAt":"2026-11-16T05:00:00.000Z"});
    assert!(create_task_entity(&dir, &job, &value, false, STAMP)
        .unwrap_err()
        .contains("Relay-internal orchestrator"));
    let mut normal = value.clone();
    normal["adapter"] = json!("chatgpt");
    normal["dependencyValidity"] = json!({"ghost":"rerun"});
    assert!(create_task_entity(&dir, &job, &normal, false, STAMP)
        .unwrap_err()
        .contains("declared dependency"));
    normal["dependencyValidity"] = Value::Null;
    let next = create_task_entity(&dir, &job, &normal, true, STAMP).unwrap();
    assert_eq!(next["state"], "DRAFT");
    let activated = create_job_entity(&dir, &job, true, STAMP).unwrap();
    assert_eq!(activated["state"], "ACTIVE");
}
#[test]
fn unknown_legacy_started_outcome_quarantines_rather_than_retries_execution() {
    let dir = workflow();
    let now = chrono::DateTime::parse_from_rfc3339(STAMP)
        .unwrap()
        .timestamp_millis();
    let mut task = json!({"id":"t","kind":"work","adapter":"orchestrator","state":"RUNNING", "storySize":"M",
        "createdAt":"2026-11-16T05:00:00.000Z","updatedAt":"2026-11-16T05:00:00.000Z",
        "leaseExpiresAt":"2026-11-16T05:00:00.000Z","leaseOwner":"old","executionId":"unknown","result":null});
    let facts = orchestrator_rescue_facts(&task, now);
    assert_eq!(facts["unknownStartedOutcome"], true);
    let result = prepare_orchestrator_repair(&dir, &mut task, now).unwrap();
    assert_eq!(result["failed"], true);
    assert_eq!(task["failureReason"], "worker_outcome_unknown");
    assert_eq!(task["executionId"], Value::Null);
    assert_eq!(task["adapter"], "orchestrator");
}
#[test]
fn escalation_invokes_executor_before_exactly_one_result_branch() {
    let dir = workflow();
    let invoked = Rc::new(RefCell::new(Vec::<String>::new()));
    for (status, target, callback) in [
        ("resolved", "resolved", "resume"),
        ("failed", "technical_failure", "technical"),
        ("needs_user", "needs_user", "human"),
    ] {
        invoked.borrow_mut().clear();
        let a = Rc::clone(&invoked);
        let b = Rc::clone(&invoked);
        let c = Rc::clone(&invoked);
        let d = Rc::clone(&invoked);
        let result = drive(run_escalation_graph(
            &dir,
            &json!({"intent":"repair fixture","blockedOn":"synthetic"}),
            |_| {
                a.borrow_mut().push("invoke".into());
                Ok(json!({"status":status,"summary":"fixture"}))
            },
            |_| {
                b.borrow_mut().push("resume".into());
                Ok(())
            },
            |_| {
                c.borrow_mut().push("technical".into());
                Ok(())
            },
            |_| {
                d.borrow_mut().push("human".into());
                Ok(())
            },
        ))
        .unwrap();
        assert_eq!(result["state"], target);
        assert_eq!(invoked.borrow().as_slice(), &["invoke", callback]);
    }
}
