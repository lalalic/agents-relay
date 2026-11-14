//! Task Graph/SQLite lifecycle differential and rollback tests.
use super::*;
use crate::authority::tests::setup;
use serde_json::json;
fn graph() -> Graph {
    Graph::parse(include_str!("../../../workflow/task-lifecycle.mmd")).unwrap()
}
#[test]
fn launch_receipt_and_terminal_task_state_commit_or_rollback_together() {
    use crate::authority::ScriptClaimRequest;
    let (_dir, path) = setup();
    let mut store = RelayAuthority::open_existing(&path).unwrap();
    store
        .commit_job("91", "2026-11-13T20:00:01Z", |old| {
            let mut new = old.clone();
            new["updatedAt"] = json!("2026-11-13T20:00:01Z");
            let task = &mut new["tasks"][0];
            task["adapter"] = json!("script");
            task["dependencies"] = json!([]);
            task["attempt"] = json!(0);
            task["maxAttempts"] = json!(3);
            task["executionId"] = Value::Null;
            task["leaseOwner"] = Value::Null;
            Ok((new, vec![]))
        })
        .unwrap();
    let claim = store
        .claim_queued_script(&ScriptClaimRequest {
            job_id: "91",
            task_id: "101",
            execution_id: "model-claim-1",
            owner: "isolated",
            at: "2026-11-13T20:00:02Z",
            lease_expires_at: "2099-01-01T00:00:00Z",
        })
        .unwrap()
        .unwrap();
    let graph = graph();
    let engine = TaskLifecycle::new(&graph);
    let guards = HashMap::new();
    let event = |name: &str| GraphInput {
        transport: "event".into(),
        id: name.into(),
        payload: json!({"taskId":"101","executionId":claim.execution_id,
                "leaseOwner":claim.owner,"attempt":1}),
    };
    engine
        .apply(
            &mut store,
            TaskTransition {
                job_id: "91",
                task_id: "101",
                input: event("task.started"),
                guard_facts: &guards,
                at: "2026-11-13T20:00:03Z",
                events: vec![],
            },
        )
        .unwrap();
    let proof = || json!({"data":{"status":"COMPLETED","output":{"receipt":"ok"}}});
    let mut stale = claim.clone();
    stale.attempt_key = "unreserved".into();
    let make = || TaskTransition {
        job_id: "91",
        task_id: "101",
        input: event("task.completed"),
        guard_facts: &guards,
        at: "2026-11-13T20:00:04Z",
        events: vec![],
    };
    assert!(engine
        .apply_with_launch_receipt(&mut store, make(), Some(proof()), &stale)
        .is_err());
    assert_eq!(
        store.read_job("91").unwrap().unwrap()["tasks"][0]["state"],
        "RUNNING"
    );
    assert_eq!(
        store
            .action_trace(&claim.attempt_key)
            .unwrap()
            .unwrap()
            .outcome,
        crate::authority::ActionOutcome::Unknown
    );
    engine
        .apply_with_launch_receipt(&mut store, make(), Some(proof()), &claim)
        .unwrap();
    assert_eq!(
        store.read_job("91").unwrap().unwrap()["tasks"][0]["state"],
        "SUCCEEDED"
    );
    assert_eq!(
        store
            .action_trace(&claim.attempt_key)
            .unwrap()
            .unwrap()
            .outcome,
        crate::authority::ActionOutcome::Verified
    );
}

