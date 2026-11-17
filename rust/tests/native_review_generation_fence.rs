// Native Rust regression against Node src/review-generation-fence.ts: immutable review generation, stale-head reviewer ownership and recovery-only acceptance.
use agents_relay_rust2::review_generation_fence::review_generation_matches;
use serde_json::{json, Value};
fn fixture() -> (Value, Value, Value) {
    let task = json!({"id":"t-42","agentName":"job-acceptance-reviewer","state":"RUNNING",
        "reviewHeadSha":"newsha","executionId":"e-42","planningDecisionId":"plan-v2"});
    let current = json!({"id":"j-1","state":"ACTIVE","headSha":"newsha","tasks":[task.clone()],
        "review":{"taskId":"t-42","headSha":"newsha","outcome":"pending"}});
    let original = current.clone();
    (current, original, task)
}
#[test]
fn current_generation_rejects_old_head_old_execution_and_inactive_job() {
    let (mut current, original, task) = fixture();
    assert!(review_generation_matches(
        &current, &original, &task, "newsha"
    ));
    current["tasks"][0]["executionId"] = json!("old-e");
    assert!(!review_generation_matches(
        &current, &original, &task, "newsha"
    ));
    current["tasks"][0]["executionId"] = json!("e-42");
    current["state"] = json!("COMPLETED");
    assert!(!review_generation_matches(
        &current, &original, &task, "newsha"
    ));
    // A historical repairing projection must never bypass current ACTIVE state.
    current["projectionRecovery"] = json!({"status":"repairing"});
    assert!(!review_generation_matches(
        &current, &original, &task, "newsha"
    ));
    current["headSha"] = json!("oldsha");
    assert!(!review_generation_matches(
        &current, &original, &task, "newsha"
    ));
}
#[test]
fn competing_reviewers_of_stale_head_must_yield_to_latest_matching_generation() {
    let (mut current, mut original, task) = fixture();
    current["review"] = json!({"headSha":"old","outcome":"stale"});
    original["review"] = json!({"headSha":"old","outcome":"stale"});
    assert!(review_generation_matches(
        &current, &original, &task, "newsha"
    ));
    let mut competitor = task.clone();
    competitor["id"] = json!("t-43");
    competitor["agentName"] = json!("reviewer");
    current["tasks"].as_array_mut().unwrap().push(competitor);
    assert!(!review_generation_matches(
        &current, &original, &task, "newsha"
    ));
    current["tasks"][1]["state"] = json!("CANCELLED");
    assert!(review_generation_matches(
        &current, &original, &task, "newsha"
    ));
}
#[test]
fn missing_review_requires_new_planning_decision_without_original_review_task() {
    let (mut current, mut original, mut task) = fixture();
    current.as_object_mut().unwrap().remove("review");
    original.as_object_mut().unwrap().remove("review");
    assert!(review_generation_matches(
        &current, &original, &task, "newsha"
    ));
    task.as_object_mut().unwrap().remove("planningDecisionId");
    assert!(!review_generation_matches(
        &current, &original, &task, "newsha"
    ));
    task["planningDecisionId"] = json!("plan-2");
    original["review"] = json!({"taskId":"old-review"});
    assert!(!review_generation_matches(
        &current, &original, &task, "newsha"
    ));
}
#[test]
fn executor_generation_distinguishes_null_from_missing_execution_id() {
    let (mut current, original, mut task) = fixture();
    current["tasks"][0]["executionId"] = Value::Null;
    task.as_object_mut().unwrap().remove("executionId");
    assert!(!review_generation_matches(
        &current, &original, &task, "newsha"
    ));
    task["executionId"] = Value::Null;
    assert!(review_generation_matches(
        &current, &original, &task, "newsha"
    ));
}
