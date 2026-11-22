use agents_relay_rust2::{
    interactive_invocation::host_interactive_decision_event,
    native_host_review_ingress::apply_durable_host_review_event,
    relay_store::SQLiteRelayStore,
};
use serde_json::json;
use std::path::PathBuf;
use std::time::{SystemTime,UNIX_EPOCH};

#[test]
fn mobile_approve_is_durably_graph_resumed_once_and_stale_source_is_ignored(){
    let suffix=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root=std::env::temp_dir().join(format!("rust2-real-review-ingress-{}-{suffix}",std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let db_path=root.join("relay.sqlite");
    let graph=PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../workflow");
    let db=SQLiteRelayStore::open(&db_path,Some("55")).unwrap();
    let old="2026-11-18T07:00:00.000Z";
    db.save_job(&json!({"id":"55","repository":"fixture","title":"fixture",
        "prNumber":0,"state":"ACTIVE","createdAt":old,"updatedAt":old,"plans":[],
        "tasks":[{"id":"8","jobId":"55","kind":"work","state":"AWAITING_DECISION",
            "adapter":"script","attempt":1,"maxAttempts":3,
            "executionId":null,"leaseOwner":null,"leaseExpiresAt":null,
            "createdAt":old,"updatedAt":old,"dependencies":[],"capabilities":[],
            "interactiveInvocation":{"invocationId":"review-execution-1",
                "executionId":"review-execution-1","revision":"review-execution-1",
                "status":"awaiting_decision","boundAt":old}}
        ]
    })).unwrap();
    drop(db);
    let event=host_interactive_decision_event(
        &json!({"jobId":"55","taskId":"8","executionId":"review-execution-1"}),
        &json!({"eventId":"real-test-id-33","decision":"approved","feedback":"", "comments":[]}),
        "2026-11-18T07:01:00.000Z").unwrap();
    let mut wrong=event.clone();
    wrong["source"]["id"]=json!("job/55/task/8/execution/invalid");
    assert!(apply_durable_host_review_event(&db_path,&graph,"55",&wrong).unwrap().is_none());
    let (resumed,receipt)=apply_durable_host_review_event(&db_path,&graph,"55",&event)
        .unwrap().expect("Review acceptance must persist and release Task");
    assert_eq!(resumed["tasks"][0]["state"],"QUEUED");
    assert_eq!(resumed["tasks"][0]["interactiveInvocation"]["status"],"approved");
    assert_eq!(receipt["type"],"task.interactive_decision.accepted");
    assert!(apply_durable_host_review_event(&db_path,&graph,"55",&event).unwrap().is_none(),
        "same old approval must never revive another generation");
    let reopened=SQLiteRelayStore::open_without_claim_reset(&db_path,Some("55")).unwrap();
    assert_eq!(reopened.load_job("55").unwrap().unwrap()["tasks"][0]["state"],"QUEUED");
    drop(reopened);
    std::fs::remove_dir_all(&root).unwrap();
}
