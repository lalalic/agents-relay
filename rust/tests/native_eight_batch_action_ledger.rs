// Native regressions for Node src/workflow/action-ledger.ts: Graph-authorized effect receipt, lease/generation fence, Unknown postcondition persistence.
use agents_relay_rust2::workflow::{
    action_ledger::WorkflowActionLedger, conditions::ConditionRegistry,
};
use rusqlite::{params, Connection};
use serde_json::json;
#[test]
fn unknown_action_receipt_cannot_be_double_reserved_and_verified_result_is_final() {
    let db = Connection::open_in_memory().unwrap();
    let ledger = WorkflowActionLedger::new(&db).unwrap();
    let id = json!({"attemptKey":"job/task/execution/1","executionId":"e","generation":1,"graph":"task.mmd","actionId":"effect.done"});
    let decision = json!({"accepted":true,"actions":[{"id":"effect.done"}]});
    assert!(ledger.reserve(&id, &decision, "done").unwrap());
    assert!(!ledger.reserve(&id, &decision, "done").unwrap());
    let checks = ConditionRegistry::new(vec![json!({"id":"done","kind":"boolean"})]).unwrap();
    assert_eq!(
        ledger
            .verify("job/task/execution/1", &checks, &json!({}))
            .unwrap()["outcome"],
        "Unknown"
    );
    assert_eq!(
        ledger
            .verify("job/task/execution/1", &checks, &json!({"done":true}))
            .unwrap()["outcome"],
        "Verified"
    );
    assert_eq!(
        ledger
            .verify("job/task/execution/1", &checks, &json!({"done":false}))
            .unwrap()["outcome"],
        "Verified"
    );
    assert!(ledger
        .reserve(&id, &json!({"accepted":false,"actions":[]}), "done")
        .is_err());
}
#[test]
fn claimed_execution_lease_fences_stale_attempt_and_requires_latest_history() {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL)")
        .unwrap();
    let mut job = json!({"tasks":[{"id":"t","state":"RUNNING","executionId":"exec","leaseOwner":"relay","leaseExpiresAt":"2026-11-17T10:00:00.000Z","attempt":2,"executionHistory":[{"id":"exec","attempt":2}]}]});
    db.execute(
        "INSERT INTO job_snapshot VALUES('j',?)",
        params![job.to_string()],
    )
    .unwrap();
    let ledger = WorkflowActionLedger::new(&db).unwrap();
    let identity = json!({"jobId":"j","taskId":"t","leaseOwner":"relay","attempt":2,"executionId":"exec","generation":2,"graph":"task.mmd","actionId":"effect.launchTask","attemptKey":"attempt-2"});
    let decision = json!({"accepted":true,"source":"RUNNING","target":"RUNNING","actions":[{"id":"effect.launchTask"}]});
    assert!(ledger
        .reserve_for_running_task(
            &identity,
            &decision,
            "started",
            "2026-11-17T09:00:00.000Z",
            "RUNNING"
        )
        .unwrap());
    assert!(!ledger
        .reserve_for_running_task(
            &identity,
            &decision,
            "started",
            "2026-11-17T09:00:00.000Z",
            "RUNNING"
        )
        .unwrap());
    job["pause"] = json!({"generation":2});
    db.execute(
        "UPDATE job_snapshot SET json=? WHERE job_id='j'",
        params![job.to_string()],
    )
    .unwrap();
    let mut different = identity.clone();
    different["attemptKey"] = json!("new-attempt");
    assert!(ledger
        .reserve_for_running_task(
            &different,
            &decision,
            "started",
            "2026-11-17T09:00:00.000Z",
            "RUNNING"
        )
        .unwrap_err()
        .contains("fenced"));
}
