// Native Rust regression for Node src/task-comments.ts: UUID-v4 comments, immutable Task facts, idempotency and stale snapshot recovery.
use agents_relay_rust2::task_comments::{
    append_task_comment, preserve_task_comments, task_comment_context,
};
use serde_json::{json, Value};
fn job() -> Value {
    json!({"id":"j7","repository":"repo","tasks":[
      {"id":"t1","state":"RUNNING","executionId":"exec-1","input":"immutable","comments":[]},
      {"id":"t2","state":"FAILED","comments":[]}
    ]})
}
#[test]
fn new_comment_gets_random_uuid_and_utc_timestamp_without_mutating_task_input() {
    let mut job = job();
    let first = append_task_comment(&mut job, "t1", "  First 😀  ", &json!("operator")).unwrap();
    let second = append_task_comment(&mut job, "t1", "Second", &json!("operator")).unwrap();
    assert_eq!(first["text"], "First 😀");
    assert_eq!(first["author"], "operator");
    assert_eq!(first["jobId"], "j7");
    assert_eq!(first["taskId"], "t1");
    assert_eq!(first["createdAt"].as_str().unwrap().len(), 24);
    assert_eq!(first["id"].as_str().unwrap().len(), 36);
    assert_eq!(
        &first["id"].as_str().unwrap()[14..15],
        "4",
        "RFC4122 UUID v4 variant"
    );
    assert_ne!(first["id"], second["id"]);
    assert_eq!(job["tasks"][0]["comments"].as_array().unwrap().len(), 2);
    assert_eq!(job["tasks"][0]["executionId"], "exec-1");
    assert_eq!(job["tasks"][0]["input"], "immutable");
}
#[test]
fn idempotent_comment_key_preserves_exact_original_record_and_only_one_append() {
    let mut job = job();
    let options = json!({"idempotencyKey":"approval-42","author":"reviewer","kind":"review.feedback",
  "transition":"review.approved","executionId":"e42"});
    let original = append_task_comment(&mut job, "t1", "first", &options).unwrap();
    let repeated = append_task_comment(&mut job, "t1", "second", &options).unwrap();
    assert_eq!(original, repeated);
    assert_eq!(original["id"], "approval-42");
    assert_eq!(original["kind"], "review.feedback");
    assert_eq!(original["transition"], "review.approved");
    assert_eq!(original["executionId"], "e42");
    assert_eq!(job["tasks"][0]["comments"].as_array().unwrap().len(), 1);
}
#[test]
fn missing_task_and_empty_message_reject_without_modifying_job() {
    let mut job = job();
    let before = job.clone();
    assert_eq!(
        append_task_comment(&mut job, "missing", "text", &json!("cli")).unwrap_err(),
        "Task missing not found"
    );
    assert_eq!(
        append_task_comment(&mut job, "t1", " \t\n ", &json!("cli")).unwrap_err(),
        "task comment requires nonempty --message"
    );
    assert_eq!(job, before);
}
#[test]
fn prompt_comment_context_is_exact_and_preserves_stable_append_order() {
    let task = json!({"comments":[
  {"id":"k1","text":"first","author":"human","createdAt":"2026-11-16T10:00:00Z"},
  {"id":"k2","text":"中文反馈","author":"reviewer","createdAt":"2026-11-16T11:00:00Z"}]});
    let text = task_comment_context(&task);
    assert_eq!(text,"\n\n[Task comments — append-only supplementary context]\n2026-11-16T10:00:00Z (human, k1): first\n2026-11-16T11:00:00Z (reviewer, k2): 中文反馈");
    assert_eq!(task_comment_context(&json!({"comments":[]})), "");
}
#[test]
fn stale_inbound_snapshot_cannot_erase_authoritative_comments_or_duplicate_ids() {
    let previous = vec![
        json!({"id":"t1","comments":[{"id":"c1","text":"old","author":"human","createdAt":"past"},
  {"id":"c2","text":"second","author":"human","createdAt":"past"}]}),
        json!({"id":"t2","comments":[]}),
    ];
    let incoming = vec![
        json!({"id":"t1","title":"fresh","comments":[
  {"id":"c2","text":"stale overwrite","author":"worker"},
  {"id":"c3","text":"new","author":"worker"},
  {"id":"c3","text":"duplicate","author":"worker"}]}),
        json!({"id":"t2","title":"new"}),
    ];
    let out = preserve_task_comments(&previous, &incoming);
    let comments = out[0]["comments"].as_array().unwrap();
    assert_eq!(comments.len(), 3);
    assert_eq!(comments[1]["text"], "second");
    assert_eq!(comments[2]["text"], "new");
    assert_eq!(out[0]["title"], "fresh");
    assert!(out[1]["comments"].is_null());
}
