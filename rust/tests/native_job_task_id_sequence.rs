// Native Rust regression for Node src/job-task-id-sequence.ts: global positive decimal IDs, WAL allocation and concurrent SQLite uniqueness.
use agents_relay_rust2::job_task_id_sequence::{allocate_entity_id, is_generated_entity_id};
use rusqlite::{params, Connection};
use std::{
    collections::HashSet,
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::{SystemTime, UNIX_EPOCH},
};
fn temp() -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let ns = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "r2-seq-native-{}-{ns}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}
#[test]
fn generated_id_grammar_is_strict_positive_decimal_without_leading_zero() {
    for id in ["1", "123", "99999999999999999999999999"] {
        assert!(is_generated_entity_id(id, "any", "task"));
    }
    for id in ["", "0", "01", "-1", "+1", "1.0", "١", "3 ", "1\n", "abc"] {
        assert!(!is_generated_entity_id(id, "any", "job"));
    }
}
#[test]
fn uses_global_job_and_task_high_water_and_distinct_idempotency_domains() {
    let dir = temp();
    let jobs = dir.join("jobs");
    let mut occupied = HashSet::new();
    assert_eq!(
        allocate_entity_id(&jobs, "repo-a", "job", None, &occupied).unwrap(),
        "1"
    );
    assert_eq!(
        allocate_entity_id(&jobs, "repo-b", "job", None, &occupied).unwrap(),
        "2"
    );
    assert_eq!(
        allocate_entity_id(&jobs, "repo-a", "task", Some("key"), &occupied).unwrap(),
        "1"
    );
    assert_eq!(
        allocate_entity_id(&jobs, "repo-b", "task", Some("key"), &occupied).unwrap(),
        "2"
    );
    // Same repository key still dedupes without consuming an extra global ID.
    assert_eq!(
        allocate_entity_id(&jobs, "repo-a", "task", Some("key"), &occupied).unwrap(),
        "1"
    );
    assert_eq!(
        allocate_entity_id(&jobs, "repo-a", "job", Some("key"), &occupied).unwrap(),
        "3"
    );
    assert_eq!(
        allocate_entity_id(&jobs, "repo-b", "job", Some("key"), &occupied).unwrap(),
        "4"
    );
    occupied.insert("5".to_string());
    assert_eq!(
        allocate_entity_id(&jobs, "repo-a", "job", None, &occupied).unwrap(),
        "6"
    );
    let db = Connection::open(dir.join("relay.sqlite")).unwrap();
    let max: i64 = db
        .query_row(
            "SELECT value FROM sequences WHERE repository='*' AND kind='job'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(max, 6);
    drop(db);
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn scans_historic_snapshots_and_ignores_malformed_legacy_json() {
    let dir = temp();
    let jobs = dir.join("jobs");
    let db = Connection::open(dir.join("relay.sqlite")).unwrap();
    db.execute_batch("CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT);")
        .unwrap();
    for (id, data) in [
        ("9", r#"{"id":"99","tasks":[{"id":"501"},{"id":"503"}]}"#),
        ("10", "{corrupt"),
    ] {
        db.execute("INSERT INTO job_snapshot VALUES(?,?)", params![id, data])
            .unwrap();
    }
    drop(db);
    assert_eq!(
        allocate_entity_id(&jobs, "repo", "job", None, &HashSet::new()).unwrap(),
        "100"
    );
    assert_eq!(
        allocate_entity_id(&jobs, "repo", "task", None, &HashSet::new()).unwrap(),
        "504"
    );
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn immediate_transactions_prevent_duplicate_ids_under_concurrent_allocations() {
    let dir = temp();
    let jobs = dir.join("jobs");
    let handles = (0..8)
        .map(|_| {
            let path = jobs.clone();
            thread::spawn(move || {
                (0..4)
                    .map(|_| {
                        allocate_entity_id(&path, "repo", "task", None, &HashSet::new()).unwrap()
                    })
                    .collect::<Vec<_>>()
            })
        })
        .collect::<Vec<_>>();
    let ids = handles
        .into_iter()
        .flat_map(|handle| handle.join().unwrap())
        .collect::<HashSet<_>>();
    assert_eq!(
        ids.len(),
        32,
        "SQLite BEGIN IMMEDIATE must serialize all 32 allocations"
    );
    assert!(ids.contains("1") && ids.contains("32"));
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn validates_context_and_idempotency_key_before_creating_any_db() {
    let dir = temp();
    let jobs = dir.join("jobs");
    assert_eq!(
        allocate_entity_id(&jobs, "", "task", None, &HashSet::new()).unwrap_err(),
        "Task ID allocation requires a repository context"
    );
    assert_eq!(
        allocate_entity_id(&jobs, "repo", "task", Some(""), &HashSet::new()).unwrap_err(),
        "Invalid idempotency key"
    );
    assert_eq!(
        allocate_entity_id(
            &jobs,
            "repo",
            "task",
            Some(&"a".repeat(513)),
            &HashSet::new()
        )
        .unwrap_err(),
        "Invalid idempotency key"
    );
    assert!(!dir.join("relay.sqlite").exists());
    fs::remove_dir_all(dir).unwrap();
}
