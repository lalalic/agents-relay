// Native Rust regression for Node src/local-commit-events.ts: listener ordering, Set semantics, reentrant unsubscribe and deep-clone isolation.
use agents_relay_rust2::local_commit_events::{LocalCommitBus, LocalCommitListener};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
#[test]
fn listeners_receive_independent_deep_clones_and_do_not_change_the_committed_value() {
    let bus = LocalCommitBus::new();
    let log = Arc::new(Mutex::new(Vec::<Value>::new()));
    let first: LocalCommitListener = Arc::new(|mut job| {
        job["tasks"][0]["id"] = json!("tampered");
    });
    bus.subscribe(first);
    let output = Arc::clone(&log);
    bus.subscribe(Arc::new(move |job| output.lock().unwrap().push(job)));
    let durable = json!({"id":"job-12","tasks":[{"id":"task-99","metadata":{"nested":true}}]});
    bus.publish(&durable);
    assert_eq!(durable["tasks"][0]["id"], "task-99");
    assert_eq!(log.lock().unwrap()[0]["tasks"][0]["id"], "task-99");
}
#[test]
fn subscribing_identical_listener_twice_is_a_set_and_unsubscribing_is_idempotent() {
    let bus = LocalCommitBus::new();
    let records = Arc::new(Mutex::new(0u32));
    let counter = Arc::clone(&records);
    let listener: LocalCommitListener = Arc::new(move |_| *counter.lock().unwrap() += 1);
    let first = bus.subscribe(Arc::clone(&listener));
    let duplicate = bus.subscribe(listener);
    assert_eq!(first, duplicate);
    bus.publish(&json!({"id":"1"}));
    assert_eq!(*records.lock().unwrap(), 1);
    bus.unsubscribe(first);
    bus.unsubscribe(first);
    bus.publish(&json!({"id":"1"}));
    assert_eq!(*records.lock().unwrap(), 1);
}
#[test]
fn reentrant_listener_removes_another_and_registers_a_new_listener_in_current_iteration() {
    let bus = Arc::new(LocalCommitBus::new());
    let log = Arc::new(Mutex::new(Vec::<String>::new()));
    let target = Arc::new(Mutex::new(None::<u64>));
    let bus_copy = Arc::clone(&bus);
    let log_first = Arc::clone(&log);
    let target_copy = Arc::clone(&target);
    bus.subscribe(Arc::new(move |_| {
        log_first.lock().unwrap().push("first".into());
        if let Some(id) = *target_copy.lock().unwrap() {
            bus_copy.unsubscribe(id);
        }
        let log_next = Arc::clone(&log_first);
        bus_copy.subscribe(Arc::new(move |_| {
            log_next.lock().unwrap().push("added".into())
        }));
    }));
    let log_second = Arc::clone(&log);
    let second = bus.subscribe(Arc::new(move |_| {
        log_second.lock().unwrap().push("removed".into())
    }));
    *target.lock().unwrap() = Some(second);
    bus.publish(&json!({"id":"j"}));
    assert_eq!(*log.lock().unwrap(), vec!["first", "added"]);
}
#[test]
fn subscriber_panic_propagates_and_cannot_mutate_caller_owned_committed_snapshot() {
    let bus = LocalCommitBus::new();
    bus.subscribe(Arc::new(|_job| panic!("subscriber callback failed")));
    let committed = json!({"id":"job-100","state":"COMPLETED"});
    let failure =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| bus.publish(&committed)));
    assert!(failure.is_err());
    assert_eq!(committed["state"], "COMPLETED");
}
