// Native regressions for Node src/relay-create.ts, src/relay-job-merge.ts and src/store-task-definition.ts: SQLite authority, append-only comments and immutable Definition IDs.
use agents_relay_rust2::{
    relay_create::create_job_if_absent,
    relay_job_merge::merge_inbound_job_snapshot,
    store_task_definition::{
        same_plan_definition, same_task_definition, task_definition_divergence,
    },
};
use rusqlite::Connection;
use serde_json::{json, Value};
#[test]
fn sqlite_job_creation_is_idempotent_and_never_overwrites_stored_objective() {
    let mut db = Connection::open_in_memory().unwrap();
    db.execute_batch("CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL)").unwrap();
    let initial = json!({"id":"10","repository":"repo","state":"ACTIVE","title":"first","objective":"original","tasks":[],"plans":[]});
    let forged = json!({"id":"10","repository":"repo","state":"ACTIVE","title":"other","objective":"forged","tasks":[],"plans":[]});
    assert_eq!(
        create_job_if_absent(&mut db, &initial).unwrap()["title"],
        "first"
    );
    assert_eq!(
        create_job_if_absent(&mut db, &forged).unwrap()["objective"],
        "original"
    );
    let count: i64 = db
        .query_row("SELECT COUNT(*) FROM job_snapshot", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 1);
}
#[test]
fn inbound_merge_preserves_local_revision_provenance_comments_and_most_recent_definition() {
    let local = json!({"id":"j","updatedAt":"2026-11-15T00:00:00Z","reviewRevisionRequests":[{"id":"prior-review"}],"tasks":[
   {"id":"t","updatedAt":"2026-11-15T00:00:00Z","title":"old","comments":[{"id":"a","text":"original"}]}],
   "plans":[{"id":"p","round":3,"updatedAt":"2026-11-15T00:00:00Z"}]});
    let remote = json!({"id":"j","updatedAt":"2026-11-16T00:00:00Z","reviewRevisionRequests":[{"id":"forged-review"}],"tasks":[
   {"id":"t","updatedAt":"2026-11-16T00:00:00Z","title":"new","comments":[{"id":"b","text":"new"}]}],
   "plans":[{"id":"p","round":3,"updatedAt":"2026-11-16T00:00:00Z"}]});
    let merged = merge_inbound_job_snapshot(&local, &remote);
    assert_eq!(merged["reviewRevisionRequests"][0]["id"], "prior-review");
    assert_eq!(merged["tasks"][0]["title"], "new");
    assert_eq!(merged["tasks"][0]["comments"].as_array().unwrap().len(), 2);
    assert_eq!(merged["tasks"][0]["comments"][0]["id"], "a");
    assert_eq!(local["tasks"][0]["title"], "old");
}
#[test]
fn task_definition_ignores_runtime_state_comments_and_plan_url_but_not_user_objective() {
    let left = json!({"id":"t","jobId":"j","agentName":"worker","input":"input","state":"FAILED","comments":[{"id":"old"}]});
    let mut right = left.clone();
    right["state"] = json!("SUCCEEDED");
    right["comments"] = json!([{"id":"new"}]);
    assert!(same_task_definition(&left, &right));
    right["input"] = json!("altered input");
    assert_eq!(task_definition_divergence(&left, &right), vec!["input"]);
    let plan = json!({"id":"p","round":1,"planUrl":"https://old"});
    let mut changed: Value = plan.clone();
    changed["planUrl"] = json!("https://new");
    assert!(same_plan_definition(&plan, &changed));
}

#[test]
fn deterministic_definition_conflict_is_tagged_and_has_exact_node_message() {
    use agents_relay_rust2::store_task_definition::DurableDefinitionConflictError;
    let conflict = DurableDefinitionConflictError::new(
        "task",
        "append_task",
        "j",
        "t",
        &json!({"input":"old"}),
        &json!({"input":"new"}),
        &["input".to_string()],
    );
    assert_eq!(conflict.name, "DurableDefinitionConflictError");
    assert!(conflict.deterministic);
    assert_eq!(
        conflict.to_string(),
        "Task t already exists with a different definition"
    );
    assert_eq!(conflict.diverging_fields, vec!["input"]);
}
