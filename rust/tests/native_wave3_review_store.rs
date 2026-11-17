//! Wave3 Worker B: read and write only private SQLite in-memory job snapshots.
//! Tests actual transaction commit/rollback, reviewer actor fences, and
//! cancellation delivery after commit without accessing any live store.
use agents_relay_rust2::{
    relay_workflow_operations::SQLiteWorkflowOperations,
    review_revision_execution::reconcile_review_revisions,
    review_revision_settlement::settle_review_revision_round_atomic,
    review_revision_stale::stale_review_revisions_atomic, reviewer_thread::record_thread_delivery,
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::path::PathBuf;

fn graph() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("repo root")
        .join("workflow")
}
fn database(tasks: Vec<Value>, review: Value, requests: Vec<Value>) -> Connection {
    let db = Connection::open_in_memory().expect("in-memory SQLite");
    db.execute_batch("CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL);")
        .unwrap();
    let job = json!({"id":"1","repository":"disposable","projectRoot":"/tmp/isolated-fixture",
        "state":"ACTIVE","tasks":tasks,"review":review,"reviewRevisionRequests":requests,
        "plans":[],"updatedAt":"2026-11-17T01:00:00.000Z"});
    db.execute(
        "INSERT INTO job_snapshot VALUES ('1',?1)",
        params![job.to_string()],
    )
    .unwrap();
    db
}
fn snapshot(db: &Connection) -> Value {
    serde_json::from_str(
        &db.query_row(
            "SELECT json FROM job_snapshot WHERE job_id='1'",
            [],
            |row| row.get::<_, String>(0),
        )
        .unwrap(),
    )
    .unwrap()
}
type FixtureWriter<'a> = Box<dyn FnMut(&Value, &str) -> Result<(), String> + 'a>;
type FixtureStore<'a> =
    SQLiteWorkflowOperations<'a, FixtureWriter<'a>, fn(&Value, &str) -> Result<(), String>>;
