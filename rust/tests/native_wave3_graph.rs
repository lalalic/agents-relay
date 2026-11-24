// Wave 3 owner-only native regressions. No live sqlite, sessions or production processes.
use agents_relay_rust2::task_inactivity_watchdog::accept_task_progress_sqlite;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::path::Path;
fn graph() -> &'static Path {
    Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../workflow"))
}
const EVENT_TIME: i64 = 1794906000123;
fn event(execution: &str) -> Value {
    json!({"job_id":"31","task_id":"21","timestamp":"2026-11-17T09:00:00.123Z",
      "source":{"id":format!("job/31/task/21/execution/{execution}")},"type":"task.progress"})
}
fn setup() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL);")
        .unwrap();
    let job = json!({"id":"31","state":"ACTIVE","tasks":[
      {"id":"21","jobId":"31","kind":"worker","state":"RUNNING","agentName":"developer",
       "executionId":"gen-1","updatedAt":"2026-11-17T09:00:00.000Z",
       "timeoutMs":10000,"lastProgressAt":null,"lastProgressEventAt":null},
      {"id":"22","jobId":"31","kind":"worker","state":"FAILED","executionId":"dead",
       "updatedAt":"2026-11-17T09:00:00.000Z"}
    ]});
    db.execute(
        "INSERT INTO job_snapshot VALUES('31',?,'2026-11-17T09:00:00.000Z')",
        [job.to_string()],
    )
    .unwrap();
    db
}
fn snapshot(db: &Connection) -> Value {
    let v: String = db
        .query_row("SELECT json FROM job_snapshot WHERE job_id='31'", [], |r| {
            r.get(0)
        })
        .unwrap();
    serde_json::from_str(&v).unwrap()
}
#[test]
fn atomic_progress_receipt_rechecks_live_execution_and_rejects_duplicates() {
    let mut db = setup();
    assert!(
        accept_task_progress_sqlite(&mut db, graph(), &event("forged"), EVENT_TIME + 100)
            .unwrap()
            .is_none()
    );
    assert!(snapshot(&db)["tasks"][0]["lastProgressAt"].is_null());
    let accepted = accept_task_progress_sqlite(&mut db, graph(), &event("gen-1"), EVENT_TIME + 100)
        .unwrap()
        .unwrap();
    assert_eq!(accepted["state"], "RUNNING");
    assert_eq!(accepted["lastProgressEventAt"], "2026-11-17T09:00:00.123Z");
    assert!(
        accept_task_progress_sqlite(&mut db, graph(), &event("gen-1"), EVENT_TIME + 120)
            .unwrap()
            .is_none()
    );
    assert_eq!(
        snapshot(&db)["tasks"][0]["lastProgressEventAt"],
        accepted["lastProgressEventAt"]
    );
    db.execute(
        "UPDATE job_snapshot SET json=?",
        params![{
            let mut j = snapshot(&db);
            j["tasks"][0]["executionId"] = json!("gen-2");
            j.to_string()
        }],
    )
    .unwrap();
    assert!(
        accept_task_progress_sqlite(&mut db, graph(), &event("gen-1"), EVENT_TIME + 250)
            .unwrap()
            .is_none()
    );
    assert_eq!(snapshot(&db)["tasks"][0]["executionId"], "gen-2");
}
#[test]
fn failed_transaction_rolls_back_progress_write_and_does_not_poison_future_receipts() {
    let mut db = setup();
    let before = snapshot(&db);
    db.execute_batch("CREATE TRIGGER stop_progress BEFORE UPDATE ON job_snapshot BEGIN SELECT RAISE(ABORT,'fault injected'); END;").unwrap();
    assert!(
        accept_task_progress_sqlite(&mut db, graph(), &event("gen-1"), EVENT_TIME + 100).is_err()
    );
    assert_eq!(snapshot(&db), before);
    db.execute_batch("DROP TRIGGER stop_progress").unwrap();
    assert!(
        accept_task_progress_sqlite(&mut db, graph(), &event("gen-1"), EVENT_TIME + 100)
            .unwrap()
            .is_some()
    );
}
#[test]
fn future_and_missing_progress_are_rejected_without_writes() {
    let mut db = setup();
    let before = snapshot(&db);
    assert!(
        accept_task_progress_sqlite(&mut db, graph(), &event("gen-1"), EVENT_TIME - 1)
            .unwrap()
            .is_none()
    );
    let mut missing = event("gen-1");
    missing["task_id"] = json!("missing");
    assert!(
        accept_task_progress_sqlite(&mut db, graph(), &missing, EVENT_TIME + 10)
            .unwrap()
            .is_none()
    );
    assert_eq!(snapshot(&db), before);
}
#[test]
fn planner_facts_mutable_public_entrypoint_sorts_plans_as_node_does() {
    use agents_relay_rust2::workflow::planner_orchestration_v2::{
        planner_orchestration_facts, planner_orchestration_facts_in_place,
    };
    let mut j = json!({"id":"6","tasks":[],"plans":[
        {"id":"late","round":2,"createdAt":"2026-11-17T00:00:00Z","status":"SUCCEEDED"},
        {"id":"b","round":1,"createdAt":"2026-11-17T04:00:00Z","status":"SUCCEEDED"},
        {"id":"a","round":1,"createdAt":"2026-11-17T01:00:00Z","status":"SUCCEEDED"}
    ]});
    let pure = planner_orchestration_facts(&j, false);
    assert_eq!(j["plans"][0]["id"], "late");
    let mutable = planner_orchestration_facts_in_place(&mut j, false);
    assert_eq!(mutable, pure);
    assert_eq!(
        j["plans"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["a", "b", "late"]
    );
}
#[test]
fn task_resolution_runtime_object_is_exposed_with_real_graph_guards() {
    use agents_relay_rust2::workflow::task_resolution::task_resolution_v2;
    let runtime = task_resolution_v2(graph()).unwrap();
    assert!(runtime
        .registry
        .guards
        .contains_key("freshRecoveryExecution"));
    assert!(runtime
        .registry
        .actions
        .contains_key("resolution.activateRecovery"));
    assert!(runtime.registry.events.contains_key("resolution.propose"));
    let decision=runtime.evaluate_sync(&json!({
        "currentState":"unresolved",
        "input":{"transport":"event","id":"resolution.propose","payload":{"path":"exact_original_retry"}},
        "durableFacts":{"recoveryOwnerAvailable":true,"exactOriginalRetry":true,"freshRecoveryExecution":true}
    })).unwrap();
    assert_eq!(decision["accepted"], true);
}
#[cfg(unix)]
#[test]
fn laya_uses_owned_child_real_stdout_stderr_files_and_timeout() {
    use agents_relay_rust2::decision::{LayaCliDecisionEngine, LayaCliOptions};
    use std::collections::HashMap;
    let request = json!({"facts":{"task":"sample","confidence":0.3}});
    let contract = json!({"type":"choice","question":"Choose route","choices":["yes","no"]});
    let run = |script: &str, timeout| {
        LayaCliDecisionEngine::new(LayaCliOptions {
            command: "/bin/sh".into(),
            args: vec!["-c".into(), script.into(), "fixture".into()],
            timeout_ms: timeout,
        })
    };
    let valid=run("test \"$1\" = '--state-file' && test -s \"$2\" && test \"$3\" = '--questions' && test -s \"$4\" && printf '{\"choice\":\"yes\"}\\n'", 2_000);
    let answer = valid.decide(&request, &contract).unwrap();
    assert_eq!(answer["type"], "choice");
    assert_eq!(answer["choice"], "yes");
    let failed = run("printf 'native subprocess failed\\n' >&2; exit 19", 2_000);
    assert_eq!(
        failed.decide(&request, &contract).unwrap_err(),
        "Laya CLI exited 19: native subprocess failed"
    );
    let invalid = run("printf 'NOT JSON'", 2_000);
    assert_eq!(
        invalid.decide(&request, &contract).unwrap_err(),
        "Laya CLI returned invalid JSON"
    );
    let timed = run("sleep 6", 90);
    assert!(timed
        .decide(&request, &contract)
        .unwrap_err()
        .contains("timed out after 90ms"));
    let injected = run(
        "printf '{\"choice\":\"%s\"}' \"$TEST_DECISION_TOKEN\"",
        2_000,
    );
    let env = HashMap::from([("TEST_DECISION_TOKEN".into(), "no".into())]);
    assert_eq!(
        injected
            .decide_with_env(&request, &contract, Some(&env))
            .unwrap()["choice"],
        "no"
    );
}
#[test]
fn coordinator_batches_all_same_turn_signals_exactly_once_and_reports_detached_failure() {
    use agents_relay_rust2::reconcile_coordinator::ReconcileCoordinator;
    use std::sync::{Arc, Mutex};
    let batches = Arc::new(Mutex::new(Vec::<(String, Vec<Value>)>::new()));
    let errors = Arc::new(Mutex::new(Vec::<String>::new()));
    let written = Arc::clone(&batches);
    let reported = Arc::clone(&errors);
    type ErrorReporter = dyn Fn(&str, &Value) + Send + Sync;
    let report: Arc<ErrorReporter> = Arc::new(move |err, signal| {
        reported
            .lock()
            .unwrap()
            .push(format!("{err}:{}", signal["reason"]));
    });
    let coordinator = ReconcileCoordinator::new(
        move |job, signals| {
            written.lock().unwrap().push((job.into(), signals.to_vec()));
            if signals.iter().any(|s| s["fail"] == true) {
                Err("reconcile failed".into())
            } else {
                Ok(())
            }
        },
        Some(report),
    );
    let turn = coordinator.begin_turn();
    let mut replies = Vec::new();
    replies.push(coordinator.accept(json!({"jobId":"31","reason":"first"})));
    replies.push(coordinator.accept(json!({"jobId":"31","reason":"second"})));
    replies.push(coordinator.accept_observed(json!({"jobId":"31","reason":"third"})));
    replies
        .push(coordinator.accept_transport(json!({"jobId":"31","reason":"detached","fail":true})));
    replies.push(coordinator.accept(json!({"jobId":"32","reason":"other"})));
    assert!(!coordinator.is_idle());
    // The detached promise resolves before batch processing, as in Node.
    assert!(replies[3].recv().unwrap().is_ok());
    // Releasing the outermost turn is the Rust equivalent of queueMicrotask.
    drop(turn);
    assert!(replies[0].recv().unwrap().is_err());
    assert!(replies[1].recv().unwrap().is_err());
    assert!(replies[2].recv().unwrap().is_err());
    assert!(replies[4].recv().unwrap().is_ok());
    coordinator.settle();
    assert!(coordinator.is_idle());
    let batches = batches.lock().unwrap();
    assert_eq!(batches.len(), 2);
    assert_eq!(batches.iter().find(|x| x.0 == "31").unwrap().1.len(), 4);
    assert_eq!(
        errors.lock().unwrap().as_slice(),
        &["reconcile failed:\"detached\""]
    );
}
fn drive<T>(future: impl std::future::Future<Output = T>) -> T {
    use std::{
        pin::pin,
        task::{Context, Poll, Waker},
    };
    let mut future = pin!(future);
    let mut context = Context::from_waker(Waker::noop());
    match future.as_mut().poll(&mut context) {
        Poll::Ready(result) => result,
        Poll::Pending => panic!("native async fixture callbacks should resolve immediately"),
    }
}
#[test]
fn task_async_effect_runs_only_after_persist_and_graph_gate() {
    use agents_relay_rust2::task_transitions::transition_task_event_async;
    use std::sync::{Arc, Mutex};
    let mut task = json!({"id":"41","jobId":"31","state":"QUEUED","agentName":"developer",
        "updatedAt":"2026-11-17T08:00:00Z"});
    let trace = Arc::new(Mutex::new(Vec::new()));
    let persisted = Arc::clone(&trace);
    let effected = Arc::clone(&trace);
    let result = drive(transition_task_event_async(
        graph(),
        &mut task,
        "dispatch",
        &json!({"dispatchable":true}),
        "2026-11-17T09:00:00Z",
        move |action| {
            let trace = Arc::clone(&effected);
            async move {
                trace.lock().unwrap().push(format!("effect:{action}"));
                Ok(())
            }
        },
        move |state| {
            let trace = Arc::clone(&persisted);
            async move {
                assert_eq!(state["state"], "QUEUED");
                trace.lock().unwrap().push("persist".to_owned());
                Ok(())
            }
        },
    ))
    .unwrap();
    assert_eq!(result["accepted"], true);
    assert_eq!(
        trace.lock().unwrap().as_slice(),
        ["persist", "effect:effect.launchTask"]
    );
    trace.lock().unwrap().clear();
    let before = task.clone();
    assert!(drive(transition_task_event_async(
        graph(),
        &mut task,
        "illegal",
        &json!({}),
        "2026-11-17T09:00:00Z",
        |_| async { panic!("rejected graph may not execute effects") },
        |_| async { panic!("rejected graph may not persist") }
    ))
    .is_err());
    assert_eq!(before, task);
    let failed = drive(transition_task_event_async(
        graph(),
        &mut task,
        "dispatch",
        &json!({"dispatchable":true}),
        "2026-11-17T09:00:00Z",
        |_| async { Err("delivery fault".into()) },
        |_| async { Ok(()) },
    ));
    assert_eq!(failed.unwrap_err(), "delivery fault");
}
#[test]
fn job_async_effect_runs_only_after_persist_and_rejected_event_has_no_io() {
    use agents_relay_rust2::task_transitions::transition_job_event_async;
    use std::sync::{Arc, Mutex};
    let mut job = json!({"id":"31","state":"ACTIVE","updatedAt":"2026-11-17T07:00:00Z"});
    let trace = Arc::new(Mutex::new(Vec::new()));
    let persisted = Arc::clone(&trace);
    let effected = Arc::clone(&trace);
    let decision = drive(transition_job_event_async(
        graph(),
        &mut job,
        "cancel",
        &json!({}),
        "2026-11-17T09:00:00Z",
        move |action| {
            let trace = Arc::clone(&effected);
            async move {
                trace.lock().unwrap().push(format!("effect:{action}"));
                Ok(())
            }
        },
        move |state| {
            let trace = Arc::clone(&persisted);
            async move {
                assert_eq!(state["state"], "CANCELLED");
                trace.lock().unwrap().push("persist".to_owned());
                Ok(())
            }
        },
    ))
    .unwrap();
    assert_eq!(decision["accepted"], true);
    assert_eq!(
        trace.lock().unwrap().as_slice(),
        ["persist", "effect:effect.cancelActiveTasks"]
    );
    let before = job.clone();
    assert!(drive(transition_job_event_async(
        graph(),
        &mut job,
        "cancel",
        &json!({}),
        "2026-11-17T09:00:00Z",
        |_| async { panic!("terminal job cannot execute effect") },
        |_| async { panic!("terminal job cannot persist") }
    ))
    .is_err());
    assert_eq!(job, before);
}
