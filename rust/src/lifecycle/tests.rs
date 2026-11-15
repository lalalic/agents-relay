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
        payload: json!({"jobId":"91","taskId":"101","executionId":claim.execution_id,
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
    let terminal_key = format!("91/101/{}/terminal", claim.execution_id);
    let mut stale = claim.clone();
    stale.attempt_key = "unreserved".into();
    let make = || TaskTransition {
        job_id: "91",
        task_id: "101",
        input: event("task.completed"),
        guard_facts: &guards,
        at: "2026-11-13T20:00:04Z",
        events: vec![WorkflowEvent {
            key: terminal_key.clone(),
            event_id: "task.completed".into(),
            payload: json!({"event_id":terminal_key,"type":"task.completed",
                "jobId":"91","taskId":"101","executionId":claim.execution_id,
                "leaseOwner":claim.owner,"attempt":claim.attempt}),
        }],
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

#[test]
fn worker_terminal_receipt_is_correlated_atomic_and_deduplicated_after_reopen() {
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
            execution_id: "terminal-exec",
            owner: "isolated",
            at: "2026-11-13T20:00:02Z",
            lease_expires_at: "2099-01-01T00:00:00Z",
        })
        .unwrap()
        .unwrap();
    let graph = graph();
    let engine = TaskLifecycle::new(&graph);
    let guards = HashMap::new();
    let identity = || {
        json!({"jobId":"91","taskId":"101","executionId":"terminal-exec",
        "leaseOwner":"isolated","attempt":1})
    };
    engine
        .apply(
            &mut store,
            TaskTransition {
                job_id: "91",
                task_id: "101",
                input: GraphInput {
                    transport: "event".into(),
                    id: "task.started".into(),
                    payload: identity(),
                },
                guard_facts: &guards,
                at: "2026-11-13T20:00:03Z",
                events: vec![],
            },
        )
        .unwrap();
    let key = "91/101/terminal-exec/terminal";
    let receipt = WorkflowEvent {
        key: key.into(),
        event_id: "task.completed".into(),
        payload: json!({"event_id":key,"type":"task.completed","jobId":"91",
            "taskId":"101","executionId":"terminal-exec","leaseOwner":"isolated",
            "attempt":1,"reason":"verified"}),
    };
    let make = |payload: Value| TaskTransition {
        job_id: "91",
        task_id: "101",
        input: GraphInput {
            transport: "event".into(),
            id: "task.completed".into(),
            payload,
        },
        guard_facts: &guards,
        at: "2026-11-13T20:00:04Z",
        events: vec![receipt.clone()],
    };
    let proof = || json!({"data":{"status":"COMPLETED","output":{"artifact":"verified"}}});
    assert!(engine
        .apply_with_launch_receipt(&mut store, make(identity()), None, &claim)
        .unwrap_err()
        .contains("requires verified structured output"));
    assert_eq!(
        store.read_job("91").unwrap().unwrap()["tasks"][0]["state"],
        "RUNNING"
    );
    let mut mismatched_job = identity();
    mismatched_job["jobId"] = json!("other-job");
    assert!(engine
        .apply_with_launch_receipt(&mut store, make(mismatched_job), Some(proof()), &claim)
        .is_err());
    assert_eq!(
        store.read_job("91").unwrap().unwrap()["tasks"][0]["state"],
        "RUNNING",
        "a terminal event for another Job must not apply the transition"
    );
    let mut mismatched = identity();
    mismatched["taskId"] = json!("other-task");
    assert!(engine
        .apply_with_launch_receipt(&mut store, make(mismatched), Some(proof()), &claim)
        .is_err());
    assert_eq!(
        store.read_job("91").unwrap().unwrap()["tasks"][0]["state"],
        "RUNNING"
    );
    let inbox_count: i64 = rusqlite::Connection::open(&path)
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM workflow_event_inbox WHERE consumer_id='rust-worker-terminal'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(inbox_count, 0, "rejected receipts must not become durable");

    let mut mismatched_receipt = receipt.clone();
    mismatched_receipt.payload["leaseOwner"] = json!("stale-owner");
    let mut bad_receipt_request = make(identity());
    bad_receipt_request.events = vec![mismatched_receipt];
    assert!(engine
        .apply_with_launch_receipt(&mut store, bad_receipt_request, Some(proof()), &claim)
        .unwrap_err()
        .contains("receipt identity mismatch"));
    assert_eq!(
        store.read_job("91").unwrap().unwrap()["tasks"][0]["state"],
        "RUNNING",
        "a receipt from another lease owner must not apply the transition"
    );
    let inbox_count: i64 = rusqlite::Connection::open(&path)
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM workflow_event_inbox WHERE consumer_id='rust-worker-terminal'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(inbox_count, 0, "mismatched receipt must not become durable");

    engine
        .apply_with_launch_receipt(&mut store, make(identity()), Some(proof()), &claim)
        .unwrap();
    assert_eq!(
        store.read_job("91").unwrap().unwrap()["tasks"][0]["state"],
        "SUCCEEDED"
    );
    drop(store);

    let mut reopened = RelayAuthority::open_existing(&path).unwrap();
    assert!(engine
        .apply_with_launch_receipt(&mut reopened, make(identity()), Some(proof()), &claim)
        .unwrap_err()
        .contains("duplicate worker terminal event"));
    let job = reopened.read_job("91").unwrap().unwrap();
    assert_eq!(job["tasks"][0]["state"], "SUCCEEDED");
    assert_eq!(
        job["tasks"][0]["result"]["data"]["output"]["artifact"],
        "verified"
    );
    let inbox_count: i64 = rusqlite::Connection::open(&path)
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM workflow_event_inbox WHERE consumer_id='rust-worker-terminal'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(inbox_count, 1);
}

#[test]
fn stale_dependency_revision_cannot_commit_worker_completion() {
    use crate::authority::ScriptClaimRequest;
    let (_dir, path) = setup();
    let mut store = RelayAuthority::open_existing(&path).unwrap();
    store.commit_job("91", "2026-11-13T20:00:01Z", |old| {
        let mut job = old.clone();
        job["updatedAt"] = json!("2026-11-13T20:00:01Z");
        job["tasks"] = json!([
            {"id":"99","jobId":"91","kind":"work","state":"SUCCEEDED","attempt":1,"dependencies":[],
                "result":{"summary":"upstream v1"},"createdAt":"2026-11-13T19:00:00Z"},
            {"id":"100","jobId":"91","kind":"work","state":"SUCCEEDED","attempt":1,"dependencies":["99"],
                "dependencyValidity":{"99":"revalidate"},"result":{"summary":"downstream original"},
                "createdAt":"2026-11-13T19:01:00Z"},
            {"id":"101","jobId":"91","kind":"work","state":"QUEUED","attempt":0,"maxAttempts":3,
                "dependencies":["99","100"],"parentTaskId":"100","adapter":"script","capabilities":["script"],
                "revision":{"kind":"revalidate","originalTaskId":"100","dependencyVector":{"99":"99:1"}},
                "leaseOwner":null,"leaseExpiresAt":null,"executionId":null,"executionHistory":[],"result":null}
        ]);
        Ok((job, vec![]))
    }).unwrap();
    let claim = store
        .claim_queued_script(&ScriptClaimRequest {
            job_id: "91",
            task_id: "101",
            execution_id: "dep-revision-exec",
            owner: "isolated",
            at: "2026-11-13T20:00:02Z",
            lease_expires_at: "2099-01-01T00:00:00Z",
        })
        .unwrap()
        .unwrap();
    let graph = graph();
    let engine = TaskLifecycle::new(&graph);
    let guards = HashMap::new();
    let identity = json!({"jobId":"91","taskId":"101","executionId":"dep-revision-exec","leaseOwner":"isolated","attempt":1});
    engine
        .apply(
            &mut store,
            TaskTransition {
                job_id: "91",
                task_id: "101",
                input: GraphInput {
                    transport: "event".into(),
                    id: "task.started".into(),
                    payload: identity.clone(),
                },
                guard_facts: &guards,
                at: "2026-11-13T20:00:02.500Z",
                events: vec![],
            },
        )
        .unwrap();
    store
        .commit_job("91", "2026-11-13T20:00:03Z", |old| {
            let mut job = old.clone();
            job["updatedAt"] = json!("2026-11-13T20:00:03Z");
            job["tasks"].as_array_mut().unwrap().push(
                json!({"id":"102","jobId":"91","kind":"work","state":"SUCCEEDED",
            "attempt":1,"dependencies":[],"revision":{"kind":"targeted","originalTaskId":"99"},
            "result":{"summary":"upstream v2"},"createdAt":"2026-11-13T19:02:00Z"}),
            );
            Ok((job, vec![]))
        })
        .unwrap();
    let key = "91/101/dep-revision-exec/terminal";
    let transition = TaskTransition {
        job_id: "91",
        task_id: "101",
        input: GraphInput {
            transport: "event".into(),
            id: "task.completed".into(),
            payload: identity,
        },
        guard_facts: &guards,
        at: "2026-11-13T20:00:04Z",
        events: vec![WorkflowEvent {
            key: key.into(),
            event_id: "task.completed".into(),
            payload: json!({"event_id":key,"type":"task.completed","jobId":"91","taskId":"101",
                "executionId":"dep-revision-exec","leaseOwner":"isolated","attempt":1}),
        }],
    };
    let result = json!({"data":{"status":"COMPLETED","output":{"verified":true}}});
    let error = engine
        .apply_with_launch_receipt(&mut store, transition, Some(result), &claim)
        .unwrap_err();
    assert!(
        error.contains("dependency revision evidence is stale"),
        "{error}"
    );
    let job = store.read_job("91").unwrap().unwrap();
    assert_eq!(
        job["tasks"][2]["state"], "RUNNING",
        "stale worker receipt cannot become SUCCEEDED"
    );
    assert_eq!(job["tasks"][2]["result"], Value::Null);
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
