// New Rust-native regression checks for the four directly ported Node helper modules.
// Node/Rust head_to_head.mjs remains the external authoritative differential oracle.
use agents_relay_rust2::{
    dependency_validity::validate_dependency_validity,
    final_review_role::is_final_review_agent,
    job_execution_slot::{job_has_active_execution, job_has_conflicting_execution},
    planner_agent_roles::validate_planner_agent_roles,
    planner_task_title::required_planner_task_title,
    task_title::{derive_task_title, json_string_from_utf16},
    terminal_event_recovery::{
        terminal_recovery_eligible, terminal_recovery_prompt, TerminalRecoveryFacts,
    },
};
use serde_json::json;

#[test]
fn task_title_prefixes_and_js_whitespace() {
    let units = derive_task_title("\n### - 4. Japanese\u{00a0}title\nrest", "Task");
    assert_eq!(String::from_utf16(&units).unwrap(), "Japanese title");
}

#[test]
fn task_title_preserves_half_surrogate_when_js_slice_splits_emoji() {
    let units = derive_task_title(&"😀".repeat(60), "Task");
    assert_eq!(units.len(), 96);
    assert_eq!(units[92], 0xd83d);
    assert_eq!(units[93..], [46, 46, 46]);
    assert!(json_string_from_utf16(&units).contains("\\ud83d\\u002e"));
}

#[test]
fn planner_title_range_and_errors() {
    assert_eq!(
        required_planner_task_title(&json!("  one two three four five  "), 2).unwrap(),
        "one two three four five"
    );
    assert_eq!(
        required_planner_task_title(&json!("three word title"), 2).unwrap_err(),
        "Planner next_tasks[2].title must contain 5–8 words (got 3)"
    );
}

#[test]
fn dependency_policy_validates_declared_edges_and_node_proto_setter() {
    let deps = ["a".into(), "__proto__".into()];
    assert_eq!(
        validate_dependency_validity(&deps, &json!({"a":"rerun"}), "dependencyValidity")
            .unwrap()
            .unwrap(),
        json!({"a":"rerun"}).as_object().unwrap().clone()
    );
    assert!(
        validate_dependency_validity(&deps, &json!({"other":"rerun"}), "dependencyValidity")
            .unwrap_err()
            .contains("declared dependency")
    );
    assert!(validate_dependency_validity(
        &deps,
        &serde_json::from_str("{\"__proto__\":\"rerun\"}").unwrap(),
        "dependencyValidity"
    )
    .unwrap()
    .unwrap()
    .is_empty());
}

#[test]
fn terminal_recovery_is_single_reminder_with_original_identity() {
    let ready = TerminalRecoveryFacts {
        has_session: true,
        has_thread: true,
        terminal_observed: false,
        recovery_attempts: 0.0,
        outcome_uncertain: false,
        cancelled: false,
    };
    assert!(terminal_recovery_eligible(&ready));
    assert!(!terminal_recovery_eligible(&TerminalRecoveryFacts {
        recovery_attempts: 1.0,
        ..ready
    }));
    assert!(terminal_recovery_prompt("execution-123").contains("ORIGINAL execution identity"));
}

#[test]
fn final_review_identity_preserves_legacy_reviewer() {
    assert!(is_final_review_agent(Some("reviewer")));
    assert!(is_final_review_agent(Some("job-acceptance-reviewer")));
    assert!(!is_final_review_agent(Some("Review")));
}

#[test]
fn planner_agent_roles_fail_closed_on_repeated_owners() {
    let specs = vec![
        json!({"id":"a","agentName":" director "}),
        json!({"id":"b","agentName":"director"}),
    ];
    assert!(validate_planner_agent_roles(&specs)
        .unwrap_err()
        .contains("duplicate effective Agent role director"));
    assert!(validate_planner_agent_roles(&[
        json!({"id":"a","agentName":"builder"}),
        json!({"id":"b","agentName":"designer"}),
    ])
    .is_ok());
}

#[test]
fn sibling_dag_tasks_share_slot_but_ordinary_workers_do_not() {
    let a = json!({"id":"a","state":"RUNNING","executionId":"exec-a","dagNode":{"parentTaskId":"coord"}});
    let sibling = json!({"id":"b","state":"RUNNING","executionId":"exec-b","dagNode":{"parentTaskId":"coord"}});
    let unrelated = json!({"id":"c","state":"RUNNING","executionId":"exec-c"});
    let siblings = json!({"tasks":[a.clone(),sibling],"plans":[]});
    assert!(!job_has_conflicting_execution(&siblings, &a));
    assert!(job_has_active_execution(&siblings, Some("a"), None));
    let outsiders = json!({"tasks":[a.clone(),unrelated],"plans":[]});
    assert!(job_has_conflicting_execution(&outsiders, &a));
}
