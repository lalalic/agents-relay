use agents_relay_rust2::reconciler_review::apply_review_event;
use serde_json::{json,Value};
use std::path::Path;
fn graph()->std::path::PathBuf{
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow")
}
fn job()->Value{
    json!({"id":"713","state":"ACTIVE","repository":"calculator-test",
        "headSha":"parent-sha","reviewEnabled":true,"autoMerge":true,
        "review":{"outcome":"pending","headSha":"parent-sha","taskId":"2222"},
        "tasks":[{"id":"2222","jobId":"713","agentName":"job-acceptance-reviewer",
            "kind":"work","state":"RUNNING","adapter":"codex",
            "reviewHeadSha":"parent-sha","executionId":"generation-42",
            "leaseOwner":"live-rust-codex-123",
            "leaseExpiresAt":"2026-11-22T16:00:00Z",
            "attempt":1,"maxAttempts":2,"dependencies":[],"capabilities":[]}]})
}
fn event(event_type:&str)->Value{
    json!({"type":event_type,"job_id":"713","task_id":"2222",
        "timestamp":"2026-11-22T15:44:43.089Z","status":"succeeded",
        "data":{"head_sha":"parent-sha","findings":[]},
        "source":{"id":"job/713/task/2222/execution/generation-42"}})
}
#[test]
fn approved_final_reviewer_clears_terminal_generation_without_faking_review(){
    let applied=apply_review_event(&graph(),&job(),&event("review.approved"),
        Some("parent-sha")).unwrap();
    let task=&applied.job["tasks"][0];
    assert_eq!(task["state"],"SUCCEEDED");
    assert_eq!(applied.job["review"]["outcome"],"approved");
    for name in ["executionId","leaseOwner","leaseExpiresAt"]{
        assert_eq!(task[name],Value::Null,"terminal Reviewer retained {name}");
    }
    assert_eq!(applied.cancel_execution_ids,vec!["generation-42".to_owned()]);
    assert_eq!(applied.job["reviewRevisionRounds"][0]["reviewExecutionId"],
        "generation-42");
    assert_eq!(task["result"]["data"]["head_sha"],"parent-sha");
}
#[test]
fn stale_final_reviewer_cannot_mutate_lease_or_review_verdict(){
    let applied=apply_review_event(&graph(),&job(),&event("review.approved"),
        Some("different-parent-sha")).unwrap();
    assert_eq!(applied.job,job());
    assert!(applied.cancel_execution_ids.is_empty());
}
#[test]
fn nonterminal_reviewer_progress_cannot_release_execution_lease(){
    let applied=apply_review_event(&graph(),&job(),&event("review.started"),
        Some("parent-sha")).unwrap();
    let task=&applied.job["tasks"][0];
    assert_eq!(task["executionId"],"generation-42");
    assert_eq!(task["leaseOwner"],"live-rust-codex-123");
    assert_eq!(task["leaseExpiresAt"],"2026-11-22T16:00:00Z");
}
