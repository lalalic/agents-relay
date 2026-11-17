// Native L3 resource tests: temp SQLite only, no browser or user session.
use agents_relay_rust2::{
    browser_worker_pool::{BrowserPoolOptions, BrowserWorkerPoolManager},
    browser_worker_pool_graph::{
        monitor_pool_decision, pool_decision, progress_pool_decision, require_pool_decision,
    },
};
use serde_json::json;
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};
fn path() -> PathBuf {
    std::env::temp_dir().join(format!(
        "rust2-browser-pool-{}-{}.sqlite",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}
fn manager(path: &Path, capacity: i64, queue_ms: i64) -> BrowserWorkerPoolManager {
    BrowserWorkerPoolManager::open(BrowserPoolOptions {
        path: Some(path.to_path_buf()),
        capacity,
        queue_wait_ms: queue_ms,
        poll_ms: 4,
        ..Default::default()
    })
    .unwrap()
}
#[test]
fn graph_uses_actual_canonical_mermaid_for_every_action() {
    let cases = [
        ("AVAILABLE", "pool.claim", true, "LEASED", "assign"),
        ("AVAILABLE", "pool.claim", false, "AVAILABLE", "reject"),
        ("WAITING", "pool.claim", true, "LEASED", "assign"),
        ("WAITING", "pool.claim", false, "WAITING", "reject"),
        ("AVAILABLE", "pool.enqueue", true, "WAITING", "enqueue"),
        ("WAITING", "pool.cancel", true, "AVAILABLE", "dequeue"),
        ("WAITING", "pool.expired", true, "AVAILABLE", "dequeue"),
        ("WAITING", "pool.unavailable", true, "AVAILABLE", "dequeue"),
        ("LEASED", "pool.sessionBound", true, "LEASED", "bindSession"),
        ("LEASED", "pool.threadBound", true, "LEASED", "bindThread"),
        ("LEASED", "pool.activity", true, "LEASED", "touch"),
        (
            "LEASED",
            "pool.terminalVerified",
            true,
            "AVAILABLE",
            "release",
        ),
        (
            "LEASED",
            "pool.outcomeUnknown",
            true,
            "QUARANTINED",
            "quarantine",
        ),
        (
            "QUARANTINED",
            "pool.outcomeUnknown",
            true,
            "QUARANTINED",
            "keepQuarantine",
        ),
        (
            "QUARANTINED",
            "pool.stopVerified",
            true,
            "AVAILABLE",
            "releaseQuarantine",
        ),
    ];
    for (state, event, healthy, target, action) in cases {
        let v = require_pool_decision(state, event, action, healthy).unwrap();
        assert_eq!(v["target"], target);
    }
    for (state, event) in [
        ("AVAILABLE", "pool.terminalVerified"),
        ("LEASED", "pool.claim"),
        ("QUARANTINED", "pool.terminalVerified"),
    ] {
        assert_eq!(
            pool_decision(state, event, &json!({"providerHealthy":true})).unwrap()["accepted"],
            false
        );
    }
    assert!(
        require_pool_decision("QUARANTINED", "pool.claim", "assign", true)
            .unwrap_err()
            .contains("rejected")
    );
    assert_eq!(monitor_pool_decision(true).unwrap(), "recoverTurn");
    assert_eq!(monitor_pool_decision(false).unwrap(), "keepMonitoring");
    assert_eq!(progress_pool_decision(true).unwrap(), "extendTimeout");
    assert_eq!(progress_pool_decision(false).unwrap(), "keepMonitoring");
}
#[test]
fn sqlite_fences_generations_and_preserves_quarantine_across_restart() {
    let file = path();
    let mut one = manager(&file, 1, 50);
    let mut first = one.acquire("chatgpt", "execution-one", None).unwrap();
    assert_eq!(first.generation, 1);
    assert_eq!(one.snapshot("z").unwrap().idle, 1);
    assert!(one
        .acquire("chatgpt", "execution-one", None)
        .unwrap_err()
        .message
        .contains("already owns"));
    assert!(one
        .bind_thread(&mut first, "https://evil.example/c/abc")
        .unwrap_err()
        .message
        .contains("Unsafe"));
    one.bind_session(&mut first, "session-one").unwrap();
    one.bind_thread(
        &mut first,
        "https://chatgpt.com/c/thread-01?utm=untrusted#fragment",
    )
    .unwrap();
    assert_eq!(
        first.thread_url.as_deref(),
        Some("https://chatgpt.com/c/thread-01")
    );
    drop(one);
    let mut restarted = manager(&file, 1, 50);
    assert_eq!(restarted.snapshot("chatgpt").unwrap().leased, 1);
    assert_eq!(
        restarted.acquire("chatgpt", "new", None).unwrap_err().code,
        Some("POOL_WAIT_EXPIRED")
    );
    restarted.quarantine(&first).unwrap();
    restarted.quarantine(&first).unwrap();
    assert_eq!(restarted.snapshot("chatgpt").unwrap().quarantined, 1);
    assert!(restarted
        .release(&first)
        .unwrap_err()
        .message
        .contains("Stale"));
    assert!(restarted
        .release_quarantine(&first, false)
        .unwrap_err()
        .message
        .contains("verification"));
    restarted.release_quarantine(&first, true).unwrap();
    let second = restarted.acquire("chatgpt", "new", None).unwrap();
    assert!(second.generation > first.generation);
    assert!(restarted
        .release(&first)
        .unwrap_err()
        .message
        .contains("Stale"));
    restarted.release(&second).unwrap();
    assert_eq!(restarted.snapshot("chatgpt").unwrap().idle, 1);
    drop(restarted);
    let _ = std::fs::remove_file(&file);
}
#[test]
fn fifo_waiters_outage_and_abort_only_own_queue() {
    let file = path();
    let mut first = manager(&file, 1, 180);
    let owner = first.acquire("z", "owner", None).unwrap();
    let mut pending = manager(&file, 1, 180);
    let cancelled = Arc::new(AtomicBool::new(false));
    let cloned = Arc::clone(&cancelled);
    let handle = thread::spawn(move || pending.acquire("z", "waiter", Some(&cloned)));
    thread::sleep(Duration::from_millis(45));
    assert_eq!(first.snapshot("z").unwrap().queued, 1);
    cancelled.store(true, Ordering::Release);
    let err = handle.join().unwrap().unwrap_err();
    assert!(err.message.contains("aborted"));
    assert_eq!(first.snapshot("z").unwrap().queued, 0);
    assert_eq!(first.snapshot("z").unwrap().leased, 1);
    first.report_pre_submission_outage("z", 1000).unwrap();
    assert_eq!(
        first.acquire("z", "blocked", None).unwrap_err().code,
        Some("PROVIDER_UNAVAILABLE")
    );
    assert_eq!(first.snapshot("chatgpt").unwrap().health, "HEALTHY");
    first.report_healthy("z").unwrap();
    first.release(&owner).unwrap();
    let next = first.acquire("z", "next", None).unwrap();
    first.release(&next).unwrap();
    drop(first);
    let _ = std::fs::remove_file(&file);
}
#[test]
fn two_process_style_managers_respect_fifo_and_queued_capacity() {
    use std::sync::mpsc;
    let file = path();
    let mut root = manager(&file, 1, 800);
    let owner = root.acquire("chatgpt", "owner", None).unwrap();
    let (first_claim_tx, first_claim_rx) = mpsc::channel();
    let (first_release_tx, first_release_rx) = mpsc::channel();
    let first_path = file.clone();
    let first = thread::spawn(move || {
        let mut pool = manager(&first_path, 1, 800);
        let claim = pool.acquire("chatgpt", "first", None).unwrap();
        first_claim_tx.send(claim.slot).unwrap();
        first_release_rx.recv().unwrap();
        pool.release(&claim).unwrap();
    });
    thread::sleep(Duration::from_millis(55));
    let (second_claim_tx, second_claim_rx) = mpsc::channel();
    let second_path = file.clone();
    let second = thread::spawn(move || {
        let mut pool = manager(&second_path, 1, 800);
        let claim = pool.acquire("chatgpt", "second", None).unwrap();
        second_claim_tx.send(claim.slot).unwrap();
        pool.release(&claim).unwrap();
    });
    thread::sleep(Duration::from_millis(55));
    assert_eq!(root.snapshot("chatgpt").unwrap().queued, 2);
    root.release(&owner).unwrap();
    assert_eq!(
        first_claim_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
        1
    );
    assert!(
        second_claim_rx
            .recv_timeout(Duration::from_millis(80))
            .is_err(),
        "second waiter skipped queue head"
    );
    first_release_tx.send(()).unwrap();
    assert_eq!(
        second_claim_rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap(),
        1
    );
    first.join().unwrap();
    second.join().unwrap();
    assert_eq!(root.snapshot("chatgpt").unwrap().queued, 0);
    assert_eq!(root.snapshot("chatgpt").unwrap().idle, 1);
    drop(root);
    let _ = std::fs::remove_file(file);
}
