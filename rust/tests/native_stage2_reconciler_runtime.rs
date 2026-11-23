// Source: Node src/reconciler-runtime.ts. Native source-port safety tests
// for correlated lifecycle events and after-commit execution ownership.
// All fixture data stays in memory, no live Relay or production Job.
use agents_relay_rust2::{
    execution_event_identity::execution_event_source,
    reconciler_runtime::ReconcilerRuntime,
    relay_store::SQLiteRelayStore,
};
use serde_json::{json,Value};
use std::{path::{Path,PathBuf}};
fn graph()->PathBuf{
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow")
}
fn task()->Value{
    json!({"id":"2","jobId":"101","title":"Worker",
        "kind":"work","agentName":"worker","adapter":"codex",
        "state":"QUEUED","executionId":"e1","leaseOwner":"relay",
        "leaseExpiresAt":"2026-12-01T00:00:00.000Z",
        "timeoutMs":30000,"attempt":1,"maxAttempts":3,
        "createdAt":"2026-11-17T11:00:00.000Z",
        "updatedAt":"2026-11-17T11:00:00.000Z",
        "executionHistory":[{"id":"e1","attempt":1,
            "startedAt":"2026-11-17T11:00:00.000Z"}],
        "dependencies":[],"reviewHeadSha":null})
}
fn job()->Value{
    json!({"id":"101","repository":"toy","projectRoot":"/tmp/toy",
        "state":"ACTIVE","createdAt":"2026-11-17T11:00:00.000Z",
        "updatedAt":"2026-11-17T11:00:00.000Z",
        "tasks":[task()],"plans":[],"reviewEnabled":false,
        "headSha":null,"pause":null})
}
fn event(kind:&str,source:&str)->Value{
    json!({"event_id":format!("event-{kind}"),
        "job_id":"101","task_id":"2","parent_task_id":null,
        "type":kind,"status":"succeeded","message":"verified result",
        "timestamp":"2026-11-17T12:00:00.000Z",
        "data":{"evidence":"fixed"},"source":{
            "id":source,"agent":"worker","component":"tests"}})
}
#[test]
fn unrelated_event_and_spoofed_start_never_mutate_job(){
    let mut runtime=ReconcilerRuntime::new("relay");
    let original=job();
    let unrelated=runtime.apply_event(&graph(),&original,
        &event("other","untrusted"),None).unwrap();
    assert!(!unrelated.applied);
    assert_eq!(unrelated.job,original);
    let forged=runtime.apply_event(&graph(),&original,
        &event("task.started","job/101/task/2/execution/wrong"),None).unwrap();
    assert!(!forged.applied);
    assert_eq!(forged.job,original);
    let wake=runtime.apply_event(&graph(),&original,
        &event("job.wake","system"),None).unwrap();
    assert!(wake.reconcile);
    assert_eq!(wake.job,original);
}
#[test]
fn start_requires_correct_generation_and_graph_transition(){
    let mut runtime=ReconcilerRuntime::new("relay");
    let original=job();
    runtime.register_execution("101","2","e1",None).unwrap();
    assert!(runtime.register_execution("101","2","e2",None).is_err());
    let source=execution_event_source("101","2","e1");
    let started=runtime.apply_event(&graph(),&original,
        &event("task.started",&source),None).unwrap();
    assert!(started.applied);
    assert_eq!(started.job["tasks"][0]["state"],"RUNNING");
    assert_eq!(started.job["tasks"][0]["executionId"],"e1");
    assert!(!started.reconcile);
    assert!(!runtime.live.get("2").unwrap().worker_started);
    runtime.finalize_after_commit(&started);
    assert!(runtime.live.get("2").unwrap().worker_started);
    assert!(!runtime.idle());
}
#[test]
fn terminal_is_authoritative_only_after_sqlite_commit(){
    let mut runtime=ReconcilerRuntime::new("relay");
    runtime.register_execution("101","2","e1",None).unwrap();
    let source=execution_event_source("101","2","e1");
    let started=runtime.apply_event(&graph(),&job(),
        &event("task.started",&source),None).unwrap();
    let failed=runtime.apply_event(&graph(),&started.job,
        &event("task.completed","job/101/task/2/execution/forged"),None).unwrap();
    assert!(!failed.applied);
    let completed=runtime.apply_event(&graph(),&started.job,
        &event("task.completed",&source),None).unwrap();
    assert!(completed.applied);
    assert!(completed.reconcile);
    assert_eq!(completed.job["tasks"][0]["state"],"SUCCEEDED");
    assert!(completed.job["tasks"][0]["executionId"].is_null());
    assert_eq!(completed.job["tasks"][0]["result"]["summary"],"verified result");
    // The candidate snapshot is NOT yet durable. If SQLite rejects it the
    // original execution owner remains available for retry/recovery.
    assert!(runtime.live.contains_key("2"),
        "terminal application must not clear generation before SQLite commit");
    // The test models a verified successful durable commit explicitly.
    runtime.finalize_after_commit(&completed);
    assert!(!runtime.live.contains_key("2"),
        "commit must release exactly the terminal generation");
}
#[test]
fn final_review_cannot_approve_with_generic_worker_completed(){
    let mut runtime=ReconcilerRuntime::new("relay");
    let mut original=job();
    original["tasks"][0]["agentName"]=json!("final-review");
    original["tasks"][0]["reviewHeadSha"]=json!("head1");
    original["headSha"]=json!("head1");
    original["review"]=json!({"outcome":"pending","headSha":"head1",
        "taskId":"2"});
    let source=execution_event_source("101","2","e1");
    let candidate=runtime.apply_event(&graph(),&original,
        &event("task.completed",&source),Some("head1")).unwrap();
    assert_eq!(candidate.job["tasks"][0]["state"],"QUEUED");
    assert_ne!(candidate.job.pointer("/review/outcome"),
        Some(&json!("approved")));
}

