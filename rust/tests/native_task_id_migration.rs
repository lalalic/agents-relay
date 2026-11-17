// Native Rust regression for Node src/task-id-migration.ts, using isolated disposable SQLite databases and SQLite online-backup integrity checks.
use agents_relay_rust2::task_id_migration::migrate_task_ids;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
fn temp() -> PathBuf {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let tick = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "r2-taskid-{}-{tick}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ))
}
fn database(dir: &PathBuf) -> (PathBuf, PathBuf, Connection) {
    fs::create_dir_all(dir).unwrap();
    let src = dir.join("source.sqlite");
    let before = dir.join("backup.sqlite");
    let db = Connection::open(&src).unwrap();
    db.execute_batch("CREATE TABLE migration_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);\
      CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL);\
      CREATE TABLE sequences(repository TEXT,kind TEXT,value INTEGER,PRIMARY KEY(repository,kind));\
      CREATE TABLE execution_process(job_id TEXT,task_id TEXT,execution_id TEXT,PRIMARY KEY(job_id,task_id,execution_id));\
      CREATE TABLE workflow_event_outbox(event_key TEXT PRIMARY KEY,payload_json TEXT);").unwrap();
    (src, before, db)
}
#[test]
fn migration_snapshots_backup_rewrites_nested_references_and_is_one_time_only() {
    let dir = temp();
    let (src, backup, db) = database(&dir);
    let job = json!({"id":"619","state":"COMPLETED","tasks":[
      {"id":"parent","title":"First","dependencies":["child"],"input":"{\"taskId\":\"child\"}","dagNode":{"parentTaskId":"parent","nodeId":"A"}},
      {"id":"child","agentName":"editor","dagNode":{"nodeId":"edit"},"parentTaskId":"parent"}],
      "review":{"taskId":"child"}});
    db.execute(
        "INSERT INTO job_snapshot VALUES(?,?,?)",
        params!["619", job.to_string(), "now"],
    )
    .unwrap();
    db.execute(
        "INSERT INTO execution_process VALUES(?,?,?)",
        params!["619", "parent", "exec"],
    )
    .unwrap();
    db.execute(
        "INSERT INTO workflow_event_outbox VALUES(?,?)",
        params!["e", json!({"job_id":"619","task_id":"child"}).to_string()],
    )
    .unwrap();
    drop(db);
    let result = migrate_task_ids(src.to_str().unwrap(), backup.to_str().unwrap()).unwrap();
    assert_eq!(result["taskCount"], 2);
    assert_eq!(result["maxId"], 2);
    assert_eq!(result["alreadyMigrated"], false);
    let copy = Connection::open_with_flags(&backup, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let raw: String = copy
        .query_row("SELECT json FROM job_snapshot", [], |r| r.get(0))
        .unwrap();
    assert_eq!(serde_json::from_str::<Value>(&raw).unwrap(), job);
    assert_eq!(
        copy.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    drop(copy);
    let db = Connection::open_with_flags(&src, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let raw: String = db
        .query_row("SELECT json FROM job_snapshot", [], |r| r.get(0))
        .unwrap();
    let migrated: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(migrated["tasks"][0]["id"], "1");
    assert_eq!(migrated["tasks"][1]["id"], "2");
    assert_eq!(migrated["tasks"][0]["dependencies"][0], "2");
    assert_eq!(migrated["tasks"][1]["parentTaskId"], "1");
    assert_eq!(migrated["tasks"][1]["title"], "editor");
    assert_eq!(migrated["review"]["taskId"], "2");
    assert_eq!(migrated["tasks"][0]["input"], "{\"taskId\":\"2\"}");
    assert_eq!(
        db.query_row("SELECT task_id FROM execution_process", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "1"
    );
    drop(db);
    assert_eq!(
        migrate_task_ids(src.to_str().unwrap(), backup.to_str().unwrap()).unwrap()
            ["alreadyMigrated"],
        true
    );
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn active_job_preflight_blocks_migration_before_any_backup_or_write() {
    let dir = temp();
    let (src, backup, db) = database(&dir);
    let data = "{\"state\":\"ACTIVE\",\"tasks\":[]}";
    db.execute(
        "INSERT INTO job_snapshot VALUES(?,?,?)",
        params!["active", data, "now"],
    )
    .unwrap();
    drop(db);
    let error = migrate_task_ids(src.to_str().unwrap(), backup.to_str().unwrap()).unwrap_err();
    assert_eq!(error, "Preflight failed: Job active is ACTIVE");
    assert!(!backup.exists());
    let read = Connection::open_with_flags(&src, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    assert_eq!(
        read.query_row("SELECT json FROM job_snapshot", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        data
    );
    drop(read);
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn uniqueness_collisions_use_two_phase_renaming_before_final_numeric_ids() {
    let dir = temp();
    let (src, backup, db) = database(&dir);
    db.execute(
        "INSERT INTO job_snapshot VALUES(?,?,?)",
        params![
            "9",
            json!({"state":"COMPLETED","tasks":[{"id":"2"},{"id":"1"}]}).to_string(),
            "now"
        ],
    )
    .unwrap();
    for id in ["1", "2"] {
        db.execute(
            "INSERT INTO execution_process VALUES(?,?,?)",
            params!["9", id, "same"],
        )
        .unwrap();
    }
    drop(db);
    let result = migrate_task_ids(src.to_str().unwrap(), backup.to_str().unwrap()).unwrap();
    assert_eq!(result["taskCount"], 2);
    let read = Connection::open_with_flags(&src, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let count: i64 = read
        .query_row(
            "SELECT COUNT(DISTINCT task_id) FROM execution_process",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 2);
    drop(read);
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn a_constraint_failure_rolls_back_all_changes_but_keeps_verified_prewrite_backup() {
    let dir = temp();
    let (src, backup, db) = database(&dir);
    let original = json!({"id":"619","state":"COMPLETED","tasks":[{"id":"legacy"}]}).to_string();
    db.execute(
        "INSERT INTO job_snapshot VALUES(?,?,?)",
        params!["619", original, "now"],
    )
    .unwrap();
    db.execute_batch("CREATE TABLE protected(job_id TEXT,task_id TEXT CHECK(task_id='legacy')); INSERT INTO protected VALUES('619','legacy')").unwrap();
    drop(db);
    assert!(
        migrate_task_ids(src.to_str().unwrap(), backup.to_str().unwrap())
            .unwrap_err()
            .contains("CHECK constraint failed")
    );
    assert!(backup.exists());
    let read = Connection::open_with_flags(&src, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    assert_eq!(
        read.query_row("SELECT json FROM job_snapshot", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        original
    );
    assert_eq!(
        read.query_row("SELECT task_id FROM protected", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "legacy"
    );
    assert_eq!(
        read.query_row(
            "SELECT value FROM migration_metadata WHERE key='task_id_numeric_migration'",
            [],
            |r| r.get::<_, String>(0)
        )
        .optional()
        .unwrap(),
        None
    );
    drop(read);
    let backup_copy =
        Connection::open_with_flags(&backup, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    assert_eq!(
        backup_copy
            .query_row("SELECT json FROM job_snapshot", [], |r| r
                .get::<_, String>(0))
            .unwrap(),
        original
    );
    drop(backup_copy);
    fs::remove_dir_all(dir).unwrap();
}