fn input(id: &str, execution_id: Option<&str>) -> GraphInput {
    let mut payload = json!({"taskId":"101"});
    if let Some(id) = execution_id {
        payload["executionId"] = json!(id);
    }
    GraphInput {
        transport: "event".into(),
        id: id.into(),
        payload,
    }
}
fn apply(
    engine: &TaskLifecycle<'_>,
    store: &mut RelayAuthority,
    input: GraphInput,
    guards: HashMap<String, bool>,
    at: &str,
) -> Result<(CommittedJob, Decision), String> {
    engine.apply(
        store,
        TaskTransition {
            job_id: "91",
            task_id: "101",
            input,
            guard_facts: &guards,
            at,
            events: vec![],
        },
    )
}
#[test]
fn structured_result_cannot_override_pause_or_expired_generation() {
    let (_dir, path) = setup();
    let mut store = RelayAuthority::open_existing(&path).unwrap();
    store
        .commit_job("91", "2026-11-13T20:00:01Z", |prior| {
            let mut next = prior.clone();
            next["updatedAt"] = json!("2026-11-13T20:00:01Z");
            let task = &mut next["tasks"][0];
            task["state"] = json!("RUNNING");
            task["executionId"] = json!("ex1");
            task["leaseOwner"] = json!("owner1");
            task["attempt"] = json!(1);
            task["leaseExpiresAt"] = json!("2026-11-13T20:00:03Z");
            task["executionHistory"] = json!([{"id":"ex1","attempt":1}]);
            next["pause"] = json!({"generation":1});
            Ok((next, vec![]))
        })
        .unwrap();
    let graph = graph();
    let engine = TaskLifecycle::new(&graph);
    let guards = HashMap::new();
    let receipt = || TaskTransition {
        job_id: "91",
        task_id: "101",
        input: GraphInput {
            transport: "event".into(),
            id: "task.completed".into(),
            payload: json!({"taskId":"101","executionId":"ex1","leaseOwner":"owner1","attempt":1}),
        },
        guard_facts: &guards,
        at: "2026-11-13T20:00:02Z",
        events: vec![],
    };
    let proof = || json!({"data":{"status":"COMPLETED","output":{"artifact":"ok"}}});
    assert!(engine
        .apply_with_result(&mut store, receipt(), Some(proof()))
        .is_err());
    assert_eq!(
        store.read_job("91").unwrap().unwrap()["tasks"][0]["state"],
        "RUNNING"
    );
    store
        .commit_job("91", "2026-11-13T20:00:02.500Z", |prior| {
            let mut next = prior.clone();
            next["updatedAt"] = json!("2026-11-13T20:00:02.500Z");
            next.as_object_mut().unwrap().remove("pause");
            Ok((next, vec![]))
        })
        .unwrap();
    let stale = TaskTransition {
        job_id: "91",
        task_id: "101",
        input: receipt().input,
        guard_facts: &guards,
        at: "2026-11-13T20:00:04Z",
        events: vec![],
    };
    assert!(engine
        .apply_with_result(&mut store, stale, Some(proof()))
        .is_err());
    assert_eq!(
        store.read_job("91").unwrap().unwrap()["tasks"][0]["state"],
        "RUNNING"
    );
}
#[test]
fn canonical_task_lifecycle_runs_through_atomic_sqlite_and_rejects_stale_completion() {
    let (_dir, path) = setup();
    let mut store = RelayAuthority::open_existing(&path).unwrap();
    store
        .commit_job("91", "2026-11-13T20:00:01Z", |job| {
            let mut next = job.clone();
            next["updatedAt"] = json!("2026-11-13T20:00:01Z");
            next["tasks"][0]["state"] = json!("DRAFT");
            Ok((next, vec![]))
        })
        .unwrap();
    let graph = graph();
    let engine = TaskLifecycle::new(&graph);
    let (released, decision) = apply(
        &engine,
        &mut store,
        input("release", None),
        HashMap::new(),
        "2026-11-13T20:00:02Z",
    )
    .unwrap();
    assert_eq!(released.job["tasks"][0]["state"], "QUEUED");
    assert!(matches!(decision,Decision::Accepted{target,..} if target=="QUEUED"));
    store
        .commit_job("91", "2026-11-13T20:00:03Z", |job| {
            let mut next = job.clone();
            next["updatedAt"] = json!("2026-11-13T20:00:03Z");
            next["tasks"][0]["executionId"] = json!("ex-1");
            next["tasks"][0]["leaseOwner"] = json!("relayd-123");
            next["tasks"][0]["attempt"] = json!(1);
            next["tasks"][0]["leaseExpiresAt"] = json!("2099-01-01T00:00:00Z");
            Ok((next, vec![]))
        })
        .unwrap();
    assert!(apply(
        &engine,
        &mut store,
        input("task.started", Some("wrong")),
        HashMap::new(),
        "2026-11-13T20:00:04Z"
    )
    .unwrap_err()
    .contains("executionId"));
    let (started, _) = apply(
        &engine,
        &mut store,
        input("task.started", Some("ex-1")),
        HashMap::new(),
        "2026-11-13T20:00:04Z",
    )
    .unwrap();
    assert_eq!(started.job["tasks"][0]["state"], "RUNNING");
    assert!(apply(
        &engine,
        &mut store,
        input("task.completed", Some("wrong")),
        HashMap::new(),
        "2026-11-13T20:00:05Z"
    )
    .is_err());
    let (finished, _) = apply(
        &engine,
        &mut store,
        input("task.completed", Some("ex-1")),
        HashMap::new(),
        "2026-11-13T20:00:05Z",
    )
    .unwrap();
    assert_eq!(finished.job["tasks"][0]["state"], "SUCCEEDED");
    assert!(apply(
        &engine,
        &mut store,
        input("task.completed", Some("ex-1")),
        HashMap::new(),
        "2026-11-13T20:00:06Z"
    )
    .is_err());
    assert_eq!(
        store.read_job("91").unwrap().unwrap()["tasks"][0]["state"],
        "SUCCEEDED"
    );
}
#[test]
fn launch_effect_is_not_implicitly_acknowledged() {
    let (_dir, path) = setup();
    let mut store = RelayAuthority::open_existing(&path).unwrap();
    let graph = graph();
    let engine = TaskLifecycle::new(&graph);
    let initial = store.read_job("91").unwrap().unwrap();
    assert!(apply(
        &engine,
        &mut store,
        input("dispatch", None),
        HashMap::from([("dispatchable".into(), true)]),
        "2026-11-13T20:00:01Z"
    )
    .unwrap_err()
    .contains("effect.launchTask"));
    assert_eq!(store.read_job("91").unwrap().unwrap(), initial);
}
