// Native Rust tests for direct Node src/workflow/effects.ts port: ordered async callback execution, durable receipt dedupe, failures and graph-effect observations.
use agents_relay_rust2::{
    observability::{collect_observations, set_observability, RelayObservability},
    workflow::effects::{
        CallbackWorkflowEffectHandler, EffectCallback, MemoryWorkflowEffectReceiptStore,
        OutcomeCallback, ReceiptFuture, WorkflowEffectError, WorkflowEffectExecutor,
        WorkflowEffectHandler, WorkflowEffectReceiptStore,
    },
};
use serde_json::{json, Value};
use std::{
    future::Future,
    pin::pin,
    sync::{Arc, Mutex},
    task::{Context, Poll, Waker},
};
fn drive<T>(future: impl Future<Output = T>) -> T {
    let mut pinned = pin!(future);
    let mut cx = Context::from_waker(Waker::noop());
    loop {
        if let Poll::Ready(result) = pinned.as_mut().poll(&mut cx) {
            return result;
        }
        std::thread::yield_now();
    }
}
fn callback(
    name: &str,
    trace: Arc<Mutex<Vec<String>>>,
    error: Option<WorkflowEffectError>,
) -> EffectCallback {
    let name = name.to_string();
    Arc::new(move |_| {
        trace.lock().unwrap().push(name.clone());
        let error = error.clone();
        Box::pin(async move {
            if let Some(error) = error {
                Err(error)
            } else {
                Ok(())
            }
        })
    })
}
#[test]
fn effect_idempotency_key_preserves_explicit_empty_task_and_duplicate_registration_fails() {
    let trace = Arc::new(Mutex::new(Vec::new()));
    let handler =
        WorkflowEffectHandler::new("effect.launchTask", callback("x", Arc::clone(&trace), None));
    assert_eq!(
        handler.idempotency_key(&json!({"jobId":"7","taskId":"","transitionKey":"start"})),
        "effect.launchTask:7::start"
    );
    assert_eq!(
        handler.idempotency_key(&json!({"jobId":"7","taskId":null,"transitionKey":"start"})),
        "effect.launchTask:7:job:start"
    );
    let duplicate =
        WorkflowEffectHandler::new("effect.launchTask", callback("x", Arc::clone(&trace), None));
    let err = WorkflowEffectExecutor::new(
        vec![handler, duplicate],
        Arc::new(MemoryWorkflowEffectReceiptStore::new()),
    )
    .err()
    .unwrap();
    assert_eq!(
        err,
        "Workflow effect handler already registered: effect.launchTask"
    );
}