fn store(db: &Connection) -> FixtureStore<'_> {
    SQLiteWorkflowOperations {
        db,
        write: Box::new(move |job, _| {
            db.execute(
                "UPDATE job_snapshot SET json=?1 WHERE job_id=?2",
                params![job.to_string(), job["id"].as_str().unwrap_or("")],
            )
            .map(|_| ())
            .map_err(|error| error.to_string())
        }),
        enqueue: None,
    }
}
#[test]
fn reviewer_receipt_requires_exact_running_execution_and_request() {
    let tasks = vec![json!({"id":"10","state":"RUNNING","executionId":"e1",
        "chatgptThreadDelivery":{"requestId":"r1","threadId":"x","deliveredAt":null}})];
    let db = database(tasks, json!(null), vec![]);
    let worker =
        json!({"chatgptThreadDelivery":{"requestId":"r1","threadId":"x","deliveredAt":null}});
    let mut ops = store(&db);
    assert!(!record_thread_delivery(&mut ops, "1", "10", "wrong", &worker).unwrap());
    assert!(snapshot(&db)["tasks"][0]["chatgptThreadDelivery"]["deliveredAt"].is_null());
    assert!(record_thread_delivery(&mut ops, "1", "10", "e1", &worker).unwrap());
    let delivered = snapshot(&db)["tasks"][0]["chatgptThreadDelivery"].clone();
    assert_eq!(delivered["executionId"], "e1");
    assert!(delivered["deliveredAt"].as_str().is_some());
    assert!(!record_thread_delivery(&mut ops, "1", "10", "e1", &worker).unwrap());
    assert_eq!(
        snapshot(&db)["tasks"][0]["chatgptThreadDelivery"],
        delivered
    );
    let old = json!({"chatgptThreadDelivery":{"requestId":"r0","deliveredAt":null}});
    assert!(!record_thread_delivery(&mut ops, "1", "10", "e1", &old).unwrap());
    let stale =
        json!({"chatgptThreadDelivery":{"requestId":"r1","executionId":"e0","deliveredAt":null}});
    assert!(!record_thread_delivery(&mut ops, "1", "10", "e1", &stale).unwrap());
}
#[test]
fn reviewer_receipt_database_write_failure_rolls_back() {
    let tasks = vec![json!({"id":"10","state":"RUNNING","executionId":"e1",
        "chatgptThreadDelivery":{"requestId":"r1","deliveredAt":null}})];
    let db = database(tasks, json!(null), vec![]);
    let original = snapshot(&db);
    let mut ops = SQLiteWorkflowOperations {
        db: &db,
        write: |_job: &Value, _at: &str| Err("test-only failure during SQLite mutation".into()),
        enqueue: None::<fn(&Value, &str) -> Result<(), String>>,
    };
    let worker = json!({"chatgptThreadDelivery":{"requestId":"r1","deliveredAt":null}});
    assert_eq!(
        record_thread_delivery(&mut ops, "1", "10", "e1", &worker).unwrap_err(),
        "test-only failure during SQLite mutation"
    );
    assert_eq!(snapshot(&db), original);
}
#[test]
fn revision_reconciliation_persists_and_is_idempotent() {
    let requests = vec![
        json!({"requestId":"q","reviewTaskId":"r","revisionTaskId":"c",
        "reviewHeadSha":"h","status":"requested"}),
    ];
    let tasks = vec![json!({"id":"c","state":"QUEUED","executionId":null,
        "revision":{"kind":"targeted","reviewTaskId":"r","requestIds":["q"]}})];
    let review =
        json!({"outcome":"changes_required","revisionDisposition":"targeted","taskId":"r"});
    let db = database(tasks, review, requests);
    let mut ops = store(&db);
    assert!(reconcile_review_revisions(&mut ops, &graph(), "1").unwrap());
    assert_eq!(
        snapshot(&db)["reviewRevisionRequests"][0]["status"],
        "queued"
    );
    assert!(!reconcile_review_revisions(&mut ops, &graph(), "1").unwrap());
    let update = ops.mutate_job("1", |mut job| {
        job["tasks"][0]["state"] = json!("SUCCEEDED");
        Ok(job)
    });
    assert!(update.is_ok());
    assert!(reconcile_review_revisions(&mut ops, &graph(), "1").unwrap());
    assert_eq!(
        snapshot(&db)["reviewRevisionRequests"][0]["status"],
        "verified"
    );
}
#[test]
fn stale_revision_cancels_only_after_commit_and_fences_new_generation() {
    let tasks = vec![
        json!({"id":"r","state":"RUNNING","executionId":"review-new"}),
        json!({"id":"c","state":"RUNNING","executionId":"child-old",
            "leaseOwner":"owner","leaseExpiresAt":"soon"}),
    ];
    let review = json!({"taskId":"r","headSha":"head"});
    let requests = vec![
        json!({"requestId":"q","reviewTaskId":"r","revisionTaskId":"c",
        "reviewHeadSha":"head","reviewExecutionId":"review-old","status":"running"}),
    ];
    let db = database(tasks, review, requests);
    let mut ops = store(&db);
    let mut callbacks = vec![];
    assert!(stale_review_revisions_atomic(
        &mut ops,
        &graph(),
        "1",
        "r",
        "head",
        Some("review-old"),
        |task, execution| callbacks.push((task.to_owned(), execution.to_owned()))
    )
    .unwrap()
    .is_empty());
    assert!(callbacks.is_empty());
    let cancelled = stale_review_revisions_atomic(
        &mut ops,
        &graph(),
        "1",
        "r",
        "head",
        Some("review-new"),
        |task, execution| callbacks.push((task.to_owned(), execution.to_owned())),
    )
    .unwrap();
    assert_eq!(cancelled.len(), 1);
    assert_eq!(callbacks, vec![("c".to_owned(), "child-old".to_owned())]);
    assert_eq!(
        snapshot(&db)["reviewRevisionRequests"][0]["status"],
        "stale"
    );
    assert_eq!(snapshot(&db)["tasks"][1]["state"], "CANCELLED");
    assert!(stale_review_revisions_atomic(
        &mut ops,
        &graph(),
        "1",
        "r",
        "head",
        Some("review-new"),
        |_, _| panic!("callback must be idempotent")
    )
    .unwrap()
    .is_empty());
}
#[test]
fn stale_revision_failed_commit_never_cancels_worker() {
    let tasks = vec![
        json!({"id":"r","state":"RUNNING","executionId":"review-new"}),
        json!({"id":"c","state":"RUNNING","executionId":"child-old"}),
    ];
    let review = json!({"taskId":"r","headSha":"head"});
    let requests = vec![
        json!({"requestId":"q","reviewTaskId":"r","revisionTaskId":"c",
        "reviewHeadSha":"head","reviewExecutionId":"review-old","status":"running"}),
    ];
    let db = database(tasks, review, requests);
    let initial = snapshot(&db);
    let mut ops = SQLiteWorkflowOperations {
        db: &db,
        write: |_: &Value, _: &str| Err("forced write rollback".into()),
        enqueue: None::<fn(&Value, &str) -> Result<(), String>>,
    };
    let mut called = false;
    assert_eq!(
        stale_review_revisions_atomic(
            &mut ops,
            &graph(),
            "1",
            "r",
            "head",
            Some("review-new"),
            |_, _| called = true
        )
        .unwrap_err(),
        "forced write rollback"
    );
    assert!(!called);
    assert_eq!(snapshot(&db), initial);
}
#[test]
fn settlement_refuses_prior_snapshot_when_head_changed() {
    let tasks = vec![
        json!({"id":"r","kind":"work","agentName":"reviewer","state":"SUCCEEDED"}),
        json!({"id":"c","state":"SUCCEEDED"}),
    ];
    let review = json!({"taskId":"r","headSha":"head","outcome":"changes_required",
        "revisionDisposition":"targeted","updatedAt":"before"});
    let requests = vec![json!({"reviewTaskId":"r","revisionTaskId":"c","status":"verified"})];
    let db = database(tasks, review, requests);
    let snapshot_before = snapshot(&db);
    let mut ops = store(&db);
    ops.mutate_job("1", |mut job| {
        job["review"]["headSha"] = json!("new-head");
        Ok(job)
    })
    .unwrap();
    let changed = snapshot(&db);
    let result =
        settle_review_revision_round_atomic(&mut ops, &graph(), "1", &snapshot_before, 5, 3)
            .unwrap();
    assert_eq!(result["review"]["headSha"], "new-head");
    assert_eq!(snapshot(&db)["review"], changed["review"]);
}

