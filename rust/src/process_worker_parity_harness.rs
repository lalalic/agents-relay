// Differential fixture driver for the six direct process/browser Node ports.
// Test-only request inputs select only sandboxed SQLite / test subprocesses.
use crate::{
    browser_worker_pool::{BrowserPoolOptions, BrowserSlot, BrowserWorkerPoolManager},
    browser_worker_pool_graph::{
        monitor_pool_decision, pool_decision, progress_pool_decision, require_pool_decision,
    },
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
fn normalized(decision: &Value) -> Value {
    json!({"accepted":decision["accepted"],"target":decision["target"],"actions":decision["actions"].as_array().map(|a|a.iter().map(|x|x["id"].clone()).collect::<Vec<_>>()).unwrap_or_default(),"reason":decision["reason"]})
}
fn pool_graph(request: &Value) -> Result<Value, String> {
    let state = string(request, "state");
    let event = string(request, "event");
    let healthy = boolval(request, "healthy", true);
    match string(request, "mode") {
        "raw" => pool_decision(
            state,
            event,
            &json!({"providerHealthy":healthy,"recoveryDue":boolval(request,"recoveryDue",false),"freshOutput":boolval(request,"freshOutput",false)}),
        ),
        "require" => Ok(normalized(&require_pool_decision(
            state,
            event,
            string(request, "expected"),
            healthy,
        )?)),
        "monitor" => Ok(json!(monitor_pool_decision(boolval(
            request,
            "recoveryDue",
            false
        ))?)),
        "progress" => Ok(json!(progress_pool_decision(boolval(
            request,
            "freshOutput",
            false
        ))?)),
        _ => Ok(normalized(&pool_decision(
            state,
            event,
            &json!({"providerHealthy":healthy,"recoveryDue":boolval(request,"recoveryDue",false),"freshOutput":boolval(request,"freshOutput",false)}),
        )?)),
    }
}
fn pool_sequence(request: &Value) -> Result<Value, String> {
    let use_file = request["useFile"] == true;
    let path = if use_file {
        std::env::temp_dir().join(format!(
            "rust2-diff-browser-{}-{}.sqlite",
            std::process::id(),
            watchdog::now_ms()
        ))
    } else {
        PathBuf::from(":memory:")
    };
    let capacity = request["capacity"].as_i64().unwrap_or(1);
    let wait = request["queueWaitMs"].as_i64().unwrap_or(30);
    let make = || {
        BrowserWorkerPoolManager::open(BrowserPoolOptions {
            path: Some(path.clone()),
            capacity,
            queue_wait_ms: wait,
            poll_ms: 2,
            max_queue: request["maxQueue"].as_i64().unwrap_or(12),
        })
        .map_err(|e| e.message)
    };
    let mut pool = make()?;
    let mut leases = HashMap::<String, BrowserSlot>::new();
    let mut results = Vec::new();
    for step in request["steps"].as_array().into_iter().flatten() {
        let action = string(step, "action");
        let id = string(step, "id");
        let provider = string(step, "provider");
        let result: Result<Value, crate::browser_worker_pool::BrowserPoolError> = match action {
            "snapshot" => pool.to_value(provider),
            "acquire" => pool.acquire(provider, id, None).map(|lease| {
                leases.insert(id.into(), lease.clone());
                json!(lease)
            }),
            "bindSession" => leases
                .get_mut(id)
                .ok_or_else(|| "unknown fixture lease".to_string())
                .map_err(Into::into)
                .and_then(|lease| {
                    pool.bind_session(lease, string(step, "sessionId"))
                        .map(|_| Value::Null)
                }),
            "bindThread" => leases
                .get_mut(id)
                .ok_or_else(|| "unknown fixture lease".to_string())
                .map_err(Into::into)
                .and_then(|lease| {
                    pool.bind_thread(lease, string(step, "url"))
                        .map(|_| Value::Null)
                }),
            "touch" => leases
                .get(id)
                .ok_or_else(|| "unknown fixture lease".to_string())
                .map_err(Into::into)
                .and_then(|lease| pool.touch(lease).map(|_| Value::Null)),
            "release" => leases
                .get(id)
                .ok_or_else(|| "unknown fixture lease".to_string())
                .map_err(Into::into)
                .and_then(|lease| pool.release(lease).map(|_| Value::Null)),
            "quarantine" => leases
                .get(id)
                .ok_or_else(|| "unknown fixture lease".to_string())
                .map_err(Into::into)
                .and_then(|lease| pool.quarantine(lease).map(|_| Value::Null)),
            "releaseQuarantine" => leases
                .get(id)
                .ok_or_else(|| "unknown fixture lease".to_string())
                .map_err(Into::into)
                .and_then(|lease| {
                    pool.release_quarantine(lease, boolval(step, "verified", false))
                        .map(|_| Value::Null)
                }),
            "outage" => pool
                .report_pre_submission_outage(
                    provider,
                    step["durationMs"].as_i64().unwrap_or(120000),
                )
                .map(|_| Value::Null),
            "healthy" => pool.report_healthy(provider).map(|_| Value::Null),
            "restart" => {
                if use_file {
                    drop(pool);
                    pool = make()?;
                    Ok(Value::Null)
                } else {
                    Err("restart requires a file-backed pool".to_string().into())
                }
            }
            _ => Err(format!("unknown fixture action {action}").into()),
        };
        results.push(match result {
            Ok(value) => json!({"ok":true,"value":value}),
            Err(err) => json!({"ok":false,"error":err.message,"code":err.code}),
        });
    }
    drop(pool);
    if use_file {
        for ext in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{}", path.display(), ext));
        }
    }
    Ok(json!(results))
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
        "graph" => pool_graph(request),
        "pool" => pool_sequence(request),
        "watchdog" => Ok(watchdog_fixture(request)),
        "cancel" => cancel_fixture(request),
        "ack" => ack_fixture(request),
        "owned" => owned_fixture(request),
        kind => Err(format!("unknown process-worker fixture kind {kind}")),
    }
}
