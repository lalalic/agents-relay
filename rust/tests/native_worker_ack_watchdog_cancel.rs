// Isolated E2E event and cancellation fixtures; zero real Jobs or subscriptions.
use agents_relay_rust2::{
    reconciler_cancellation::{cancel_active_tasks, cancel_task_action},
    task_inactivity_watchdog::{
        arm_deadline, inactivity_deadline, is_correlated_worker_event,
        is_recoverable_watchdog_failure, requires_worker_inactivity_watchdog,
        task_progress_mutation, WatchdogTimers,
    },
    worker_start_ack::{create_worker_start_ack, WorkerEventBus},
};
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
type Listener = Arc<dyn Fn(&Value) + Send + Sync>;
#[derive(Default)]
struct FakeBus {
    listener: Arc<Mutex<Option<Listener>>>,
    unsubscribed: Arc<Mutex<usize>>,
}
impl FakeBus {
    fn send(&self, value: &Value) {
        if let Some(callback) = self.listener.lock().unwrap().as_ref() {
            callback(value);
        }
    }
}
impl WorkerEventBus for FakeBus {
    fn subscribe(
        &mut self,
        _job_id: &str,
        on_event: Listener,
    ) -> Result<Arc<dyn Fn() + Send + Sync>, String> {
        *self.listener.lock().unwrap() = Some(on_event);
        let listener = Arc::clone(&self.listener);
        let unsub = Arc::clone(&self.unsubscribed);
        Ok(Arc::new(move || {
            *listener.lock().unwrap() = None;
            *unsub.lock().unwrap() += 1;
        }))
    }
}
#[test]
fn ack_ignores_spoofed_cross_execution_receipts_and_stops_idempotently() {
    let mut bus = FakeBus::default();
    let ack = create_worker_start_ack(&mut bus, "34", "21", "job/34/task/21/execution/gen-1", 80)
        .unwrap();
    for event in [
        json!({"type":"task.progress","job_id":"34","task_id":"21","source":{"id":"job/34/task/21/execution/gen-1"}}),
        json!({"type":"task.started","job_id":"34","task_id":"21","source":{"id":"job/34/task/21/execution/gen-2"}}),
        json!({"type":"task.started","job_id":"WRONG","task_id":"21","source":{"id":"job/34/task/21/execution/gen-1"}}),
    ] {
        bus.send(&event);
    }
    bus.send(&json!({"type":"task.started","job_id":"34","task_id":"21","source":{"id":"job/34/task/21/execution/gen-1"}}));
    ack.wait().unwrap();
    ack.stop();
    ack.stop();
    assert_eq!(*bus.unsubscribed.lock().unwrap(), 1);
    let timeout = create_worker_start_ack(&mut bus, "34", "21", "source", 12).unwrap();
    assert!(timeout
        .wait()
        .unwrap_err()
        .0
        .contains("worker_start_timeout"));
    timeout.stop();
    assert_eq!(*bus.unsubscribed.lock().unwrap(), 3);
    let cancelled = create_worker_start_ack(&mut bus, "34", "22", "source", 200).unwrap();
    cancelled.stop();
    assert!(cancelled
        .wait()
        .unwrap_err()
        .0
        .contains("worker_start_cancelled"));
}
#[test]
fn watchdog_validates_event_source_monotonic_timestamp_and_limits_post_exit() {
    let task = json!({"id":"21","jobId":"34","state":"RUNNING","executionId":"gen-1","adapter":"shell","timeoutMs":120000,"lastProgressAt":"2026-11-17T01:00:00.000Z","processExitedAt":"2026-11-17T01:00:01.000Z","updatedAt":"2026-11-16T23:00:00.000Z"});
    let event = json!({"type":"task.progress","timestamp":"2026-11-17T01:00:00.123Z","job_id":"34","task_id":"21","source":{"id":"job/34/task/21/execution/gen-1"}});
    assert!(is_correlated_worker_event(&task, &event));
    assert_eq!(inactivity_deadline(&task, "gen-1", 5000, 0), 1794877206000);
    let timestamp = 1794877200123_i64;
    let next = task_progress_mutation(&task, &event, timestamp + 100).unwrap();
    assert_eq!(next["lastProgressAt"], "2026-11-17T01:00:00.223Z");
    assert!(task_progress_mutation(&next, &event, timestamp + 100).is_none());
    let mut forged = event.clone();
    forged["source"]["id"] = json!("other");
    assert!(task_progress_mutation(&task, &forged, timestamp + 100).is_none());
    let mut future = event.clone();
    future["timestamp"] = json!("2026-11-17T02:00:00.000Z");
    assert!(task_progress_mutation(&task, &future, timestamp + 100).is_none());
    assert!(arm_deadline(&task, "stale-gen", 5000, timestamp).is_none());
    assert!(is_recoverable_watchdog_failure(
        &json!({"failureReason":"worker_start_timeout"})
    ));
    assert!(!requires_worker_inactivity_watchdog(
        &json!({"agentGraph":{},"executionId":null})
    ));
    let mut timers = WatchdogTimers::default();
    let hit = Arc::new(Mutex::new(false));
    let reported = Arc::clone(&hit);
    let armed = json!({"id":"1","jobId":"34","state":"RUNNING","executionId":"g","timeoutMs":1,"updatedAt":"2020-01-01T00:00:00.000Z"});
    timers
        .arm(&armed, "g", 5000, move || *reported.lock().unwrap() = true)
        .unwrap();
    std::thread::sleep(Duration::from_millis(40));
    assert!(*hit.lock().unwrap());
}
#[test]
fn cancellation_effect_preserves_plan_first_and_uses_task_graph() {
    let dir = Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../workflow"));
    let mut job = json!({"id":"5","plans":[{"id":"p1","status":"PLANNING","executionId":"plan-gen","leaseOwner":"x"},{"id":"p2","status":"FAILED"}],"tasks":[{"id":"t1","jobId":"5","kind":"worker","state":"RUNNING","executionId":"g1","updatedAt":"2026-11-01T00:00:00.000Z","leaseOwner":"x"},{"id":"t2","kind":"worker","state":"SUCCEEDED"},{"id":"t3","kind":"planner","state":"QUEUED"},{"id":"t4","jobId":"5","kind":"worker","state":"QUEUED","executionHistory":[{"id":"last"}],"updatedAt":"2026-11-01T00:00:00.000Z"}]});
    let log = Arc::new(Mutex::new(Vec::<String>::new()));
    let planner_log = Arc::clone(&log);
    let execution_log = Arc::clone(&log);
    let plan_log = Arc::clone(&log);
    let task_log = Arc::clone(&log);
    cancel_active_tasks(
        &mut job,
        "cancelled by owner",
        dir,
        move |id| {
            planner_log
                .lock()
                .unwrap()
                .push(format!("cancelPlanner:{id}"))
        },
        move |jid, id, gen| {
            execution_log.lock().unwrap().push(format!(
                "cancelExecution:{jid}/{id}/{}",
                gen.unwrap_or("null")
            ))
        },
        move |p| {
            plan_log
                .lock()
                .unwrap()
                .push(format!("savePlan:{}", p["id"].as_str().unwrap()));
            Ok(())
        },
        move |t| {
            task_log
                .lock()
                .unwrap()
                .push(format!("saveTask:{}", t["id"].as_str().unwrap()));
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(job["plans"][0]["status"], "FAILED");
    assert_eq!(job["tasks"][0]["state"], "CANCELLED");
    assert_eq!(job["tasks"][0]["executionId"], Value::Null);
    assert_eq!(job["tasks"][1]["state"], "SUCCEEDED");
    assert_eq!(job["tasks"][3]["state"], "CANCELLED");
    assert_eq!(
        *log.lock().unwrap(),
        vec![
            "cancelPlanner:p1",
            "savePlan:p1",
            "cancelExecution:5/t1/g1",
            "cancelPlanner:t1",
            "saveTask:t1",
            "cancelExecution:5/t4/last",
            "cancelPlanner:t4",
            "saveTask:t4"
        ]
    );
    assert!(cancel_task_action(&mut job["tasks"][0], "again", dir)
        .unwrap_err()
        .contains("not cancellable"));
}
