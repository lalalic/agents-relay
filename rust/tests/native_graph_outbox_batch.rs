// Native Rust boundary tests for direct Node Graph-v2, Agent Graph, workflow definitions and transactional SQLite outbox.
use agents_relay_rust2::{
    agent_graph::{parse_agent_graph, validate_agent_selection},
    workflow::{
        definitions_v2::assert_v2_state_transition,
        durable_publication::{
            DurableWorkflowConsumer, DurableWorkflowPublication, PendingWorkflowEvent,
        },
        graph_v2::{parse_graph_v2, GraphRegistry, GraphRuntime},
        runtime::{apply_task_graph_target, apply_task_mutation},
    },
};
use rusqlite::Connection;
use serde_json::json;
use std::collections::HashSet;
#[test]
fn graph_rejects_malformed_topology_and_validates_execution_transition() {
    let source="flowchart LR\n%% relay: initial start\nstart[\"state: DRAFT\"]\nend[\"state: ACTIVE\"]\nstart -->|on: activate| end";
    let graph = parse_graph_v2(source).unwrap();
    assert!(assert_v2_state_transition(&graph, "DRAFT", "ACTIVE", "Job").is_ok());
    assert!(assert_v2_state_transition(&graph, "ACTIVE", "DRAFT", "Job")
        .unwrap_err()
        .contains("Invalid Job transition"));
    assert!(parse_graph_v2(&source.replace("on: activate", "on: invalid value")).is_err());
    assert!(GraphRuntime::new(source, GraphRegistry::default())
        .err()
        .unwrap()
        .contains("unknown state"));
}
#[test]
fn agent_graph_enforces_dag_and_visible_source_layers() {
    let source = "flowchart TD\nstrategy --> deliver\nreview --> deliver\ndeliver --> publish";
    let graph = parse_agent_graph(source).unwrap();
    assert_eq!(
        graph.waves,
        vec![
            vec!["review".to_string(), "strategy".to_string()],
            vec!["deliver".into()],
            vec!["publish".into()]
        ]
    );
    let visible = vec!["review", "strategy", "deliver", "publish"]
        .into_iter()
        .map(str::to_string)
        .collect::<HashSet<_>>();
    assert!(validate_agent_selection(&visible, None, Some(source)).is_ok());
    assert!(validate_agent_selection(&visible, Some("missing"), None)
        .unwrap_err()
        .contains("not visible"));
    assert!(parse_agent_graph("flowchart TD\na --> b\nb --> a")
        .unwrap_err()
        .contains("cycle"));
}
#[test]
fn outbox_rollback_and_inbox_replay_keep_sqlite_authoritative() {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("CREATE TABLE value (n INTEGER); INSERT INTO value VALUES(0)")
        .unwrap();
    let out = DurableWorkflowPublication::new(&db).unwrap();
    let inbox = DurableWorkflowConsumer::new(&db).unwrap();
    let item = PendingWorkflowEvent {
        key: "job/task/e1".into(),
        event_id: "task.completed".into(),
        payload: json!({"job":"job","task":"task"}),
    };
    assert!(out
        .commit_transition_and_events(
            |db| {
                db.execute("UPDATE value SET n=n+1", [])
                    .map_err(|e| e.to_string())?;
                Err("fixture rollback".to_string())
            },
            std::slice::from_ref(&item)
        )
        .is_err());
    let n: i64 = db
        .query_row("SELECT n FROM value", [], |row| row.get(0))
        .unwrap();
    assert_eq!(n, 0);
    assert!(out.pending().unwrap().is_empty());
    out.commit_transition_and_events(
        |db| {
            db.execute("UPDATE value SET n=n+1", [])
                .map_err(|e| e.to_string())?;
            Ok(())
        },
        std::slice::from_ref(&item),
    )
    .unwrap();
    assert_eq!(out.pending().unwrap().len(), 1);
    assert!(inbox
        .consume("worker", &item, |db| {
            db.execute("UPDATE value SET n=n+1", [])
                .map_err(|e| e.to_string())?;
            Ok(())
        })
        .unwrap());
    assert!(!inbox
        .consume("worker", &item, |_| Err("replayed side effect".into()))
        .unwrap());
    assert_eq!(
        out.replay(|_| Err("publish failed".into())).unwrap_err(),
        "publish failed"
    );
    assert_eq!(out.pending().unwrap().len(), 1);
    assert_eq!(out.replay(|_| Ok(())).unwrap(), 1);
    assert!(out.pending().unwrap().is_empty());
    let n: i64 = db
        .query_row("SELECT n FROM value", [], |row| row.get(0))
        .unwrap();
    assert_eq!(n, 2);
}
#[test]
fn blocked_tasks_require_authoritative_troubleshooter_unblock() {
    let timestamp = "2026-11-17T05:00:00.000Z";
    let mut task = json!({"id":"5","agentName":"worker","state":"BLOCKED","updatedAt":"2026-11-16T05:00:00.000Z"});
    assert!(apply_task_graph_target(&mut task, "QUEUED", timestamp, true).is_err());
    task["agentName"] = json!("troubleshooter");
    assert!(apply_task_graph_target(&mut task, "QUEUED", timestamp, false).is_err());
    apply_task_graph_target(&mut task, "QUEUED", timestamp, true).unwrap();
    assert_eq!(task["state"], "QUEUED");
    task["error"] = json!("prior failure");
    apply_task_mutation(&mut task, "mutation.clearError", timestamp).unwrap();
    assert!(task["error"].is_null());
}
