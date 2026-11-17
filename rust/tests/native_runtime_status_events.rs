// Native Node src/runtime-status-events.ts: first observation is baseline, repeated status is deduped and repository is part of identity.
use agents_relay_rust2::runtime_status_events::create_runtime_status_publisher;
use serde_json::{json, Value};
use std::{cell::RefCell, rc::Rc};
#[test]
fn baseline_and_unchanged_repeated_status_never_publish() {
    let events = Rc::new(RefCell::new(Vec::<Value>::new()));
    let captured = Rc::clone(&events);
    let mut publisher = create_runtime_status_publisher(move |event| {
        captured.borrow_mut().push(event);
        Ok(())
    });
    let start = json!({"repository":"repo","id":"job","state":"ACTIVE","updatedAt":"2026-11-17T04:00:00Z","tasks":[]});
    publisher.publish(&start);
    publisher.publish(&start);
    assert!(events.borrow().is_empty());
    let queued = json!({"repository":"repo","id":"job","state":"ACTIVE","updatedAt":"2026-11-17T04:01:00Z","tasks":[{"id":"t","state":"QUEUED","kind":"work","agentName":"worker"}]});
    publisher.publish(&queued);
    publisher.publish(&queued);
    assert_eq!(events.borrow().len(), 1);
    assert_eq!(events.borrow()[0]["data"]["from"], "IDLE");
    assert_eq!(events.borrow()[0]["data"]["to"], "QUEUED");
    assert_eq!(events.borrow()[0]["type"], "job.runtime_status.changed");
}
#[test]
fn same_id_in_other_repository_is_independent_and_callback_error_does_not_persist_runtime_status() {
    let count = Rc::new(RefCell::new(0));
    let output = Rc::clone(&count);
    let mut publisher = create_runtime_status_publisher(move |_event| {
        *output.borrow_mut() += 1;
        Err("fixture publication denied".into())
    });
    let base = json!({"repository":"repo-a","id":"j","state":"ACTIVE","tasks":[]});
    let other = json!({"repository":"repo-b","id":"j","state":"COMPLETED","tasks":[]});
    publisher.publish(&base);
    publisher.publish(&other);
    assert_eq!(*count.borrow(), 0);
    publisher.publish(&json!({"repository":"repo-a","id":"j","state":"COMPLETED","tasks":[]}));
    assert_eq!(*count.borrow(), 1);
    assert!(base.get("runtimeStatus").is_none());
}
