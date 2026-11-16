// New Rust-native regression fixtures for direct ports of seven Node projection, merge, planner and review helpers.
use agents_relay_rust2::{
    cli_local_merge_config::configure_local_git_merge,
    github_binding_order::order_github_binding_candidates,
    github_branch_projection::authoritative_branch_push_args,
    planned_review_head::bind_planned_review_head,
    planner_history_cleanup::parse_planner_history_cleanup,
    projection_failure_dedupe::ProjectionFailureDeduplicator,
    review_revision_merge::preserve_review_revision_history,
};
use serde_json::json;

#[test]
fn authoritative_push_uses_lease_only_when_safe() {
    assert_eq!(
        authoritative_branch_push_args("refs/heads/work", "feature", Some("sha"), true),
        vec![
            "push",
            "origin",
            "--force-with-lease=refs/heads/feature:sha",
            "refs/heads/work:refs/heads/feature"
        ]
    );
    assert_eq!(
        authoritative_branch_push_args("main", "feature", Some("sha"), false),
        vec!["push", "origin", "main:refs/heads/feature"]
    );
}

#[test]
fn configure_local_git_merge_validates_state_and_target() {
    let mut job = json!({"state":"DRAFT"});
    configure_local_git_merge(&mut job, "feature", "refs/heads/main", false).unwrap();
    assert_eq!(job["localMerge"]["status"], "pending");
    assert!(configure_local_git_merge(&mut job, "source", "main", false).is_err());
    job["state"] = json!("COMPLETED");
    assert!(configure_local_git_merge(&mut job, "source", "refs/heads/main", false).is_err());
}

#[test]
fn sqlite_review_history_ignores_falsey_legacy_values() {
    let local = json!({"reviewRevisionRequests":null,"reviewRevisionRounds":[{"round":1}]});
    let mut merged = json!({"reviewRevisionRequests":[{"round":0}],"reviewRevisionRounds":[]});
    preserve_review_revision_history(&local, &mut merged);
    assert!(merged.get("reviewRevisionRequests").is_none());
    assert_eq!(merged["reviewRevisionRounds"], json!([{"round":1}]));
}

#[test]
fn job_binding_prefers_new_unbound_jobs() {
    let items = vec![
        json!({"job":{"state":"COMPLETED","prNumber":0,"createdAt":"2026-11-01"},"snapshotPath":"/old"}),
        json!({"job":{"state":"ACTIVE","prNumber":0,"createdAt":"2026-11-02"},"snapshotPath":"/new"}),
    ];
    let sorted = order_github_binding_candidates(&items);
    assert_eq!(sorted[0]["snapshotPath"], "/new");
}

#[test]
fn history_cleanup_rejects_explicit_null_target() {
    let input = json!([{"taskId":"t1","outcome":"unresolved","evidence":"e","reason":"r","targetTaskId":null}]);
    assert_eq!(
        parse_planner_history_cleanup(&input).unwrap_err(),
        "Planner history_cleanup[0].targetTaskId must be a non-empty string"
    );
}

#[test]
fn terminal_projection_dedupes_and_invalidates() {
    let mut dedupe = ProjectionFailureDeduplicator::default();
    assert!(dedupe.should_report("job", "v1", "error", "terminal"));
    assert!(!dedupe.should_report("job", "v1", "error", "terminal"));
    assert!(dedupe.should_report("job", "v1", "error", "transient"));
    assert!(dedupe.should_report("job", "v1", "error", "terminal"));
}

#[test]
fn planned_review_head_freezes_and_reuses_rule() {
    let mut task = json!({"id":"review-1","input":"Review source"});
    bind_planned_review_head(&mut task, Some("abc123")).unwrap();
    let once = task["input"].as_str().unwrap().to_string();
    bind_planned_review_head(&mut task, Some("abc123")).unwrap();
    assert_eq!(task["input"].as_str().unwrap(), once);
    assert_eq!(task["reviewHeadSha"], "abc123");
    assert!(bind_planned_review_head(&mut task, None).is_err());
}
