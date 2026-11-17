// Native Wave2 Graph regression: no live stores, controlled input and Graph source.
use agents_relay_rust2::{
    task_transitions::{completion_gate_satisfied, extend_retry_budget},
    workflow::{
        authoritative_conditions::verify_authoritative_condition,
        planner_orchestration_v2::{decide_planner_orchestration, planner_orchestration_facts},
        task_reconcile::{dependency_ready, detect_cycles, reconcile_task_dependencies},
        task_resolution::{
            classify_task_resolution, decide_task_resolution, validate_resolution_proposal,
        },
    },
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{collections::HashMap, path::PathBuf};
fn canonical() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("workflow")
}
fn task(id: &str, state: &str, deps: &[&str]) -> Value {
    json!({"id":id,"jobId":"42","kind":"implementation","state":state,"agentName":"developer",
        "dependencies":deps,"executionId":null,"leaseOwner":null,"leaseExpiresAt":null,
        "attempt":0,"maxAttempts":3})
}
fn job(tasks: Vec<Value>) -> Value {
    json!({"id":"42","state":"ACTIVE","plans":[],"tasks":tasks,"reviewEnabled":false})
}
#[test]
fn rejects_cycles_even_when_separated_by_missing_external_dependency() {
    let tasks = vec![task("a", "DRAFT", &["missing"]), task("b", "DRAFT", &["a"])];
    assert!(detect_cycles(&tasks).is_ok());
    let mut cycle = tasks.clone();
    cycle[0]["dependencies"] = json!(["b"]);
    assert_eq!(detect_cycles(&cycle), Err("Dependency cycle at a".into()));
    let map = tasks
        .iter()
        .map(|t| (t["id"].as_str().unwrap().to_string(), t.clone()))
        .collect::<HashMap<_, _>>();
    assert!(!dependency_ready(&tasks[1], &map));
    let mut ready = tasks[1].clone();
    ready["dependencies"] = json!([]);
    assert!(dependency_ready(&ready, &map));
}
#[test]
fn graph_reconciler_never_dispatches_unready_failed_tasks() {
    let mut j = job(vec![
        task("a", "SUCCEEDED", &[]),
        task("b", "DRAFT", &["a"]),
        task("c", "DRAFT", &["missing"]),
    ]);
    reconcile_task_dependencies(&canonical(), &mut j, "2026-11-17T10:00:00Z").unwrap();
    assert_eq!(j["tasks"][1]["state"], "QUEUED");
    assert_ne!(j["tasks"][2]["state"], "QUEUED");
    let mut cyclic = job(vec![task("a", "DRAFT", &["b"]), task("b", "DRAFT", &["a"])]);
    let before = cyclic.clone();
    assert!(
        reconcile_task_dependencies(&canonical(), &mut cyclic, "2026-11-17T10:00:00Z")
            .unwrap_err()
            .contains("Dependency cycle at")
    );
    assert_eq!(cyclic, before);
}
#[test]
fn resolution_fails_closed_and_classification_requires_original_execution_cleared() {
    let mut failed = task("a", "FAILED", &[]);
    let proposal = json!({"path":"exact_original_retry"});
    let j = job(vec![failed.clone()]);
    assert!(validate_resolution_proposal(&j, &failed, &proposal).is_ok());
    let rejected = decide_task_resolution(&canonical(), &failed, &proposal, &json!(null)).unwrap();
    assert_ne!(rejected["target"], "resolved");
    let invalid = json!({"kind":"invalid","targetTaskId":"successor","evidence":"trace","reason":"original failure obsolete"});
    let applied =
        classify_task_resolution(&canonical(), &mut failed, &invalid, "2026-11-17T10:00:00Z")
            .unwrap();
    assert_eq!(applied["kind"], "invalid");
    assert_eq!(
        failed["resolutionClassification"]["targetTaskId"],
        "successor"
    );
    assert!(
        classify_task_resolution(&canonical(), &mut failed, &invalid, "2026-11-17T10:00:00Z")
            .is_err()
    );
    let mut executing = task("x", "FAILED", &[]);
    executing["executionId"] = json!("still-running");
    assert!(classify_task_resolution(
        &canonical(),
        &mut executing,
        &invalid,
        "2026-11-17T10:00:00Z"
    )
    .is_err());
}
#[test]
fn planner_facts_keep_failed_manual_round_in_review_holding_pattern() {
    let mut j = job(vec![task("a", "FAILED", &[])]);
    j["plans"] = json!([{"id":"p","round":2,"status":"FAILED","manualPlanning":true,
      "forceRestate":false,"trigger":{"source":"manual"},"createdAt":"2026-11-17T10:00:00Z"}]);
    let facts = planner_orchestration_facts(&j, false);
    assert_eq!(facts["noActivePlanner"], false);
    assert_eq!(facts["terminalPlanFailure"], false);
    let decision = decide_planner_orchestration(&canonical(), &facts).unwrap();
    assert!(decision["target"] == "wait" || decision["accepted"] == false);
    j["plans"][0]["manualPlanning"] = json!(false);
    let recovery_facts = planner_orchestration_facts(&j, false);
    assert_eq!(recovery_facts["terminalPlanFailure"], true);
    assert_eq!(recovery_facts["planRecoveryExists"], false);
    let recovery_decision = decide_planner_orchestration(&canonical(), &recovery_facts).unwrap();
    assert_eq!(recovery_decision["target"], "created");
    assert!(recovery_decision["actions"]
        .as_array()
        .unwrap()
        .iter()
        .any(|a| a["id"] == "planner.createRecovery"));
}
#[test]
fn completion_requires_plan_or_coordinator_and_all_real_implementations() {
    let impl_task = task("work", "SUCCEEDED", &[]);
    let coordinator = task("coord", "SUCCEEDED", &[]);
    let mut j = job(vec![impl_task.clone(), coordinator]);
    assert!(!completion_gate_satisfied(&j));
    j["tasks"][1]["title"] = json!("Coordinator");
    j["tasks"][1]["agentGraph"] = json!({"nodes":[]});
    assert!(completion_gate_satisfied(&j));
    j["tasks"][0]["state"] = json!("RUNNING");
    assert!(!completion_gate_satisfied(&j));
    assert_eq!(extend_retry_budget(3.0, 3.0, 3.0).unwrap(), 6.0);
    assert!(extend_retry_budget(1.0, 2.0, 0.0).is_err());
    assert!(extend_retry_budget(1.0, 2.0, 2.5).is_err());
}
#[test]
fn sqlite_verification_requires_correlated_ended_process_not_just_changed_execution_id() {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT)")
        .unwrap();
    let mut t = task("a", "FAILED", &[]);
    t["executionHistory"] = json!([{"id":"old","attempt":1}]);
    t["executionId"] = json!("new");
    let j = job(vec![t]);
    db.execute(
        "INSERT INTO job_snapshot VALUES(?1,?2)",
        params!["42", j.to_string()],
    )
    .unwrap();
    assert_eq!(
        verify_authoritative_condition(&db, "42", "task.execution-stopped", Some("a"), Some("old"))
            .unwrap(),
        "Unknown"
    );
    db.execute_batch(
        "CREATE TABLE execution_process(job_id TEXT,task_id TEXT,execution_id TEXT,ended_at TEXT)",
    )
    .unwrap();
    db.execute(
        "INSERT INTO execution_process VALUES('42','a','old',NULL)",
        [],
    )
    .unwrap();
    assert_eq!(
        verify_authoritative_condition(&db, "42", "task.execution-stopped", Some("a"), Some("old"))
            .unwrap(),
        "Unknown"
    );
    db.execute(
        "UPDATE execution_process SET ended_at='2026-11-17T10:00:00Z'",
        [],
    )
    .unwrap();
    assert_eq!(
        verify_authoritative_condition(&db, "42", "task.execution-stopped", Some("a"), Some("old"))
            .unwrap(),
        "Verified"
    );
    assert_eq!(
        verify_authoritative_condition(&db, "42", "task.execution-stopped", Some("a"), Some("new"))
            .unwrap(),
        "Failed"
    );
    assert_eq!(
        verify_authoritative_condition(&db, "42", "task.failed", Some("a"), None).unwrap(),
        "Verified"
    );
}
