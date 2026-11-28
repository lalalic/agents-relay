// Native Node src/runtime-status.ts contracts: DAG Coordinator is not an active leased Worker, and Reviewer/implementation priority is deterministic.
use agents_relay_rust2::runtime_status::{
    derive_job_runtime_status, implementation_complete, implementation_tasks, is_superseded,
};
use serde_json::json;
use std::collections::HashMap;
#[test]
fn running_implementation_takes_precedence_over_draft_reviewer_and_planner_failures() {
    let job = json!({"state":"ACTIVE","reviewEnabled":true,"plans":[{"status":"FAILED"}],"tasks":[
  {"id":"a","agentName":"worker","kind":"work","state":"RUNNING"},
  {"id":"review","agentName":"reviewer","kind":"work","state":"DRAFT"}]});
    assert_eq!(derive_job_runtime_status(&job, "CLOSED"), "RUNNING");
    assert_eq!(implementation_tasks(&job).len(), 1);
}
#[test]
fn human_wait_preempts_unleased_coordinator_but_not_real_leased_execution() {
    let mut job = json!({"state":"ACTIVE","reviewEnabled":false,"tasks":[
  {"id":"coordinator","state":"RUNNING","kind":"work","agentName":"coordinator","executionId":null,"leaseOwner":null},
  {"id":"child","state":"AWAITING_DECISION","kind":"work","agentName":"worker"}]});
    assert_eq!(derive_job_runtime_status(&job, "OPEN"), "WAITING");
    job["tasks"][0]["executionId"] = json!("exec-1");
    job["tasks"][0]["leaseOwner"] = json!("relay");
    assert_eq!(derive_job_runtime_status(&job, "OPEN"), "RUNNING");
}
#[test]
fn stale_review_revision_is_excluded_and_superseded_failed_task_is_not_failure() {
    let task = json!({"id":"failed","state":"FAILED","resolutionClassification":{"kind":"superseded","targetTaskId":"success","evidence":"proof","reason":"resolved"}});
    let successful = json!({"id":"success","state":"SUCCEEDED","kind":"work","agentName":"worker"});
    let mut index = HashMap::new();
    index.insert("success".into(), successful.clone());
    assert!(is_superseded(&task, &index));
    let job = json!({"state":"ACTIVE","reviewEnabled":false,"tasks":[task,successful,
  {"id":"old-revision","state":"FAILED","kind":"work","agentName":"worker"}],
  "reviewRevisionRequests":[{"status":"stale","revisionTaskId":"old-revision"}]});
    assert!(implementation_complete(&job));
    // Implementation completion filters superseded and stale revision rows,
    // but the Node Job-level FAILED predicate ignores supersession except
    // for stale targeted revisions. Preserve Node behavior exactly.
    assert_eq!(derive_job_runtime_status(&job, "MERGED"), "FAILED");
}
#[test]
fn empty_implementation_cannot_be_complete_and_review_approved_is_display_only_pending() {
    let mut job = json!({"state":"ACTIVE","reviewEnabled":false,"tasks":[]});
    assert!(!implementation_complete(&job));
    assert_eq!(derive_job_runtime_status(&job, "MERGED"), "IDLE");
    job["review"] = json!({"outcome":"approved"});
    assert_eq!(derive_job_runtime_status(&job, "CLOSED"), "MERGE_PENDING");
    job["state"] = json!("COMPLETED");
    assert_eq!(derive_job_runtime_status(&job, "OPEN"), "COMPLETED");
}

#[test]
fn latest_planning_is_computed_without_changing_precedence_or_history_rules() {
    let mut job = json!({"state":"ACTIVE","reviewEnabled":true,"tasks":[],"plans":[{"status":"PLANNING"}]});
    assert_eq!(derive_job_runtime_status(&job, "OPEN"), "PLANNING");
    job["plans"] = json!([{"status":"SUCCEEDED"}]);
    assert_eq!(derive_job_runtime_status(&job, "OPEN"), "IDLE");
    job["plans"] = json!([{"status":"FAILED"}]);
    assert_eq!(derive_job_runtime_status(&job, "OPEN"), "FAILED");
    job["plans"] = json!([]);
    assert_eq!(derive_job_runtime_status(&job, "OPEN"), "IDLE");
    job["plans"] = json!([{"status":"PLANNING"},{"status":"SUCCEEDED"}]);
    assert_eq!(derive_job_runtime_status(&job, "OPEN"), "IDLE");
    job["plans"] = json!([{"status":"PLANNING"},{"status":"FAILED"}]);
    assert_eq!(derive_job_runtime_status(&job, "OPEN"), "FAILED");
    job["plans"] = json!([{"status":"PLANNING"}]);
    job["tasks"] = json!([{"id":"queued","kind":"work","agentName":"worker","state":"QUEUED"}]);
    assert_eq!(derive_job_runtime_status(&job, "OPEN"), "QUEUED");
    job["tasks"] = json!([{"id":"running","kind":"work","agentName":"worker","state":"RUNNING"}]);
    assert_eq!(derive_job_runtime_status(&job, "OPEN"), "RUNNING");
}
