//! Real disposable SQLite transaction tests for Worker B's Graph-authorized
//! Troubleshooter escalation and durable event outbox. Never accesses live data.
use agents_relay_rust2::{
    relay_workflow_operations::SQLiteWorkflowOperations,
    troubleshooter_fallback::escalate_exhausted_troubleshooters_atomic,
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::path::PathBuf;

fn graph() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("repo root")
        .join("workflow")
}
fn fixture() -> Value {
    json!({"id":"job","repository":"isolated-repo","projectRoot":"/tmp/rust2-wave4-disposable",
        "state":"ACTIVE","updatedAt":"2026-11-17T00:00:00.000Z","plans":[],
        "tasks":[{"id":"owner","kind":"work","jobId":"job","agentName":"implementation",
            "state":"FAILED","attempt":3,"maxAttempts":3,"executionId":null,"error":"broken original"},
           {"id":"recover","kind":"work","jobId":"job","agentName":"troubleshooter",
            "state":"FAILED","attempt":3,"maxAttempts":3,"parentTaskId":"owner",
            "executionId":null,"error":"provider unavailable","input":"repair provider"}]})
}
fn fixture_db(job: &Value) -> Connection {
    let db = Connection::open_in_memory().unwrap();
    agents_relay_rust2::workflow::durable_publication::DurableWorkflowPublication::new(&db)
        .expect("isolated durable event outbox");
    db.execute_batch("CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL);")
        .unwrap();
    db.execute(
        "INSERT INTO job_snapshot VALUES('job',?1)",
        params![job.to_string()],
    )
    .unwrap();
    db
}
fn snapshot(db: &Connection) -> Value {
    let raw: String = db
        .query_row(
            "SELECT json FROM job_snapshot WHERE job_id='job'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    serde_json::from_str(&raw).unwrap()
}
fn event_count(db: &Connection) -> i64 {
    db.query_row("SELECT COUNT(*) FROM workflow_event_outbox", [], |r| {
        r.get(0)
    })
    .unwrap()
}
fn outcome(db: &Connection) -> Result<Vec<String>, String> {
    let mut ops = SQLiteWorkflowOperations {
        db,
        write: |job: &Value, _: &str| {
            db.execute(
                "UPDATE job_snapshot SET json=?1 WHERE job_id='job'",
                params![job.to_string()],
            )
            .map(|_| ())
            .map_err(|error| error.to_string())
        },
        enqueue: None::<fn(&Value, &str) -> Result<(), String>>,
    };
    escalate_exhausted_troubleshooters_atomic(&mut ops, &graph(), "job")
}
#[test]
fn creates_exactly_one_durable_gate_and_one_correlated_event_then_is_idempotent() {
    let db = fixture_db(&fixture());
    assert_eq!(outcome(&db).unwrap(), ["recover"]);
    let job = snapshot(&db);
    assert_eq!(job["tasks"][0]["resolution"]["path"], "escalation_gate");
    assert_eq!(job["tasks"][0]["resolution"]["state"], "waiting");
    assert_eq!(job["tasks"][1]["state"], "BLOCKED");
    assert_eq!(job["tasks"][1]["failureReason"], "human_action_required");
    assert_eq!(job["tasks"][1]["escalation"]["status"], "pending");
    assert_eq!(
        job["tasks"][1]["escalation"]["notification"]["status"],
        "pending"
    );
    assert_eq!(
        job["tasks"][1]["escalation"]["fingerprint"]
            .as_str()
            .unwrap()
            .len(),
        64
    );
    assert_eq!(event_count(&db), 1);
    let event: String = db
        .query_row("SELECT payload_json FROM workflow_event_outbox", [], |r| {
            r.get(0)
        })
        .unwrap();
    let event: Value = serde_json::from_str(&event).unwrap();
    assert_eq!(event["type"], "escalation.requested");
    assert_eq!(
        event["data"]["escalationId"],
        job["tasks"][1]["escalation"]["id"]
    );
    assert_eq!(event["visibility"], "user");
    assert_eq!(outcome(&db).unwrap(), Vec::<String>::new());
    assert_eq!(
        snapshot(&db)["tasks"][1]["escalation"],
        job["tasks"][1]["escalation"]
    );
    assert_eq!(event_count(&db), 1);
}
#[test]
fn failure_to_persist_rolls_back_gate_original_resolution_and_outbox() {
    let db = fixture_db(&fixture());
    let before = snapshot(&db);
    let mut ops = SQLiteWorkflowOperations {
        db: &db,
        write: |_: &Value, _: &str| Err("test-only denied write".to_owned()),
        enqueue: None::<fn(&Value, &str) -> Result<(), String>>,
    };
    assert_eq!(
        escalate_exhausted_troubleshooters_atomic(&mut ops, &graph(), "job").unwrap_err(),
        "test-only denied write"
    );
    assert_eq!(snapshot(&db), before);
    assert_eq!(event_count(&db), 0);
}
#[test]
fn filters_unrelated_and_barred_recovery_without_durable_mutation() {
    let mut job = fixture();
    job["tasks"][0]["state"] = json!("SUCCEEDED");
    let db = fixture_db(&job);
    assert!(outcome(&db).unwrap().is_empty());
    assert_eq!(snapshot(&db), job);
    assert_eq!(event_count(&db), 0);
    let mut job = fixture();
    job["tasks"][0]["resolution"] = json!({"path":"same_job_dependency","state":"active"});
    let db = fixture_db(&job);
    assert!(outcome(&db).unwrap().is_empty());
    assert_eq!(snapshot(&db), job);
    assert_eq!(event_count(&db), 0);
}