fn revision_fixture() -> (Connection, Value) {
    let tasks = vec![
        json!({"id":"11","kind":"work","agentName":"implementation","state":"SUCCEEDED",
            "jobId":"1","title":"Owner","attempt":1,"maxAttempts":3,
            "capabilities":[],"input":"original input","result":{"summary":"pass"},
            "output":{"kind":"task_pr"}}),
        json!({"id":"12","kind":"work","agentName":"reviewer","state":"RUNNING",
            "jobId":"1","executionId":"e1","reviewHeadSha":"head"}),
    ];
    let review = json!({"taskId":"12","headSha":"head","outcome":"started"});
    let db = database(tasks, review, vec![]);
    let mut ops = store(&db);
    ops.mutate_job("1", |mut job| {
        job["headSha"] = json!("head");
        Ok(job)
    })
    .unwrap();
    let input = json!({
        "requestId":"r1","reviewTaskId":"12","reviewExecutionId":"e1",
        "headSha":"head","originalTaskId":"11", "allocatedTaskId":"99",
        "findings":[{"id":"f1","summary":"missing evidence","evidence":"specific source"}],
    });
    drop(ops);
    (db, input)
}
#[test]
fn targeted_revision_request_authoritative_sqlite_commit_and_repeat_are_idempotent() {
    let (db, input) = revision_fixture();
    let mut ops = store(&db);
    let result = ops
        .mutate_job("1", |mut job| {
            assert_eq!(
                agents_relay_rust2::review_revision_model::record_targeted_revision_request(
                    &graph(),
                    &mut job,
                    &input
                )?["created"],
                true
            );
            Ok(job)
        })
        .unwrap();
    assert_eq!(result["tasks"].as_array().unwrap().len(), 3);
    assert_eq!(result["tasks"][2]["state"], "DRAFT");
    assert_eq!(result["tasks"][2]["revision"]["originalTaskId"], "11");
    assert_eq!(result["tasks"][0]["state"], "SUCCEEDED");
    assert_eq!(result["tasks"][0]["comments"].as_array().unwrap().len(), 1);
    assert_eq!(result["tasks"][2]["comments"].as_array().unwrap().len(), 1);
    assert_eq!(
        result["reviewRevisionRequests"].as_array().unwrap().len(),
        1
    );
    let old = snapshot(&db);
    ops.mutate_job("1", |mut job| {
        assert_eq!(
            agents_relay_rust2::review_revision_model::record_targeted_revision_request(
                &graph(),
                &mut job,
                &input
            )?["created"],
            false
        );
        Ok(job)
    })
    .unwrap();
    let again = snapshot(&db);
    assert_eq!(again["tasks"], old["tasks"]);
    assert_eq!(
        again["reviewRevisionRequests"],
        old["reviewRevisionRequests"]
    );
    let mut mutated = input.clone();
    mutated["findings"][0]["summary"] = json!("different immutable evidence");
    assert_eq!(
        ops.mutate_job("1", |mut job| {
            agents_relay_rust2::review_revision_model::record_targeted_revision_request(
                &graph(),
                &mut job,
                &mutated,
            )?;
            Ok(job)
        })
        .unwrap_err(),
        "revision request ID reused with different immutable feedback"
    );
    assert_eq!(snapshot(&db)["tasks"], old["tasks"]);
    assert_eq!(
        snapshot(&db)["reviewRevisionRequests"],
        old["reviewRevisionRequests"]
    );
}
#[test]
fn targeted_revision_request_write_failure_rolls_back_request_child_and_comments() {
    let (db, input) = revision_fixture();
    let original = snapshot(&db);
    let mut ops = SQLiteWorkflowOperations {
        db: &db,
        write: |_job: &Value, _when: &str| Err("simulated SQLite write failed".into()),
        enqueue: None::<fn(&Value, &str) -> Result<(), String>>,
    };
    assert_eq!(
        ops.mutate_job("1", |mut job| {
            agents_relay_rust2::review_revision_model::record_targeted_revision_request(
                &graph(),
                &mut job,
                &input,
            )?;
            Ok(job)
        })
        .unwrap_err(),
        "simulated SQLite write failed"
    );
    assert_eq!(snapshot(&db), original);
}
#[test]
fn exhausted_troubleshooter_candidate_requires_real_failed_owner_and_no_recovery_barrier() {
    let job = json!({"tasks":[
        {"id":"owner","kind":"work","agentName":"worker","state":"FAILED","error":"bad"},
        {"id":"fix","agentName":"troubleshooter","parentTaskId":"owner",
            "state":"FAILED","attempt":3,"maxAttempts":3,"error":"provider unavailable"}
    ],"plans":[]});
    let choices =
        agents_relay_rust2::troubleshooter_fallback::exhausted_troubleshooter_escalations(&job);
    assert_eq!(choices.len(), 1);
    assert_eq!(choices[0]["taskId"], "fix");
    assert!(choices[0]["requiredAction"]
        .as_str()
        .unwrap()
        .contains("Task owner"));
    let mut active = job.clone();
    active["tasks"][0]["resolution"] = json!({"path":"same_job_dependency","state":"waiting"});
    assert!(
        agents_relay_rust2::troubleshooter_fallback::exhausted_troubleshooter_escalations(&active)
            .is_empty()
    );
    active["tasks"][0]["resolution"] = Value::Null;
    active["tasks"][1]["escalation"] = json!({"status":"requested"});
    assert!(
        agents_relay_rust2::troubleshooter_fallback::exhausted_troubleshooter_escalations(&active)
            .is_empty()
    );
}

