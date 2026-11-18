// Real durable effects for missing Node API entrypoints. All tests use an
// isolated in-memory RelayStore; no canonical user SQLite or EventBus.
use agents_relay_rust2::{
    dependency_revision_execution::reconcile_dependency_revisions,
    interactive_request::fail_interactive_review,
    interactive_resume::recover_interactive_decisions,
    relay_store::SQLiteRelayStore,
    task_actions::dispatch_task_action,
    task_update::{apply_managed_task_update, managed_task_update_handler},
    unblock::unblock_task,
};
use serde_json::{json,Value};
use std::{path::{Path,PathBuf},time::{SystemTime,UNIX_EPOCH}};
fn graph()->PathBuf {PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../workflow")}
fn fixture(id:&str)->Value{
    json!({"id":id,"repository":"local-api","prNumber":0,"projectRoot":"/tmp/local-api",
        "state":"ACTIVE","priority":"P2","plans":[],"tasks":[{
        "id":"11","jobId":id,"title":"Test work","kind":"work","state":"DRAFT",
        "agentName":"builder","adapter":"script","priority":"P2","storySize":"M",
        "attempt":0,"maxAttempts":3,"dependencies":[],"capabilities":[],
        "input":"Test","output":{"kind":"file","path":"out.txt"},"leaseOwner":null,
        "leaseExpiresAt":null,"executionId":null,"error":null,
        "updatedAt":"2026-11-17T19:00:00.000Z",
        "createdAt":"2026-11-17T19:00:00.000Z"
        }],"createdAt":"2026-11-17T19:00:00.000Z",
        "updatedAt":"2026-11-17T19:00:00.000Z"})
}
fn store(id:&str)->SQLiteRelayStore {
    let store=SQLiteRelayStore::open(Path::new(":memory:"),None).unwrap();
    store.save_job(&fixture(id)).unwrap();store
}
#[test]
fn update_task_writes_sqlite_and_conflicts_do_not_partially_commit(){
    let db=store("21");
    let proposed={let mut task=db.load_job("21").unwrap().unwrap()["tasks"][0].clone();
        task["input"]=json!("Edited durable objective");task};
    let updated=apply_managed_task_update(&graph(),&db,"21","11",
        &proposed,"2026-11-17T19:00:00.000Z").unwrap();
    assert_eq!(updated["tasks"][0]["input"],"Edited durable objective");
    let latest=db.load_job("21").unwrap().unwrap();
    assert_eq!(latest["tasks"][0]["input"],"Edited durable objective");
    let err=apply_managed_task_update(&graph(),&db,"21","11",
        &proposed,"2026-11-17T19:00:00.000Z").unwrap_err();
    assert_eq!(err,"Task changed since update preflight; refresh and retry");
    assert_eq!(db.load_job("21").unwrap().unwrap(),latest);
    let mut invalid=latest["tasks"][0].clone();
    invalid["dependencies"]=json!(["11"]);
    assert_eq!(apply_managed_task_update(&graph(),&db,"21","11",
        &invalid,latest["tasks"][0]["updatedAt"].as_str().unwrap()).unwrap_err(),
        "Task cannot depend on itself");
    assert_eq!(db.load_job("21").unwrap().unwrap(),latest);
}
#[test]
fn handler_wakes_only_after_committed_task_update(){
    let path=PathBuf::from(format!("/tmp/rust2-sqlite-api-test-{}-{}",
        std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
    std::fs::create_dir_all(&path).unwrap();
    let db=SQLiteRelayStore::open(&path.join("relay.sqlite"),None).unwrap();
    db.save_job(&fixture("22")).unwrap();db.close().unwrap();
    let mut wakes=vec![];
    let file=path.join("relay.sqlite");
    let graph_dir=graph();
    let mut handler=managed_task_update_handler(&graph_dir,
        |_|Ok((SQLiteRelayStore::open(&file,None)?, "local-api".into(),0)),
        |repo,pr,id|{wakes.push(format!("{repo}/{pr}/{id}"));Ok(())});
    let mut proposed=fixture("22")["tasks"][0].clone();
    proposed["input"]=json!("Handler saved");
    handler("22","11",&proposed,"2026-11-17T19:00:00.000Z").unwrap();
    assert!(handler("22","11",&proposed,"stale").is_err());
    drop(handler);
    assert_eq!(wakes,vec!["local-api/0/22"]);
    let verified=SQLiteRelayStore::open(&file,None).unwrap();
    assert_eq!(verified.load_job("22").unwrap().unwrap()["tasks"][0]["input"],"Handler saved");
    verified.close().unwrap();std::fs::remove_dir_all(path).unwrap();
}
#[test]
fn interactive_review_delivery_failure_is_execution_fenced(){
    let db=store("23");
    db.mutate_job("23",|mut job|{
        job["tasks"][0]["state"]=json!("RUNNING");
        job["tasks"][0]["executionId"]=json!("gen-1");
        job["tasks"][0]["interactiveInvocation"]=json!({
            "invocationId":"gen-1","executionId":"gen-1","revision":"gen-1",
            "status":"awaiting_decision"});
        Ok(job)
    }).unwrap();
    assert_eq!(fail_interactive_review(&graph(),&db,"23","11","wrong","unreachable")
        .unwrap()["requeued"],false);
    assert_eq!(db.load_job("23").unwrap().unwrap()["tasks"][0]
        ["interactiveInvocation"]["invocationId"],"gen-1");
    assert_eq!(fail_interactive_review(&graph(),&db,"23","11","gen-1","unreachable")
        .unwrap()["requeued"],false);
    let updated=db.load_job("23").unwrap().unwrap();
    assert!(updated["tasks"][0].get("interactiveInvocation").is_none());
    assert_eq!(updated["tasks"][0]["state"],"RUNNING");
    assert_eq!(updated["tasks"][0]["executionId"],"gen-1");
    assert_eq!(recover_interactive_decisions(&graph(),&db,"23").unwrap(),false);
}
#[test]
fn denied_unblock_and_task_action_cannot_overwrite_sqlite(){
    let db=store("24");let original=db.load_job("24").unwrap().unwrap();
    let error=unblock_task(&graph(),&db,"24","11","cli","why",None,None,None).unwrap_err();
    assert_eq!(error,"Task 11 is not an effective BLOCKED work task");
    assert!(dispatch_task_action(&graph(),&db,&json!({
        "jobId":"24","taskId":"11","id":"task.never-supported"
    })).is_err());
    assert_eq!(db.load_job("24").unwrap().unwrap(),original);
}
#[test]
fn dependency_revisions_do_not_allocate_without_changed_upstream(){
    let db=store("25");
    let temp=std::env::temp_dir().join(format!("rust2-rev-empty-{}",std::process::id()));
    let made=reconcile_dependency_revisions(&graph(),&temp,&db,"25").unwrap();
    assert!(made.is_empty());
    assert_eq!(db.load_job("25").unwrap().unwrap(),fixture("25"));
}
