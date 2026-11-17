// Native Rust regressions for Node src/execution-event-identity.ts: exact execution identity, stale event rejection and terminal claim scoping.
use agents_relay_rust2::execution_event_identity::{
    claim_terminal_execution, event_source_id, execution_event_source, execution_id_from_source,
    terminal_execution_claimed,
};
use serde_json::json;
#[test]
fn canonical_sources_are_not_ambiguous_between_jobs_tasks_and_executions() {
    let source = execution_event_source("job-99", "task-11", "run-abc");
    assert_eq!(source, "job/job-99/task/task-11/execution/run-abc");
    assert_eq!(
        execution_id_from_source(Some(&source), "job-99", "task-11"),
        Some("run-abc".into())
    );
    assert_eq!(
        execution_id_from_source(Some(&source), "job-98", "task-11"),
        None
    );
    assert_eq!(
        execution_id_from_source(Some(&source), "job-99", "task-10"),
        None
    );
    assert_eq!(
        execution_id_from_source(
            Some("job/job-99/task/task-11/execution/"),
            "job-99",
            "task-11"
        ),
        None
    );
    assert_eq!(execution_id_from_source(None, "job-99", "task-11"), None);
}
#[test]
fn event_source_id_is_optional_and_requires_real_source_id_string() {
    assert_eq!(
        event_source_id(&json!({"source":{"id":"job/a/task/b/execution/c"}})),
        Some("job/a/task/b/execution/c".into())
    );
    for invalid in [
        json!({"source":null}),
        json!({}),
        json!({"source":{}}),
        json!({"source":{"id":7}}),
    ] {
        assert_eq!(event_source_id(&invalid), None);
    }
}
#[test]
fn terminal_claim_is_exact_to_original_execution_generation() {
    let source = execution_event_source("rust2-native-id-only-job", "t", "initial");
    claim_terminal_execution(&source);
    assert!(terminal_execution_claimed(
        "rust2-native-id-only-job",
        "t",
        "initial"
    ));
    assert!(!terminal_execution_claimed(
        "rust2-native-id-only-job",
        "t",
        "new-generation"
    ));
    assert!(!terminal_execution_claimed(
        "rust2-native-id-only-job",
        "other",
        "initial"
    ));
    assert!(!terminal_execution_claimed("other", "t", "initial"));
}
