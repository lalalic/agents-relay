// Differential fixture driver for the six direct process/browser Node ports.
// Test-only request inputs select only sandboxed SQLite / test subprocesses.
use crate::{
    owned_process::{OwnedProcessManager, OwnedProcessOptions, TerminationReason},
    reconciler_cancellation, task_inactivity_watchdog as watchdog,
    worker_start_ack::{create_worker_start_ack, WorkerEventBus},
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
fn string<'a>(row: &'a Value, key: &str) -> &'a str {
    row.get(key).and_then(Value::as_str).unwrap_or("")
}
fn boolval(row: &Value, key: &str, default: bool) -> bool {
    row.get(key).and_then(Value::as_bool).unwrap_or(default)
}
fn watchdog_fixture(request: &Value) -> Value {
    let task = &request["task"];
    let event = &request["event"];
    let now = request["now"].as_i64().unwrap_or_else(watchdog::now_ms);
    json!({"requires":watchdog::requires_worker_inactivity_watchdog(task),"recoverable":watchdog::is_recoverable_watchdog_failure(task),"correlated":watchdog::is_correlated_worker_event(task,event),"progressAccepted":watchdog::task_progress_mutation(task,event,now).is_some()})
}
fn cancel_fixture(request: &Value) -> Result<Value, String> {
    use std::cell::RefCell;
    use std::rc::Rc;
    let mut job = request["job"].clone();
    let reason = string(request, "reason");
    let trace = Rc::new(RefCell::new(Vec::<String>::new()));
    let a = Rc::clone(&trace);
    let b = Rc::clone(&trace);
    let c = Rc::clone(&trace);
    let d = Rc::clone(&trace);
    let directory = std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../workflow"));
    reconciler_cancellation::cancel_active_tasks(
        &mut job,
        reason,
        directory,
        move |id| a.borrow_mut().push(format!("cancelPlanner:{id}")),
        move |job, id, gen| {
            b.borrow_mut().push(format!(
                "cancelExecution:{job}/{id}/{}",
                gen.unwrap_or("null")
            ))
        },
        move |plan| {
            c.borrow_mut()
                .push(format!("savePlan:{}", string(plan, "id")));
            Ok(())
        },
        move |task| {
            d.borrow_mut()
                .push(format!("saveTask:{}", string(task, "id")));
            Ok(())
        },
    )?;
    for plan in job["plans"].as_array_mut().into_iter().flatten() {
        if plan["updatedAt"].is_string() {
            plan["updatedAt"] = json!("DATE");
        }
    }
    for task in job["tasks"].as_array_mut().into_iter().flatten() {
        if task["updatedAt"].is_string() {
            task["updatedAt"] = json!("DATE");
        }
    }
    let results = trace.borrow().clone();
    Ok(json!({"job":job,"trace":results}))
}
type Listener = Arc<dyn Fn(&Value) + Send + Sync>;
#[derive(Default)]
struct FakeBus {
    callback: Arc<Mutex<Option<Listener>>>,
    unsubs: Arc<Mutex<usize>>,
}
impl FakeBus {
    fn emit(&self, event: &Value) {
        if let Some(callback) = self.callback.lock().unwrap().as_ref() {
            callback(event);
        }
    }
}
impl WorkerEventBus for FakeBus {
    fn subscribe(
        &mut self,
        _job_id: &str,
        callback: Listener,
    ) -> Result<Arc<dyn Fn() + Send + Sync>, String> {
        *self.callback.lock().unwrap() = Some(callback);
        let holder = Arc::clone(&self.callback);
        let count = Arc::clone(&self.unsubs);
        Ok(Arc::new(move || {
            *holder.lock().unwrap() = None;
            *count.lock().unwrap() += 1;
        }))
    }
}
fn ack_fixture(request: &Value) -> Result<Value, String> {
    let mut bus = FakeBus::default();
    let ack = create_worker_start_ack(
        &mut bus,
        string(request, "jobId"),
        string(request, "taskId"),
        string(request, "sourceId"),
        request["timeoutMs"].as_u64().unwrap_or(20),
    )?;
    for event in request["events"].as_array().into_iter().flatten() {
        bus.emit(event);
    }
    if request["stopBeforeWait"] == true {
        ack.stop();
    }
    let outcome = match ack.wait() {
        Ok(()) => json!({"ok":true}),
        Err(error) => json!({"ok":false,"error":error.0}),
    };
    ack.stop();
    ack.stop();
    let unsubs = *bus.unsubs.lock().expect("unsub mutex");
    Ok(json!({"outcome":outcome,"unsubscribed":unsubs}))
}
fn owned_fixture(request: &Value) -> Result<Value, String> {
    // Only a fixed sandboxed shell command is accepted: no arbitrary PID or command from payload.
    let mut manager = OwnedProcessManager::default();
    let mut options = OwnedProcessOptions {
        invocation: "parity-fixture".into(),
        grace_ms: 50,
        timeout_ms: None,
        ..Default::default()
    };
    if request["timeout"] == true {
        options.timeout_ms = Some(35);
    }
    let child = manager.spawn_owned_process("/bin/sh", &["-c", "sleep 10 & wait"], options)?;
    let before = manager.owned_process_snapshot().len();
    let foreign_refused = !manager.terminate_owned_process(1, TerminationReason::Cancel, None);
    if request["timeout"] != true {
        child.terminate(TerminationReason::Cancel, Some(50));
    }
    let finished = child.wait_for_leader(Duration::from_secs(2));
    Ok(
        json!({"finished":finished,"reason":child.termination_reason().map(|v|v.as_str()),"foreignRefused":foreign_refused,"snapshotCount":before}),
    )
}
pub fn scenario(request: &Value) -> Result<Value, String> {
    match string(request, "kind") {
        "watchdog" => Ok(watchdog_fixture(request)),
        "cancel" => cancel_fixture(request),
        "ack" => ack_fixture(request),
        "owned" => owned_fixture(request),
        kind => Err(format!("unknown process-worker fixture kind {kind}")),
    }
}