#[test]
fn effects_run_in_order_then_deduplicate_without_reinvoking_callbacks() {
    let trace = Arc::new(Mutex::new(Vec::<String>::new()));
    let first = WorkflowEffectHandler::new(
        "effect.launchTask",
        callback("launch", Arc::clone(&trace), None),
    );
    let second = WorkflowEffectHandler::new(
        "effect.cancelActiveTasks",
        callback("cancel", Arc::clone(&trace), None),
    );
    let receipts = Arc::new(MemoryWorkflowEffectReceiptStore::new());
    let executor = WorkflowEffectExecutor::new(
        vec![first, second],
        Arc::clone(&receipts) as Arc<dyn WorkflowEffectReceiptStore>,
    )
    .unwrap();
    let context = json!({"jobId":"100","taskId":"10","transitionKey":"dispatch"});
    let effects = vec![
        "effect.launchTask".into(),
        "effect.cancelActiveTasks".into(),
        "effect.launchTask".into(),
    ];
    let outcomes = drive(executor.execute(&effects, &context, None)).unwrap();
    assert_eq!(
        outcomes
            .iter()
            .map(|item| item["status"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["completed", "completed", "deduplicated"]
    );
    assert_eq!(trace.lock().unwrap().as_slice(), &["launch", "cancel"]);
    assert_eq!(receipts.completed_keys().len(), 2);
}

#[test]
fn concrete_callback_handler_public_wrapper_preserves_default_and_custom_keys() {
    let trace = Arc::new(Mutex::new(Vec::<String>::new()));
    let key: agents_relay_rust2::workflow::effects::KeyCallback =
        Arc::new(|_| Some("custom:1".into()));
    let wrapper = CallbackWorkflowEffectHandler::with_key(
        "effect.launchTask",
        callback("wrapper", Arc::clone(&trace), None),
        key,
    );
    assert_eq!(
        wrapper.idempotency_key(&json!({"jobId":"42","transitionKey":"t"})),
        "custom:1"
    );
    drive(wrapper.execute(&json!({"jobId":"42"}))).unwrap();
    let executor = WorkflowEffectExecutor::with_memory(vec![wrapper.into_handler()]).unwrap();
    let first = drive(executor.execute(
        &["effect.launchTask".into()],
        &json!({"jobId":"42","transitionKey":"t"}),
        None,
    ))
    .unwrap();
    assert_eq!(first[0]["key"], "custom:1");
    assert_eq!(trace.lock().unwrap().as_slice(), &["wrapper", "wrapper"]);
}

#[test]
fn same_explicit_key_suppresses_execution_even_across_different_handlers() {
    let trace = Arc::new(Mutex::new(Vec::<String>::new()));
    let key: agents_relay_rust2::workflow::effects::KeyCallback =
        Arc::new(|_| Some("fixed-one".into()));
    let first = WorkflowEffectHandler::with_key(
        "effect.launchTask",
        callback("launch", Arc::clone(&trace), None),
        Arc::clone(&key),
    );
    let second = WorkflowEffectHandler::with_key(
        "effect.cleanupJobWorktree",
        callback("cleanup", Arc::clone(&trace), None),
        key,
    );
    let executor = WorkflowEffectExecutor::with_memory(vec![first, second]).unwrap();
    let effects = [
        "effect.launchTask".into(),
        "effect.cleanupJobWorktree".into(),
    ];
    let outcomes = drive(executor.execute(
        &effects,
        &json!({"jobId":"1","transitionKey":"finish"}),
        None,
    ))
    .unwrap();
    assert_eq!(outcomes[0]["status"], "completed");
    assert_eq!(outcomes[1]["status"], "deduplicated");
    assert_eq!(trace.lock().unwrap().as_slice(), &["launch"]);
}

#[test]
fn failed_effects_are_not_receipted_and_observation_includes_retry_classification() {
    let records = Arc::new(Mutex::new(Vec::<Value>::new()));
    set_observability(RelayObservability::new(
        collect_observations(Arc::clone(&records)),
        "debug",
    ));
    let trace = Arc::new(Mutex::new(Vec::new()));
    let error = WorkflowEffectError {
        value: json!({"message":"rate limit reached","status":429}),
        is_error: true,
    };
    let handler =
        WorkflowEffectHandler::new("effect.launchTask", callback("launch", trace, Some(error)));
    let receipts = Arc::new(MemoryWorkflowEffectReceiptStore::new());
    let executor = WorkflowEffectExecutor::new(
        vec![handler],
        Arc::clone(&receipts) as Arc<dyn WorkflowEffectReceiptStore>,
    )
    .unwrap();
    let effects = ["effect.launchTask".into()];
    let output = drive(executor.execute(
        &effects,
        &json!({"jobId":"OBSERVABILITY-EFFECT-FAILURE-UNIQUE-01","taskId":"100","transitionKey":"start"}),
        None,
    ))
    .unwrap();
    assert_eq!(output[0]["status"], "failed");
    assert_eq!(output[0]["error"], "rate limit reached");
    assert!(receipts.completed_keys().is_empty());
    // Cargo runs native tests in parallel. Other fixture tasks may emit to the
    // temporary global sink; only the verified Job/Task is in our namespace.
    let recorded = records
        .lock()
        .unwrap()
        .iter()
        .filter(|row| {
            row["correlation"]["jobId"] == "OBSERVABILITY-EFFECT-FAILURE-UNIQUE-01"
                && row["data"]["effect"] == "effect.launchTask"
        })
        .cloned()
        .collect::<Vec<_>>();
    assert_eq!(recorded.len(), 1);
    assert_eq!(recorded[0]["data"]["classification"], "transient");
    assert_eq!(
        recorded[0]["correlation"]["jobId"],
        "OBSERVABILITY-EFFECT-FAILURE-UNIQUE-01"
    );
    assert_eq!(recorded[0]["event"], "workflow.effect.failed");
    set_observability(RelayObservability::silent());
}

#[test]
fn rejecting_completed_outcome_emits_failed_after_success_and_preserves_receipt() {
    let trace = Arc::new(Mutex::new(Vec::<String>::new()));
    let handler = WorkflowEffectHandler::new(
        "effect.launchTask",
        callback("launch", Arc::clone(&trace), None),
    );
    let receipts = Arc::new(MemoryWorkflowEffectReceiptStore::new());
    let executor = WorkflowEffectExecutor::new(
        vec![handler],
        Arc::clone(&receipts) as Arc<dyn WorkflowEffectReceiptStore>,
    )
    .unwrap();
    let on_outcome: OutcomeCallback = Arc::new(|value| {
        let fail = value["status"] == "completed";
        Box::pin(async move {
            if fail {
                Err(WorkflowEffectError::new("onOutcome rejected"))
            } else {
                Ok(())
            }
        })
    });
    let effects = ["effect.launchTask".into()];
    let context = json!({"jobId":"20","transitionKey":"start"});
    let output = drive(executor.execute(&effects, &context, Some(&on_outcome))).unwrap();
    assert_eq!(output.len(), 2);
    assert_eq!(output[0]["status"], "completed");
    assert_eq!(output[1]["status"], "failed");
    assert_eq!(output[1]["error"], "onOutcome rejected");
    assert_eq!(receipts.completed_keys().len(), 1);
    let dedup = drive(executor.execute(&effects, &context, None)).unwrap();
    assert_eq!(dedup[0]["status"], "deduplicated");
    assert_eq!(trace.lock().unwrap().as_slice(), &["launch"]);
}

#[test]
fn missing_handler_is_fatal_without_fabricating_successful_effects() {
    let executor = WorkflowEffectExecutor::with_memory(Vec::new()).unwrap();
    let result = drive(executor.execute(
        &["effect.launchTask".into()],
        &json!({"jobId":"30","transitionKey":"t"}),
        None,
    ));
    assert_eq!(
        result.unwrap_err().display(),
        "No workflow effect handler registered for effect.launchTask"
    );
}

struct FailOnceReceiptStore {
    inner: MemoryWorkflowEffectReceiptStore,
    failed: Mutex<bool>,
}
impl WorkflowEffectReceiptStore for FailOnceReceiptStore {
    fn has<'a>(&'a self, key: &'a str) -> ReceiptFuture<'a, bool> {
        self.inner.has(key)
    }
    fn mark_completed<'a>(&'a self, key: &'a str) -> ReceiptFuture<'a, ()> {
        Box::pin(async move {
            let fail_once = {
                let mut failed = self.failed.lock().unwrap();
                if !*failed {
                    *failed = true;
                    true
                } else {
                    false
                }
            };
            if fail_once {
                return Err(WorkflowEffectError::new("mark receipt failed"));
            }
            self.inner.mark_completed(key).await
        })
    }
}
#[test]
fn receipt_write_failure_is_retried_with_same_key_on_next_execution() {
    let trace = Arc::new(Mutex::new(Vec::<String>::new()));
    let handler = WorkflowEffectHandler::new(
        "effect.launchTask",
        callback("launch", Arc::clone(&trace), None),
    );
    let receipts = Arc::new(FailOnceReceiptStore {
        inner: MemoryWorkflowEffectReceiptStore::new(),
        failed: Mutex::new(false),
    });
    let executor = WorkflowEffectExecutor::new(
        vec![handler],
        Arc::clone(&receipts) as Arc<dyn WorkflowEffectReceiptStore>,
    )
    .unwrap();
    let effects = ["effect.launchTask".into()];
    let context = json!({"jobId":"1","transitionKey":"retry"});
    assert_eq!(
        drive(executor.execute(&effects, &context, None)).unwrap()[0]["status"],
        "failed"
    );
    assert_eq!(
        drive(executor.execute(&effects, &context, None)).unwrap()[0]["status"],
        "completed"
    );
    assert_eq!(
        drive(executor.execute(&effects, &context, None)).unwrap()[0]["status"],
        "deduplicated"
    );
    assert_eq!(trace.lock().unwrap().as_slice(), &["launch", "launch"]);
}
