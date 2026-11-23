// Native regression for Node src/relay-job-snapshot-reads.ts: pure metadata cleanup plus exact read-time legacy Task/Plan/PR normalization.
use agents_relay_rust2::relay_job_snapshot_reads::{
    current_job_metadata, list_relay_jobs, load_relay_job, normalize_relay_job,
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
fn db() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL);").unwrap();
    db
}
#[test]
fn only_six_top_level_obsolete_fields_are_removed_and_nested_job_metadata_is_untouched() {
    let original = json!({"id":"7","schedule":"obsolete","executionMode":"legacy","contentOnly":true,
   "shortcutExecutionStartedAt":"old","shortcutRunnerContext":{"stuff":"old"},"shortcutExecutionDeadlineAt":"old",
   "metadata":{"contentOnly":"keep","schedule":"keep"},"tasks":[]});
    let metadata = current_job_metadata(&original);
    for field in [
        "schedule",
        "executionMode",
        "contentOnly",
        "shortcutExecutionStartedAt",
        "shortcutRunnerContext",
        "shortcutExecutionDeadlineAt",
    ] {
        assert!(
            metadata.get(field).is_none(),
            "field {field} should not survive"
        );
        assert!(
            original.get(field).is_some(),
            "the input Job must be immutable"
        );
    }
    assert_eq!(metadata["metadata"]["schedule"], "keep");
    assert_eq!(metadata["metadata"]["contentOnly"], "keep");
}
#[test]
fn task_and_plan_state_is_composed_without_rewriting_original_sqlite() {
    let input = json!({"id":"9","repository":"repo","projectRoot":"/tmp/repo","state":"COMPLETED","tasks":[{"id":"a","agentName":"editor","input":"# Edit video","title":"Edit video","state":"BLOCKED","kind":"task"},
  {"id":"b","agentName":"troubleshooter","input":"Investigate","state":"UNBLOCKED","attempt":3}],
  "plans":[{"id":"p1","forceCleanHistory":true,"cleanHistoryTaskIds":["a"]},{"id":"p2","forceRestate":false,"forceCleanHistory":true,"restateTaskIds":["b"]}],
  "contentOnly":true,"metadata":{"keep":true}});
    let normalized = normalize_relay_job(&input.to_string()).unwrap();
    assert_eq!(normalized["tasks"][0]["state"], "FAILED");
    assert_eq!(normalized["tasks"][0]["title"], "Edit video");
    assert_eq!(normalized["tasks"][1]["state"], "QUEUED");
    assert_eq!(normalized["plans"][0]["forceRestate"], true);
    assert_eq!(normalized["plans"][0]["restateTaskIds"], json!(["a"]));
    assert_eq!(normalized["plans"][1]["forceRestate"], false);
    assert!(normalized["plans"][0].get("forceCleanHistory").is_none());
    assert!(normalized.get("contentOnly").is_none());
}
#[test]
fn sqlite_scoped_and_global_reads_are_ordered_and_absent_job_is_null() {
    let db = db();
    for id in ["9", "10", "2"] {
        let job = json!({"id":id,"repository":"repo","state":"COMPLETED","tasks":[],"schedule":"obsolete"});
        db.execute(
            "INSERT INTO job_snapshot VALUES(?,?,?)",
            params![id, job.to_string(), "before-read"],
        )
        .unwrap();
    }
    assert!(load_relay_job(&db, "not-here").unwrap().is_none());
    assert_eq!(load_relay_job(&db, "2").unwrap().unwrap()["id"], "2");
    let all = list_relay_jobs(&db, None).unwrap();
    assert_eq!(
        all.iter()
            .map(|value| value["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["10", "2", "9"]
    );
    assert!(all.iter().all(|job| job.get("schedule").is_none()));
    assert_eq!(list_relay_jobs(&db, Some("9")).unwrap().len(), 1);
    assert_eq!(list_relay_jobs(&db, Some("nonexistent")).unwrap().len(), 0);
    let original: String = db
        .query_row(
            "SELECT json FROM job_snapshot WHERE job_id='9'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let unmodified: Value = serde_json::from_str(&original).unwrap();
    assert_eq!(
        unmodified["schedule"], "obsolete",
        "read-time normalization must never modify SQLite"
    );
}
#[test]
fn surrogate_json_title_round_trips_through_load_and_list(){
    let db=db();
    let raw=r#"{"id":"1","tasks":[{"id":"x","title":"A\ud83d"}]}"#;
    db.execute("INSERT INTO job_snapshot VALUES(?,?,?)",params!["1",raw,"before-read"]).unwrap();
    let job=load_relay_job(&db,"1").unwrap().unwrap();
    let encoded=agents_relay_rust2::observability::json_wire(&job);
    assert!(encoded.contains("\\ud83d"));
    assert_eq!(list_relay_jobs(&db,None).unwrap()[0],job);
}
