// Native Rust regressions for Node src/observability.ts: failure taxonomy, recursive redaction, structured records and async-scoped correlation.
use agents_relay_rust2::observability::{
    classify_failure, collect_observations, current_observability_correlation, json_wire,
    observability, renderable_observation, sanitize_observation_data, sanitize_observation_value,
    set_observability, with_observability_correlation, with_observability_correlation_future,
    RelayObservability,
};
use serde_json::{json, Value};
use std::{
    future::{poll_fn, Future},
    pin::pin,
    sync::{Arc, Mutex},
    task::{Context, Poll, Waker},
};

#[test]
fn failure_taxonomy_prioritizes_conflict_before_transient_retries() {
    let conflict = json!({"message":"Task already exists with a different definition","status":503,"retryAfter":3});
    let result = classify_failure(&conflict, false);
    assert_eq!(result["classification"], "conflict");
    assert_eq!(result["status"], 503);
    assert_eq!(result["retryAfterMs"], 3000);
    assert_eq!(
        classify_failure(&json!({"message":"ECONNRESET"}), false)["classification"],
        "transient"
    );
    assert_eq!(
        classify_failure(&json!({"message":"server down","statusCode":504}), false)
            ["classification"],
        "transient"
    );
    assert_eq!(
        classify_failure(&json!({"message":"unexpected"}), false)["classification"],
        "terminal"
    );
}

#[test]
fn redact_secrets_and_bound_depth_arrays_and_bulk_payloads() {
    let long = "x".repeat(700);
    let data = json!({"apiKey":"secret","password":"unsafe","nested":{"Authorization":"secret","ok":"visible"},
      "input":long,"content":"a".repeat(513),"message":"ok", "array":(0..26).collect::<Vec<_>>()});
    let cleaned = sanitize_observation_data(Some(&data)).unwrap();
    assert_eq!(cleaned["apiKey"], "[redacted]");
    assert_eq!(cleaned["password"], "[redacted]");
    assert_eq!(cleaned["nested"]["Authorization"], "[redacted]");
    assert_eq!(cleaned["nested"]["ok"], "visible");
    assert_eq!(cleaned["input"], "[omitted 700 chars]");
    assert_eq!(cleaned["content"], "[omitted 513 chars]");
    assert_eq!(cleaned["array"].as_array().unwrap().len(), 21);
    assert_eq!(cleaned["array"][20], "+6 more");
    let depth = json!({"a":{"b":{"c":{"d":{"e":1}}}}});
    assert_eq!(
        sanitize_observation_value(&depth, 0)["a"]["b"]["c"]["d"],
        "[truncated]"
    );
}

#[test]
fn unicode_at_js_utf16_limit_is_preserved_on_wire_even_with_a_lone_surrogate() {
    let content = format!("{}🙂suffix", "A".repeat(511));
    let sanitized = sanitize_observation_value(&json!(content), 0);
    let wire = json_wire(&sanitized);
    assert!(wire.contains("\\ud83d"));
    assert!(!wire.contains("\\ufffd"));
    assert!(wire.ends_with("…(+7)\""));
    let native = renderable_observation(&sanitized);
    assert!(native.as_str().unwrap().contains('�'));
}

#[test]
fn nested_correlation_restores_outer_state_even_after_unwind() {
    assert_eq!(current_observability_correlation(), json!({}));
    with_observability_correlation(&json!({"jobId":"42","taskId":"1"}), || {
        assert_eq!(current_observability_correlation()["taskId"], "1");
        with_observability_correlation(&json!({"taskId":"2","executionId":"run"}), || {
            assert_eq!(current_observability_correlation()["taskId"], "2");
            assert_eq!(current_observability_correlation()["jobId"], "42");
        });
        assert_eq!(current_observability_correlation()["taskId"], "1");
        let failed = std::panic::catch_unwind(|| {
            with_observability_correlation(&json!({"taskId":"3"}), || panic!("deliberate unwind"))
        });
        assert!(failed.is_err());
        assert_eq!(current_observability_correlation()["taskId"], "1");
    });
    assert_eq!(current_observability_correlation(), json!({}));
}

#[test]
fn interleaved_futures_never_share_their_async_local_execution_ids() {
    // Both futures are polled on the same OS thread in alternating order.
    // Correlation must be restored after every pending poll.
    let trace = Arc::new(Mutex::new(Vec::<Value>::new()));
    let make = |name: &'static str, trace: Arc<Mutex<Vec<Value>>>| {
        let mut polls = 0;
        poll_fn(move |_cx| {
            polls += 1;
            trace
                .lock()
                .unwrap()
                .push(current_observability_correlation());
            if polls == 1 {
                Poll::Pending
            } else {
                Poll::Ready(name)
            }
        })
    };
    let mut one = pin!(with_observability_correlation_future(
        &json!({"jobId":"42","taskId":"1"}),
        make("one", Arc::clone(&trace))
    ));
    let mut two = pin!(with_observability_correlation_future(
        &json!({"jobId":"42","taskId":"2"}),
        make("two", Arc::clone(&trace))
    ));
    let mut cx = Context::from_waker(Waker::noop());
    assert_eq!(one.as_mut().poll(&mut cx), Poll::Pending);
    assert_eq!(current_observability_correlation(), json!({}));
    assert_eq!(two.as_mut().poll(&mut cx), Poll::Pending);
    assert_eq!(current_observability_correlation(), json!({}));
    assert_eq!(one.as_mut().poll(&mut cx), Poll::Ready("one"));
    assert_eq!(two.as_mut().poll(&mut cx), Poll::Ready("two"));
    let events = trace.lock().unwrap().clone();
    assert_eq!(events.len(), 4);
    assert_eq!(
        events
            .iter()
            .map(|row| row["taskId"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["1", "2", "1", "2"]
    );
    assert_eq!(current_observability_correlation(), json!({}));
}

#[test]
fn observer_sink_only_emits_selected_levels_and_never_changes_sqlite() {
    let rows = Arc::new(Mutex::new(Vec::<Value>::new()));
    let sink = collect_observations(Arc::clone(&rows));
    let observer = RelayObservability::new(sink, "warn");
    assert!(!observer.is_enabled("info"));
    assert!(observer.is_enabled("error"));
    with_observability_correlation(&json!({"repository":"local","jobId":"42"}), || {
        observer.record_at(
            &json!({"stage":"graph","event":"none","message":"no transition","level":"info"}),
            "2026-11-16T18:00:00.000Z",
        );
        observer.record_at(
            &json!({"stage":"projection","event":"retry","message":"failed","level":"warn",
            "correlation":{"taskId":"10"},"data":{"password":"NEVER_PRINT","attempt":2}}),
            "2026-11-16T18:00:01.000Z",
        );
    });
    let log = rows.lock().unwrap().clone();
    assert_eq!(log.len(), 1);
    assert_eq!(log[0]["ts"], "2026-11-16T18:00:01.000Z");
    assert_eq!(log[0]["correlation"]["jobId"], "42");
    assert_eq!(log[0]["correlation"]["taskId"], "10");
    assert_eq!(log[0]["data"]["password"], "[redacted]");
    set_observability(RelayObservability::silent());
    assert!(!observability().is_enabled("info"));
    set_observability(RelayObservability::silent());
}
