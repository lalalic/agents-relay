// Native Rust regression for Node src/legacy-blocked-task-migration.ts: selective legacy state rewrites and unchanged durable event history.
use agents_relay_rust2::legacy_blocked_task_migration::{
    migrate_legacy_blocked_tasks, normalize_legacy_task_lifecycle,
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
#[test]
fn unblocked_worker_fails_for_recovery_but_troubleshooter_requeues() {
    let worker = json!({"id":"t1","state":"UNBLOCKED","agentName":"editor","attempt":4,"maxAttempts":1,"unblock":{"source":"review"}});
    let fixed = normalize_legacy_task_lifecycle(&worker);
    assert_eq!(fixed["state"], "FAILED");
    assert_eq!(
        fixed["failureReason"],
        "legacy_unblocked_task_requires_recovery"
    );
    assert_eq!(fixed["maxAttempts"], 5);
    assert_eq!(fixed["unblock"]["event"], "task.unblocked");
    assert_eq!(
        worker["state"], "UNBLOCKED",
        "original Job snapshot is not mutated by the pure normalizer"
    );
    let troubleshooter = json!({"id":"t2","state":"UNBLOCKED","agentName":"troubleshooter","attempt":0,"maxAttempts":0});
    let fixed = normalize_legacy_task_lifecycle(&troubleshooter);
    assert_eq!(fixed["state"], "QUEUED");
    assert_eq!(fixed["maxAttempts"], 3);
}
#[test]
fn interactive_draft_wait_is_not_confused_with_ordinary_dependency_hold() {
    let waiting = json!({"state":"DRAFT","attempt":1,"updatedAt":"2026-11-16T21:00:00Z",
  "interactiveInvocation":{"status":"awaiting_decision","boundAt":"2026-11-16T20:00:00Z"}});
    assert_eq!(
        normalize_legacy_task_lifecycle(&waiting)["state"],
        "AWAITING_DECISION"
    );
    let decision = json!({"state":"DRAFT","attempt":1,"updatedAt":"2026-11-16T21:00:00Z",
  "interactiveInvocation":{"status":"decided","boundAt":"2026-11-16T20:00:00Z","decidedAt":"2026-11-16T21:01:00Z"}});
    assert_eq!(
        normalize_legacy_task_lifecycle(&decision)["state"],
        "AWAITING_DECISION"
    );
    let later = json!({"state":"DRAFT","attempt":1,"updatedAt":"2026-11-16T22:00:00Z",
  "interactiveInvocation":{"status":"decided","boundAt":"2026-11-16T20:00:00Z","decidedAt":"2026-11-16T21:01:00Z"}});
    assert_eq!(normalize_legacy_task_lifecycle(&later)["state"], "DRAFT");
}
#[test]
fn blocked_planner_and_troubleshooter_remain_blocked_but_ordinary_worker_fails() {
    for (kind, agent) in [("planner", "worker"), ("task", "troubleshooter")] {
        let task = json!({"state":"BLOCKED","kind":kind,"agentName":agent});
        assert_eq!(normalize_legacy_task_lifecycle(&task)["state"], "BLOCKED");
    }
    let worker = json!({"state":"BLOCKED","kind":"task","agentName":"editor","failureReason":"worker_outcome_unknown"});
    let result = normalize_legacy_task_lifecycle(&worker);
    assert_eq!(result["state"], "FAILED");
    assert_eq!(result["failureReason"], "worker_outcome_unknown");
    assert!(result["error"]
        .as_str()
        .unwrap()
        .contains("pending Troubleshooter diagnosis"));
}
#[test]
fn migration_writes_only_changed_job_snapshots_and_never_touches_append_only_history() {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL);CREATE TABLE event_history(job_id TEXT,payload TEXT); \
     CREATE TABLE updated(job_id TEXT);CREATE TRIGGER changed AFTER UPDATE ON job_snapshot BEGIN INSERT INTO updated VALUES(new.job_id);END;").unwrap();
    let changed = json!({"id":"1","tasks":[{"id":"t1","state":"BLOCKED","kind":"task","agentName":"editor"}]});
    let unchanged = json!({"id":"2","tasks":[{"id":"t2","state":"COMPLETED","kind":"task","agentName":"editor"}]});
    for (id, job) in [("1", changed), ("2", unchanged)] {
        db.execute(
            "INSERT INTO job_snapshot VALUES(?,?)",
            params![id, job.to_string()],
        )
        .unwrap();
    }
    db.execute(
        "INSERT INTO event_history VALUES(?,?)",
        params!["1", "task.blocked event, immutable"],
    )
    .unwrap();
    migrate_legacy_blocked_tasks(&db).unwrap();
    let written: Vec<String> = db
        .prepare("SELECT job_id FROM updated")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(written, vec!["1"]);
    let json_raw: String = db
        .query_row(
            "SELECT json FROM job_snapshot WHERE job_id='1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let new: Value = serde_json::from_str(&json_raw).unwrap();
    assert_eq!(new["tasks"][0]["state"], "FAILED");
    assert_eq!(
        db.query_row("SELECT payload FROM event_history", [], |row| row
            .get::<_, String>(0))
            .unwrap(),
        "task.blocked event, immutable"
    );
}

#[test]
fn unified_sqlite_legacy_migration_is_once_per_database_not_per_job_connection() {
    use agents_relay_rust2::relay_store::SQLiteRelayStore;
    let path=std::env::temp_dir().join(format!(
        "r2-migration-once-{}-{}.sqlite",std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
            .unwrap().as_nanos()));
    let first=SQLiteRelayStore::open(&path,Some("88")).unwrap();
    first.save_job(&json!({"id":"88","repository":"demo","prNumber":0,
        "projectRoot":"/tmp/demo","state":"DRAFT","title":"migration fixture",
        "tasks":[{"id":"89","kind":"task","agentName":"editor","state":"BLOCKED"}],
        "plans":[],"createdAt":"2026-11-21T12:00:00Z",
        "updatedAt":"2026-11-21T12:00:00Z"})).unwrap();
    first.db.execute("DELETE FROM migration_metadata WHERE key='legacy_blocked_tasks_v1'",[]).unwrap();
    first.close().unwrap();
    let migrated=SQLiteRelayStore::open_without_claim_reset(&path,Some("88")).unwrap();
    let fixed=migrated.load_job("88").unwrap().unwrap();
    assert_eq!(fixed["tasks"][0]["state"],"FAILED");
    let marker:String=migrated.db.query_row(
        "SELECT value FROM migration_metadata WHERE key='legacy_blocked_tasks_v1'",
        [],|r|r.get(0)).unwrap();
    assert_eq!(marker,"complete");
    migrated.db.execute_batch("CREATE TABLE migration_write_count(n INTEGER NOT NULL);
        INSERT INTO migration_write_count(n) VALUES(0);
        CREATE TRIGGER migration_write_counter AFTER UPDATE ON job_snapshot
        BEGIN UPDATE migration_write_count SET n=n+1;END;").unwrap();
    migrated.close().unwrap();
    // New opens (including one for a different Job scope) must not parse and
    // rewrite the entire historical inventory. Test an intentionally inserted
    // legacy-shaped snapshot to prove the one-time fence is obeyed.
    let check=SQLiteRelayStore::open_without_claim_reset(&path,Some("88")).unwrap();
    let raw=json!({"id":"88","repository":"demo","prNumber":0,
        "projectRoot":"/tmp/demo","state":"DRAFT","title":"post-migration",
        "tasks":[{"id":"89","kind":"task","agentName":"editor","state":"BLOCKED"}],
        "plans":[]}).to_string();
    check.db.execute("UPDATE job_snapshot SET json=? WHERE job_id='88'",[&raw]).unwrap();
    let before:i64=check.db.query_row(
        "SELECT n FROM migration_write_count",[],|r|r.get(0)).unwrap();
    check.close().unwrap();
    for _ in 0..4 {
        let opened=SQLiteRelayStore::open_without_claim_reset(&path,Some("88")).unwrap();
        // Store reads normalize legacy task vocabulary for compatibility.
        // Inspect raw persisted JSON to prove no full-DB migration UPDATE.
        let raw:String=opened.db.query_row(
            "SELECT json FROM job_snapshot WHERE job_id='88'",
            [],|row|row.get(0)).unwrap();
        let persisted:Value=serde_json::from_str(&raw).unwrap();
        assert_eq!(persisted["tasks"][0]["state"],"BLOCKED");
        let writes:i64=opened.db.query_row(
            "SELECT n FROM migration_write_count",[],|r|r.get(0)).unwrap();
        assert_eq!(writes,before,"schema migration must not run on hot scoped read");
        opened.close().unwrap();
    }
    let _=std::fs::remove_file(path);
}