#[test]
fn real_sqlite_rollback_preserves_owned_generation_until_durable_accept(){
    let store=SQLiteRelayStore::open(Path::new(":memory:"),None).unwrap();
    let baseline=job();
    store.save_job(&baseline).unwrap();
    let mut runtime=ReconcilerRuntime::new("relay");
    runtime.register_execution("101","2","e1",None).unwrap();
    let source=execution_event_source("101","2","e1");
    let start=runtime.apply_event(&graph(),&baseline,
        &event("task.started",&source),None).unwrap();
    assert!(store.mutate_job("101",|_|Err("simulated write failure".into())).is_err());
    assert_eq!(store.load_job("101").unwrap().unwrap()["tasks"][0]["state"],"QUEUED");
    assert!(!runtime.live.get("2").unwrap().worker_started);
    let started=store.mutate_job("101",|latest|{
        assert_eq!(latest["tasks"][0]["executionId"],"e1");
        Ok(start.job.clone())
    }).unwrap();
    runtime.finalize_after_commit(&start);
    assert!(runtime.live.get("2").unwrap().worker_started);
    let terminal=runtime.apply_event(&graph(),&started,
        &event("task.completed",&source),None).unwrap();
    assert_eq!(terminal.job["tasks"][0]["state"],"SUCCEEDED");
    assert!(store.mutate_job("101",|_|Err("simulated transaction rollback".into())).is_err());
    assert!(runtime.live.contains_key("2"));
    assert_eq!(store.load_job("101").unwrap().unwrap()["tasks"][0]["state"],"RUNNING");
    let stored=store.mutate_job("101",|fresh|{
        assert_eq!(fresh["tasks"][0]["executionId"],"e1");
        Ok(terminal.job.clone())
    }).unwrap();
    runtime.finalize_after_commit(&terminal);
    assert_eq!(stored["tasks"][0]["state"],"SUCCEEDED");
    assert_eq!(store.load_job("101").unwrap().unwrap()["tasks"][0]["state"],"SUCCEEDED");
    assert!(!runtime.live.contains_key("2"));
}
