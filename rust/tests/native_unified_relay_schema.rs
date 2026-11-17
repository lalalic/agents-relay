// Native regression for Node src/unified-relay-schema.ts: complete SQLite contract, constraints, HostInvocation tables and one-time metadata insertion.
use agents_relay_rust2::unified_relay_schema::migrate_unified_relay_schema;
use rusqlite::{params, Connection};
fn db() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    db
}
#[test]
fn complete_authoritative_sqlite_schema_includes_job_task_projection_and_review_receipts() {
    let db = db();
    migrate_unified_relay_schema(&db).unwrap();
    for table in [
        "source_registry",
        "migration_metadata",
        "relay_meta",
        "job_snapshot",
        "pull_request_facts",
        "publication_state",
        "publication_delivery",
        "agent_snapshot",
        "event_receipt",
        "execution_process",
        "host_invocation_event",
        "host_invocation_decision",
        "projection_outbox",
        "projection_receipt",
        "sequences",
        "idempotency",
    ] {
        let rows: i64 = db
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?",
                params![table],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(rows, 1, "missing {table}");
    }
    for index in [
        "source_registry_repo_pr",
        "job_snapshot_updated",
        "projection_unified_due",
        "projection_unified_coalesce",
    ] {
        assert_eq!(
            db.query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='index' AND name=?",
                params![index],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
    }
    assert_eq!(
        db.query_row(
            "SELECT value FROM migration_metadata WHERE key='schema'",
            [],
            |row| row.get::<_, String>(0)
        )
        .unwrap(),
        "single-sqlite-staging-v1"
    );
    assert_eq!(
        db.query_row(
            "SELECT value FROM migration_metadata WHERE key='job_count'",
            [],
            |row| row.get::<_, String>(0)
        )
        .unwrap(),
        "0"
    );
}
#[test]
fn constraint_checks_reject_cross_job_missing_foreign_keys_and_invalid_pr_states() {
    let db = db();
    migrate_unified_relay_schema(&db).unwrap();
    assert!(db.execute("INSERT INTO pull_request_facts(scope_job_id,id,state,observed_at) VALUES ('absent',1,'OPEN','now')",[]).is_err());
    db.execute(
        "INSERT INTO source_registry VALUES ('j1','file1','repo',0)",
        [],
    )
    .unwrap();
    assert!(db.execute("INSERT INTO pull_request_facts(scope_job_id,id,state,observed_at) VALUES ('j1',2,'OPEN','now')",[]).is_err());
    assert!(db.execute("INSERT INTO pull_request_facts(scope_job_id,id,state,observed_at) VALUES ('j1',1,'INVALID','now')",[]).is_err());
    db.execute("INSERT INTO pull_request_facts(scope_job_id,id,state,observed_at) VALUES ('j1',1,'OPEN','now')",[]).unwrap();
    assert!(db
        .execute(
            "INSERT INTO source_registry VALUES('j2','file1','repo',0)",
            []
        )
        .is_err());
    assert!(db.execute("INSERT INTO projection_outbox(scope_job_id,id,idempotency_key,operation,payload_json,created_at,updated_at,status) VALUES ('j1',1,'k','push','{}','now','now','invalid')",[]).is_err());
}
#[test]
fn host_invocation_decisions_have_immutable_fingerprint_and_accepted_outcome_constraints() {
    let db = db();
    migrate_unified_relay_schema(&db).unwrap();
    db.execute("INSERT INTO host_invocation_event VALUES ('j1','t1','e1','i1','exec','1','approved','accepted','fingerprint','now')",[]).unwrap();
    assert!(db.execute("INSERT INTO host_invocation_event VALUES ('j1','t1','e2','i1','exec','1','approved','unapproved','fingerprint','now')",[]).is_err());
    db.execute("INSERT INTO host_invocation_decision VALUES('j1','t1','i1','exec','1','approved',null,'fingerprint','e1','now')",[]).unwrap();
    assert!(db.execute("INSERT INTO host_invocation_decision VALUES('j1','t1','i1','exec','1','approved',null,'fingerprint','e2','now')",[]).is_err());
}
#[test]
fn startup_metadata_is_one_time_and_second_boot_reports_exact_duplicate_constraint() {
    let db = db();
    migrate_unified_relay_schema(&db).unwrap();
    let error = migrate_unified_relay_schema(&db).unwrap_err();
    assert!(error.contains("UNIQUE constraint failed"), "{error}");
    assert_eq!(
        db.query_row("SELECT count(*) FROM migration_metadata", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='job_snapshot'",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
}
