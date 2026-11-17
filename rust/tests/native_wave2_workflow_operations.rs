// Independent native SQLite transaction/outbox regressions. No live Job store.
use agents_relay_rust2::{
    relay_workflow_operations::SQLiteWorkflowOperations,
    workflow::durable_publication::DurableWorkflowPublication,
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};

fn fixture() -> Value {
    json!({"id":"42","repository":"fixture","projectRoot":"/tmp/fixture",
        "state":"ACTIVE","updatedAt":"2026-11-17T06:00:00.000Z",
        "createdAt":"2026-11-17T05:00:00.000Z","prNumber":0,"plans":[],
        "tasks":[{"id":"1","jobId":"42","state":"QUEUED","kind":"implementation","agentName":"worker",
          "attempt":1,"maxAttempts":3,"executionId":"ex-1","leaseOwner":"local-worker",
          "leaseExpiresAt":"2099-12-01T00:00:00Z",
          "executionHistory":[{"id":"ex-1","attempt":1}],
          "dependencies":[]}]})
}
fn db() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL)")
        .unwrap();
    db.execute(
        "INSERT INTO job_snapshot VALUES('42',?1)",
        params![fixture().to_string()],
    )
    .unwrap();
    db
}
fn saved(db: &Connection) -> Value {
    let s: String = db
        .query_row("SELECT json FROM job_snapshot WHERE job_id='42'", [], |r| {
            r.get(0)
        })
        .unwrap();
    serde_json::from_str(&s).unwrap()
}
fn write(db: &Connection, job: &Value, _time: &str) -> Result<(), String> {
    db.execute(
        "UPDATE job_snapshot SET json=? WHERE job_id='42'",
        params![job.to_string()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
#[test]
fn failing_event_collision_rolls_back_job_update_and_new_event() {
    let db = db();
    let mut ops = SQLiteWorkflowOperations {
        db: &db,
        write: |job: &Value, at: &str| write(&db, job, at),
        enqueue: None::<fn(&Value, &str) -> Result<(), String>>,
    };
    let mut next = fixture();
    next["tasks"][0]["state"] = json!("RUNNING");
    next["updatedAt"] = json!("2026-11-17T06:00:00.000Z");
    let err = ops
        .commit_workflow_mutation_and_events(
            "42",
            |_| Ok(next.clone()),
            &[
                json!({"key":"one","event":{"type":"task.started","event_id":"one"}}),
                json!({"key":"one","event":{"type":"task.completed","event_id":"one"}}),
            ],
        )
        .unwrap_err();
    assert_eq!(err, "workflow event key collision");
    assert_eq!(saved(&db), fixture());
    assert!(DurableWorkflowPublication::new(&db)
        .unwrap()
        .pending()
        .unwrap()
        .is_empty());
    ops.commit_workflow_mutation_and_events(
        "42",
        |_| Ok(next),
        &[json!({"key":"one","event":{"type":"task.started","event_id":"one"}})],
    )
    .unwrap();
    assert_eq!(saved(&db)["tasks"][0]["state"], "RUNNING");
    assert_eq!(
        DurableWorkflowPublication::new(&db)
            .unwrap()
            .pending()
            .unwrap()
            .len(),
        1
    );
}
#[test]
fn immutable_job_identity_and_rollback_survive_restart_reads() {
    let db = db();
    let before = saved(&db);
    {
        let mut ops = SQLiteWorkflowOperations {
            db: &db,
            write: |job: &Value, at: &str| write(&db, job, at),
            enqueue: None::<fn(&Value, &str) -> Result<(), String>>,
        };
        let mut renamed = before.clone();
        renamed["projectRoot"] = json!("/wrong");
        let err = ops.mutate_job("42", |_| Ok(renamed)).unwrap_err();
        assert_eq!(
            err,
            "Job local repository identity and projectRoot are immutable"
        );
    }
    assert_eq!(saved(&db), before);
    {
        let mut ops = SQLiteWorkflowOperations {
            db: &db,
            write: |job: &Value, at: &str| write(&db, job, at),
            enqueue: None::<fn(&Value, &str) -> Result<(), String>>,
        };
        let mut wrong = before.clone();
        wrong["id"] = json!("99");
        assert_eq!(
            ops.mutate_job("42", |_| Ok(wrong)).unwrap_err(),
            "Cannot change authoritative Job identity"
        );
    }
    assert_eq!(saved(&db), before);
}
#[test]
fn launch_claim_is_authorized_once_and_unknown_before_started_postcondition() {
    let db = db();
    let ops = SQLiteWorkflowOperations {
        db: &db,
        write: |job: &Value, at: &str| write(&db, job, at),
        enqueue: None::<fn(&Value, &str) -> Result<(), String>>,
    };
    let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("workflow");
    let identity = json!({"jobId":"42","taskId":"1","executionId":"ex-1","attempt":1,"leaseOwner":"local-worker"});
    assert!(ops.reserve_workflow_launch(&directory, &identity).unwrap());
    assert!(!ops.reserve_workflow_launch(&directory, &identity).unwrap());
    assert_eq!(
        ops.verify_workflow_launch("42", "1", "ex-1").unwrap(),
        "Unknown"
    );
    let mut updated = saved(&db);
    updated["tasks"][0]["state"] = json!("RUNNING");
    write(&db, &updated, "").unwrap();
    assert_eq!(
        ops.verify_workflow_launch("42", "1", "ex-1").unwrap(),
        "Verified"
    );
    let mut stale = identity;
    stale["leaseOwner"] = json!("another-worker");
    assert!(ops.reserve_workflow_launch(&directory, &stale).is_err());
}
