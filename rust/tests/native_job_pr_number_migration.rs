// Native Rust regression for Node src/job-pr-number-migration.ts: historic PR-number cleanup, Task-title derivation and UTF-16 JSON fidelity.
use agents_relay_rust2::job_pr_number_migration::{
    migrate_legacy_job_pr_numbers, normalize_legacy_job_pr_number, parse_js_json,
};
use agents_relay_rust2::observability::json_wire;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
#[test]
fn recover_old_positive_pr_number_only_when_current_is_unbound() {
    let source = json!({"id":"9","prNumber":0,"externalPrNumber":22,"tasks":[{"id":"t1","input":"  # Build 3D toy \nSecond","agentName":"designer"}]});
    let result = normalize_legacy_job_pr_number(&source);
    assert_eq!(result["prNumber"], 22);
    assert!(result.get("externalPrNumber").is_none());
    assert_eq!(result["tasks"][0]["title"], "Build 3D toy");
    assert_eq!(source["prNumber"], 0);
    let existing = json!({"id":"10","prNumber":17,"externalPrNumber":21,"tasks":[]});
    let normalized = normalize_legacy_job_pr_number(&existing);
    assert_eq!(normalized["prNumber"], 17);
}
#[test]
fn an_empty_task_title_uses_agent_name_fallback_and_preserves_filled_title() {
    let job = json!({"id":"2","prNumber":0,"tasks":[
   {"id":"a","agentName":"reviewer","input":" ","title":" "},
   {"id":"b","input":"   ","title":null},
   {"id":"c","input":"Overwrite not allowed","title":"Existing"}]});
    let output = normalize_legacy_job_pr_number(&job);
    assert_eq!(output["tasks"][0]["title"], "reviewer task");
    assert_eq!(output["tasks"][1]["title"], "Task");
    assert_eq!(output["tasks"][2]["title"], "Existing");
}
#[test]
fn unpaired_utf16_surrogate_round_trips_to_exact_node_json_escape() {
    let title = format!("{}🙂{}", "A".repeat(92), "more".repeat(8));
    let source =
        json!({"id":"4","prNumber":0,"externalPrNumber":7,"tasks":[{"input":title,"id":"t"}]});
    let rewritten = normalize_legacy_job_pr_number(&source);
    let serialized = json_wire(&rewritten);
    assert!(
        serialized.contains("\\ud83d..."),
        "Node's title truncation may retain one high surrogate: {serialized}"
    );
    let parsed = parse_js_json(&serialized).unwrap();
    assert_eq!(json_wire(&parsed), serialized);
    assert!(!serialized.contains('�'));
}
#[test]
fn escaped_literal_unicode_sequence_is_not_mistaken_for_actual_surrogate() {
    let content =
        r#"{"id":"5","tasks":[{"title":"literal \\uD800 and surrogate \ud800","input":"hello"}]}"#;
    let parsed = parse_js_json(content).unwrap();
    let serialized = json_wire(&parsed);
    assert!(serialized.contains(r"\\uD800"));
    assert!(serialized.contains(r"\ud800"));
}
#[test]
fn migrate_only_changed_snapshots_but_preserve_opaque_metadata() {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL);CREATE TABLE updated(job_id TEXT); \
     CREATE TRIGGER changed AFTER UPDATE ON job_snapshot BEGIN INSERT INTO updated VALUES(new.job_id);END;").unwrap();
    let changed = json!({"id":"1","prNumber":0,"externalPrNumber":4,"tasks":[{"id":"t","input":"Hello"}],"metadata":{"opaque":"unchanged"}});
    let stable = json!({"id":"2","prNumber":4,"tasks":[{"id":"t","title":"done","input":"Hello"}]});
    for (id, job) in [("1", changed), ("2", stable)] {
        db.execute(
            "INSERT INTO job_snapshot VALUES(?,?)",
            params![id, job.to_string()],
        )
        .unwrap();
    }
    migrate_legacy_job_pr_numbers(&db).unwrap();
    let updated = db
        .prepare("SELECT job_id FROM updated")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(updated, vec!["1"]);
    let serialized: String = db
        .query_row(
            "SELECT json FROM job_snapshot WHERE job_id='1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let result: Value = parse_js_json(&serialized).unwrap();
    assert_eq!(result["prNumber"], 4);
    assert_eq!(result["metadata"]["opaque"], "unchanged");
}
