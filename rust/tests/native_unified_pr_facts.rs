// Native Rust regression for Node src/unified-pr-facts.ts: independent Job scopes and non-regressing SQLite PR observations.
use agents_relay_rust2::unified_pr_facts::save_unified_pull_request_facts;
use rusqlite::{params, Connection};
use serde_json::json;
fn db() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("PRAGMA foreign_keys=ON;CREATE TABLE source_registry(job_id TEXT PRIMARY KEY);CREATE TABLE pull_request_facts(
        scope_job_id TEXT NOT NULL REFERENCES source_registry(job_id),id INTEGER NOT NULL CHECK(id=1),state TEXT NOT NULL CHECK(state IN ('OPEN','MERGED','CLOSED')),
        head_ref TEXT,head_sha TEXT,observed_at TEXT NOT NULL,PRIMARY KEY(scope_job_id,id));").unwrap();
    for id in ["1", "2"] {
        db.execute("INSERT INTO source_registry VALUES(?)", params![id])
            .unwrap();
    }
    db
}
fn state(db: &Connection, job: &str) -> (String, Option<String>, Option<String>, String) {
    db.query_row(
        "SELECT state,head_ref,head_sha,observed_at FROM pull_request_facts WHERE scope_job_id=?",
        params![job],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )
    .unwrap()
}
#[test]
fn older_observation_cannot_overwrite_newer_open_or_reopen_closed_merge() {
    let db = db();
    save_unified_pull_request_facts(
        &db,
        "1",
        &json!({"state":"OPEN","head":{"ref":"feature","sha":"001"},"observedAt":"2026-11-14"}),
    )
    .unwrap();
    save_unified_pull_request_facts(
        &db,
        "1",
        &json!({"state":"MERGED","head":{"ref":"main","sha":"002"},"observedAt":"2026-11-16"}),
    )
    .unwrap();
    save_unified_pull_request_facts(
        &db,
        "1",
        &json!({"state":"OPEN","head":{"ref":"feature","sha":"003"},"observedAt":"2026-11-17"}),
    )
    .unwrap();
    save_unified_pull_request_facts(
        &db,
        "1",
        &json!({"state":"CLOSED","observedAt":"2026-11-18"}),
    )
    .unwrap();
    assert_eq!(
        state(&db, "1"),
        (
            "MERGED".into(),
            Some("main".into()),
            Some("002".into()),
            "2026-11-16".into()
        )
    );
    save_unified_pull_request_facts(&db, "2", &json!({"state":"OPEN","observedAt":"2026-11-18"}))
        .unwrap();
    assert_eq!(state(&db, "2").0, "OPEN");
}
#[test]
fn closed_may_merge_but_never_reopen_and_equal_timestamp_is_allowed() {
    let db = db();
    save_unified_pull_request_facts(
        &db,
        "1",
        &json!({"state":"CLOSED","observedAt":"2026-11-14"}),
    )
    .unwrap();
    save_unified_pull_request_facts(&db, "1", &json!({"state":"OPEN","observedAt":"2026-11-16"}))
        .unwrap();
    assert_eq!(state(&db, "1").0, "CLOSED");
    save_unified_pull_request_facts(
        &db,
        "1",
        &json!({"state":"MERGED","observedAt":"2026-11-16"}),
    )
    .unwrap();
    assert_eq!(state(&db, "1").0, "MERGED");
    save_unified_pull_request_facts(
        &db,
        "1",
        &json!({"state":"MERGED","head":{"sha":"new"},"observedAt":"2026-11-16"}),
    )
    .unwrap();
    assert_eq!(state(&db, "1").2.as_deref(), Some("new"));
}
#[test]
fn unknown_job_and_invalid_state_do_not_mutate_existing_sqlite_facts() {
    let db = db();
    save_unified_pull_request_facts(&db, "1", &json!({"state":"OPEN","observedAt":"2026-11-16"}))
        .unwrap();
    assert!(save_unified_pull_request_facts(
        &db,
        "missing",
        &json!({"state":"OPEN","observedAt":"2026-11-16"})
    )
    .is_err());
    assert!(save_unified_pull_request_facts(
        &db,
        "1",
        &json!({"state":"INVALID","observedAt":"2026-11-17"})
    )
    .is_err());
    assert_eq!(state(&db, "1").0, "OPEN");
}
