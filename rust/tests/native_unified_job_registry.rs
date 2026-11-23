// Native Rust regression for Node src/unified-job-registry.ts: immutable local Git root identity, PR binding and atomic snapshot creation.
use agents_relay_rust2::unified_job_registry::{
    create_unified_job_if_absent, ensure_unified_job_registry,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
fn db() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("CREATE TABLE source_registry(job_id TEXT PRIMARY KEY,source_file TEXT NOT NULL UNIQUE,repository TEXT NOT NULL);CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL);").unwrap();
    db
}
fn job(id: &str, repo: &str, root: &str) -> Value {
    json!({"id":id,"repository":repo,"projectRoot":root,"state":"COMPLETED","tasks":[]})
}
fn write(tx: &rusqlite::Transaction<'_>, job: &Value, now: &str) -> Result<(), String> {
    tx.execute(
        "INSERT INTO job_snapshot VALUES(?,?,?)",
        params![job["id"].as_str(), job.to_string(), now],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}
#[test]
fn repository_binding_is_immutable_and_id_only(){
    let db=db();
    ensure_unified_job_registry(&db,&job("10","local-repo","/repos/local"),"10").unwrap();
    ensure_unified_job_registry(&db,&job("10","local-repo","/repos/local"),"10").unwrap();
    assert!(ensure_unified_job_registry(&db,&job("10","other-repo","/repos/local"),"10")
        .unwrap_err().contains("conflicting repository identity"));
    assert!(ensure_unified_job_registry(&db,&job("10","local-repo","/repos/local"),"11")
        .unwrap_err().contains("Wrong scoped Job ID"));
    let bound:String=db.query_row("SELECT repository FROM source_registry WHERE job_id='10'",
        [],|row|row.get(0)).unwrap();
    assert_eq!(bound,"local-repo");
}
#[test]
fn snapshot_creation_is_idempotent_and_reuses_existing_job_without_mutation() {
    let mut db = db();
    let first = job("9", "repo", "/repos/repo");
    let got =
        create_unified_job_if_absent(&mut db, &first, |tx, now| write(tx, &first, now)).unwrap();
    assert_eq!(got, first);
    let changed = job("9", "other", "/repos/other");
    let second =
        create_unified_job_if_absent(&mut db, &changed, |_, _| Err("should never execute".into()))
            .unwrap();
    assert_eq!(second, first);
    let rows: i64 = db
        .query_row("SELECT COUNT(*) FROM job_snapshot", [], |row| row.get(0))
        .unwrap();
    assert_eq!(rows, 1);
}
#[test]
fn repository_name_collision_with_different_root_fails_before_any_snapshot_write() {
    let mut db = db();
    let first = job("9", "repo", "/repos/a");
    create_unified_job_if_absent(&mut db, &first, |tx, now| write(tx, &first, now)).unwrap();
    let second = job("10", "repo", "/repos/b");
    let err = create_unified_job_if_absent(&mut db, &second, |tx, now| write(tx, &second, now))
        .unwrap_err();
    assert!(err.contains("Local repository identity collision"));
    let missing: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM job_snapshot WHERE job_id='10'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(missing, 0);
}
#[test]
fn callback_write_failure_rolls_back_and_allows_clean_retry() {
    let mut db = db();
    let job = job("9", "repo", "/repos/repo");
    assert_eq!(
        create_unified_job_if_absent(&mut db, &job, |_, _| Err("injected write failure".into()))
            .unwrap_err(),
        "injected write failure"
    );
    let pre: Option<String> = db
        .query_row(
            "SELECT json FROM job_snapshot WHERE job_id='9'",
            [],
            |row| row.get(0),
        )
        .optional()
        .unwrap();
    assert!(pre.is_none());
    create_unified_job_if_absent(&mut db, &job, |tx, now| write(tx, &job, now)).unwrap();
    let after: Option<String> = db
        .query_row(
            "SELECT json FROM job_snapshot WHERE job_id='9'",
            [],
            |row| row.get(0),
        )
        .optional()
        .unwrap();
    assert!(after.is_some());
}
#[test]
fn unmigrated_sibling_without_root_blocks_reusing_same_repository() {
    let mut db = db();
    let prior = json!({"id":"5","repository":"repo","tasks":[]});
    db.execute(
        "INSERT INTO job_snapshot VALUES(?,?,?)",
        params!["5", prior.to_string(), "old"],
    )
    .unwrap();
    let next = job("6", "repo", "/repos/repo");
    let error =
        create_unified_job_if_absent(&mut db, &next, |tx, now| write(tx, &next, now)).unwrap_err();
    assert!(error.contains("unmigrated Job 5"));
}
