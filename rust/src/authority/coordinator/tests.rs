//! Coordinator unit tests across Task Graph, SQLite and DAG checkpointing.
use super::*;
use crate::authority::tests::setup;
fn begin(store: &mut RelayAuthority) {
    store
        .commit_job("91", "2026-11-13T20:00:01.000Z", |prior| {
            let mut job = prior.clone();
            job["updatedAt"] = json!("2026-11-13T20:00:01.000Z");
            job["tasks"][0]["agentGraph"] = json!(
                "flowchart TD\nA[agent:first]\nB[agent:second]\nA --> C[agent:last]\nB --> C"
            );
            job["tasks"][0]["state"] = json!("QUEUED");
            job["tasks"][0]["input"] = json!("my task text");
            Ok((job, vec![]))
        })
        .unwrap();
    assert!(store
        .begin_dag_coordinator("91", "101", "2026-11-13T20:00:02.000Z")
        .unwrap());
}
fn request<'a>(root: &'a Path, node: &'a str, at: &'a str) -> DAGMaterialize<'a> {
    DAGMaterialize {
        job_id: "91",
        parent_task_id: "101",
        node_id: node,
        executor: DAGExecutor::Script,
        project_path: root,
        timeout_ms: 120000,
        at,
    }
}
#[test]
fn creates_parallel_ready_children_then_dependent_and_finishes() {
    let (_tmp, path) = setup();
    let mut store = RelayAuthority::open_existing(&path).unwrap();
    begin(&mut store);
    assert!(store
        .materialize_dag_child(request(
            path.parent().unwrap(),
            "C",
            "2026-11-13T20:00:03.000Z"
        ))
        .unwrap()
        .is_none());
    let a = store
        .materialize_dag_child(request(
            path.parent().unwrap(),
            "A",
            "2026-11-13T20:00:04.000Z",
        ))
        .unwrap()
        .unwrap();
    let b = store
        .materialize_dag_child(request(
            path.parent().unwrap(),
            "B",
            "2026-11-13T20:00:05.000Z",
        ))
        .unwrap()
        .unwrap();
    assert_eq!(
        (&a.child_id, &b.child_id),
        (&"102".to_string(), &"103".to_string())
    );
    assert_eq!(a.state, "QUEUED");
    let again = store
        .materialize_dag_child(request(
            path.parent().unwrap(),
            "A",
            "2026-11-13T20:00:06.000Z",
        ))
        .unwrap()
        .unwrap();
    assert!(!again.created);
    assert_eq!(again.child_id, a.child_id);
    assert_eq!(
        store.read_job("91").unwrap().unwrap()["tasks"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    store
        .commit_job("91", "2026-11-13T20:00:07.000Z", |prior| {
            let mut job = prior.clone();
            job["updatedAt"] = json!("2026-11-13T20:00:07.000Z");
            for t in job["tasks"].as_array_mut().unwrap() {
                if t["id"] == "102" || t["id"] == "103" {
                    t["state"] = json!("SUCCEEDED");
                    t["result"] = json!({"data":{"status":"COMPLETED","output":{"verified":true}}});
                }
            }
            Ok((job, vec![]))
        })
        .unwrap();
    let c = store
        .materialize_dag_child(request(
            path.parent().unwrap(),
            "C",
            "2026-11-13T20:00:08.000Z",
        ))
        .unwrap()
        .unwrap();
    assert_eq!(c.child_id, "104");
    assert_eq!(c.dependencies, vec!["102", "103"]);
    assert!(!store
        .complete_dag_coordinator("91", "101", "2026-11-13T20:00:09.000Z")
        .unwrap());
    store
        .commit_job("91", "2026-11-13T20:00:10.000Z", |prior| {
            let mut job = prior.clone();
            job["updatedAt"] = json!("2026-11-13T20:00:10.000Z");
            job["tasks"][3]["state"] = json!("SUCCEEDED");
            Ok((job, vec![]))
        })
        .unwrap();
    assert!(store
        .complete_dag_coordinator("91", "101", "2026-11-13T20:00:11.000Z")
        .unwrap());
    assert!(!store
        .complete_dag_coordinator("91", "101", "2026-11-13T20:00:12.000Z")
        .unwrap());
    let job = store.read_job("91").unwrap().unwrap();
    assert_eq!(job["tasks"][0]["state"], "SUCCEEDED");
    assert_eq!(job["tasks"][0]["result"]["data"]["nodes"]["C"], "104");
}
#[test]
fn graph_changed_or_paused_job_cannot_materialize_child() {
    let (_tmp, path) = setup();
    let mut store = RelayAuthority::open_existing(&path).unwrap();
    begin(&mut store);
    store
        .commit_job("91", "2026-11-13T20:00:03.000Z", |prior| {
            let mut job = prior.clone();
            job["updatedAt"] = json!("2026-11-13T20:00:03.000Z");
            job["tasks"][0]["agentGraph"] = json!("flowchart LR\nA[agent:other]");
            Ok((job, vec![]))
        })
        .unwrap();
    assert!(store
        .materialize_dag_child(request(
            path.parent().unwrap(),
            "A",
            "2026-11-13T20:00:04.000Z"
        ))
        .is_err());
}
