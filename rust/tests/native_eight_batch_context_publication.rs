// Native regressions for Node src/task-context.ts and src/publication-store.ts: stale-execution fences, reviewer-history, monotonic publication receipts.
use agents_relay_rust2::{
    publication_store::{
        list_publication_events_from_database, load_publication_from_database,
        record_publication_in_database,
    },
    task_context::{task_agent_history_context, task_execution_context, task_reference_prompt},
};
use rusqlite::Connection;
use serde_json::json;
#[test]
fn task_context_rejects_stale_execution_and_includes_reviewer_dependencies() {
    let job = json!({"id":"j","repository":"repo","state":"ACTIVE","title":"Job","objective":"Finish","tasks":[
  {"id":"t","state":"RUNNING","executionId":"new","agentName":"reviewer","dependencies":["work","missing"],"attempt":1},
  {"id":"work","title":"Builder","state":"SUCCEEDED","agentName":"worker","attempt":2,"executionId":"old","comments":[{"id":"c"}]}],"plans":[]});
    assert!(task_execution_context(&job, "t", "old")
        .unwrap_err()
        .contains("Stale Task execution"));
    let context = task_execution_context(&job, "t", "new").unwrap();
    assert_eq!(context["relevantTasks"].as_array().unwrap().len(), 1);
    assert_eq!(context["dependencies"][1]["missing"], true);
    assert!(task_agent_history_context(&job, &job["tasks"][0]).contains("Builder"));
}
#[test]
fn managed_reference_prompt_requires_event_contract_only_when_supplied() {
    assert!(
        task_reference_prompt("repo", "1", "2", "exec", Some("missing"))
            .unwrap_err()
            .contains("Missing required event contract")
    );
    let prompt = task_reference_prompt("repo", "1", "2", "exec", None).unwrap();
    assert!(prompt.contains("job/1/task/2/execution/exec"));
    assert!(prompt
        .contains("agents-relay task context --repo repo --id 1 --task-id 2 --execution-id exec"));
}
fn publication_db() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("CREATE TABLE publication_state(job_id TEXT PRIMARY KEY,json TEXT NOT NULL);CREATE TABLE publication_delivery(job_id TEXT NOT NULL,delivery_id TEXT NOT NULL,type TEXT NOT NULL,json TEXT NOT NULL,observed_at TEXT NOT NULL,PRIMARY KEY(job_id,delivery_id));").unwrap();
    db
}
#[test]
fn publication_acknowledgment_dedupes_delivery_ids_without_undoing_latest_state() {
    let mut db = publication_db();
    let newer = json!({"package":"agents-relay","version":"2.0.0","registry":"npm","sha":"new"});
    let older = json!({"package":"agents-relay","version":"1.0.0","registry":"npm","sha":"old"});
    assert!(record_publication_in_database(
        &mut db,
        "j",
        "delivery-1",
        Some(&newer),
        None,
        Some("2026-11-17T04:00:00.000Z")
    )
    .unwrap());
    assert!(!record_publication_in_database(
        &mut db,
        "j",
        "delivery-1",
        Some(&older),
        None,
        Some("2026-11-18T04:00:00.000Z")
    )
    .unwrap());
    assert!(record_publication_in_database(
        &mut db,
        "j",
        "delivery-2",
        Some(&older),
        None,
        Some("2026-11-16T04:00:00.000Z")
    )
    .unwrap());
    assert_eq!(
        load_publication_from_database(&db, "j").unwrap().unwrap()["latest"]["version"],
        "2.0.0"
    );
    let events = list_publication_events_from_database(&db, "j").unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(events[0]["deliveryId"], "delivery-2");
}