#[test]
fn outcome_review_injected_execution_orders_roles_and_joins_verdict_without_subprocess() {
    use agents_relay_rust2::outcome_review::{
        evaluate_outcome_with_runner, outcome_review_exit_code,
    };
    let input = json!({"prompt":"evidence","projectPath":"/tmp/isolated-readonly-review",
        "reviewers":["reviewer","security","qa"]});
    let mut definitions = Vec::new();
    let mut calls = Vec::new();
    let result=evaluate_outcome_with_runner(&input,
        |name,project| {
            assert_eq!(project.to_string_lossy(),"/tmp/isolated-readonly-review");
            definitions.push(name.to_owned());
            Ok(format!("# {name} immutable contract"))
        },
        |name,prompt,project| {
            calls.push(name.to_owned());
            assert!(prompt.starts_with(&format!("# {name} immutable contract\n# Review Request")));
            assert!(prompt.contains(&format!("Reviewer: {name}")));
            assert!(prompt.contains("Review request:\nevidence"));
            assert!(prompt.contains(&format!("Project root: {}",project.display())));
            let verdict=match name {"reviewer"=>"PASS","security"=>"CHANGE_REQUIRED",_=>"BLOCKED"};
            Ok(json!({"status":0,"stdout":format!("{{\"verdict\":\"{verdict}\",\"findings\":[],\"evidence\":[]}} ")}))
        }
    ).unwrap();
    assert_eq!(definitions, vec!["reviewer", "security", "qa"]);
    assert_eq!(calls, vec!["reviewer", "security", "qa"]);
    assert_eq!(result["reviews"].as_array().unwrap().len(), 3);
    assert_eq!(result["verdict"], "BLOCKED");
    assert_eq!(outcome_review_exit_code(&result), 20);
    assert_eq!(
        outcome_review_exit_code(&json!({"verdict":"CHANGE_REQUIRED"})),
        10
    );
    assert_eq!(outcome_review_exit_code(&json!({"verdict":"PASS"})), 0);
}
#[test]
fn outcome_review_mocked_runner_rejects_non_json_invalid_and_runtime_failure_in_order() {
    use agents_relay_rust2::outcome_review::evaluate_outcome_with_runner;
    let input = json!({"prompt":"x","projectPath":"/tmp/no-network","reviewers":["reviewer"]});
    let outcomes = [
        (
            json!({"status":0,"stdout":"not json"}),
            "reviewer returned non-JSON result",
        ),
        (
            json!({"status":0,"stdout":"{\"verdict\":\"PASS\"}"}),
            "reviewer returned invalid review result",
        ),
        (
            json!({"status":12,"stderr":"offline failed"}),
            "reviewer execution failed: offline failed",
        ),
        (json!({"status":3}), "reviewer execution failed: 3"),
    ];
    for (output, reason) in outcomes {
        let actual = evaluate_outcome_with_runner(
            &input,
            |_name, _| Ok("# reviewer".into()),
            |_, _, _| Ok(output.clone()),
        );
        assert_eq!(actual.unwrap_err(), reason);
    }
    assert_eq!(
        evaluate_outcome_with_runner(
            &input,
            |_name, _| Ok("# reviewer".into()),
            |_, _, _| Err("injected process unavailable".into())
        )
        .unwrap_err(),
        "reviewer execution failed: injected process unavailable"
    );
}

#[test]
fn submitted_targeted_revision_allocates_stable_numeric_id_with_private_sqlite_store() {
    use agents_relay_rust2::review_revision_model::submit_targeted_revision_request;
    let (db, mut input) = revision_fixture();
    let root = std::env::temp_dir().join(format!(
        "rust2-wave3-review-b-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let store_dir = root.join("storage");
    input.as_object_mut().unwrap().remove("allocatedTaskId");
    let mut ops = store(&db);
    let result =
        submit_targeted_revision_request(&mut ops, &store_dir, &graph(), "1", &input).unwrap();
    assert_eq!(result["created"], true);
    let child = result["request"]["revisionTaskId"].as_str().unwrap();
    assert!(child.parse::<u64>().unwrap() > 0);
    let old = snapshot(&db);
    assert!(old["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .any(|task| task["id"] == child));
    let result2 =
        submit_targeted_revision_request(&mut ops, &store_dir, &graph(), "1", &input).unwrap();
    assert_eq!(result2["created"], false);
    assert_eq!(result2["request"]["revisionTaskId"], child);
    assert_eq!(snapshot(&db)["tasks"], old["tasks"]);
    std::fs::remove_dir_all(root).unwrap();
}
