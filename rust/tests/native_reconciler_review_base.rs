// Review Graph and execution ownership actions through one authoritative
// SQLite Job, including revision invalidation and stale verdict suppression.
use agents_relay_rust2::{
    reconciler_review_base::{ReconcilerReviewBase,ReviewBaseHost},
    reconciler_runtime_base::RuntimeBaseStore,
    relay_store::SQLiteRelayStore,
};
use serde_json::{json,Value};
use std::{path::{Path,PathBuf},sync::{Arc,Mutex},time::{SystemTime,UNIX_EPOCH}};
struct ReviewSqliteHost{file:PathBuf,emitted:Mutex<Vec<Value>>}
impl ReviewSqliteHost{
    fn store(&self)->SQLiteRelayStore{SQLiteRelayStore::open(&self.file,Some("41")).unwrap()}
}
impl RuntimeBaseStore for ReviewSqliteHost{
    fn load_job(&self,id:&str)->Result<Value,String>{
        self.store().load_job(id)?.ok_or("No SQLite Job".into())
    }
    fn mutate_job(&self,id:&str,mutation:&mut dyn FnMut(Value)->Result<Value,String>)
        ->Result<Value,String>{self.store().mutate_job(id,mutation)}
    fn reconcile(&self,id:&str)->Result<Value,String>{self.load_job(id)}
    fn emit(&self,event:&Value)->Result<(),String>{
        self.emitted.lock().unwrap().push(event.clone());Ok(())
    }
}
impl ReviewBaseHost for ReviewSqliteHost{
    fn launch(&self,_job:&Value,_task:&Value)->Result<(),String>{Ok(())}
}
#[test]
fn stale_premerge_reviewer_is_cancelled_atomically_without_accepting_old_events(){
    let suffix=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let dir=std::env::temp_dir().join(format!("rust2-review-base-{}-{suffix}",std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let host=Arc::new(ReviewSqliteHost{file:dir.join("review.sqlite"),
        emitted:Mutex::new(vec![])});
    let stamp="2026-11-18T09:00:00Z";
    let job=json!({"id":"41","repository":"fixture","prNumber":0,
        "state":"ACTIVE","headSha":"head-new","createdAt":stamp,"updatedAt":stamp,
        "tasks":[{"id":"review-1","jobId":"41","agentName":"job-acceptance-reviewer",
            "kind":"work","state":"QUEUED","adapter":"codex",
            "executionId":"generation-1","leaseOwner":"relay","leaseExpiresAt":stamp,
            "reviewHeadSha":"head-old","createdAt":stamp,"updatedAt":stamp,
            "attempt":1,"maxAttempts":3,"dependencies":[],"capabilities":[]}],
        "plans":[],"reviewEnabled":true,
        "review":{"outcome":"pending","headSha":"head-old","taskId":"review-1",
            "evidence":null,"updatedAt":stamp}});
    host.store().save_job(&job).unwrap();
    let graph=Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow");
    let runtime=ReconcilerReviewBase::new(graph,&dir,&dir,&dir,&dir,
        vec![],json!({"owner":"relay"}),Arc::clone(&host));
    let invalidated=runtime.invalidate_stale_review("41",Some("head-new")).unwrap();
    assert_eq!(invalidated.job["review"]["outcome"],"stale");
    assert_eq!(invalidated.job["tasks"][0]["state"],"CANCELLED");
    let persisted=host.load_job("41").unwrap();
    assert_eq!(persisted["review"]["outcome"],"stale");
    assert_eq!(persisted["tasks"][0]["leaseOwner"],Value::Null);
    assert_eq!(persisted["tasks"][0]["state"],"CANCELLED");
    assert!(invalidated.cancel_execution_ids.contains(&"generation-1".to_owned()));
    let stale=json!({"version":1,"type":"review.approved","job_id":"41",
        "task_id":"review-1","timestamp":stamp,"status":"succeeded",
        "message":"Old generation approved","data":{"headSha":"head-old"},
        "source":{"id":"old-worker"}});
    let discarded=runtime.apply_review_event(&stale).unwrap();
    assert_eq!(discarded.job,persisted);
    assert_eq!(host.load_job("41").unwrap(),persisted);
    runtime.runtime.close().unwrap();drop(runtime);drop(host);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn final_review_creation_has_canonical_agent_and_single_durable_task(){
    let suffix=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let dir=std::env::temp_dir().join(format!("rust2-review-create-{}-{suffix}",std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let host=Arc::new(ReviewSqliteHost{file:dir.join("review.sqlite"),
        emitted:Mutex::new(vec![])});
    let stamp="2026-11-18T09:00:00Z";
    let job=json!({"id":"41","repository":"fixture","prNumber":0,
        "state":"ACTIVE","title":"Native Final Review","objective":"Build test",
        "priority":"P2","headSha":"head-immutable", "createdAt":stamp,
        "updatedAt":stamp,"tasks":[{"id":"task1","jobId":"41",
            "agentName":"worker","kind":"work","state":"SUCCEEDED",
            "adapter":"codex","createdAt":stamp,"updatedAt":stamp,
            "dependencies":[],"capabilities":[]}],"plans":[],"reviewEnabled":true});
    host.store().save_job(&job).unwrap();
    let route=json!({"candidate":{"workerId":"mock-reviewer",
        "adapter":"codex","runtime":"codex","capabilities":["model"]},
        "selection":{"workerId":"mock-reviewer","selectedBy":"fixture"},
        "routing":{"provider":"mock","model":"mock-reviewer","reasoning":"medium"}});
    let graph=Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow");
    let runtime=ReconcilerReviewBase::new(graph,&dir,&dir,&dir,&dir,
        vec![],json!({"owner":"relay"}),Arc::clone(&host));
    let created=runtime.ensure_final_review("41",Some("head-immutable"),
        Some(&route)).unwrap();
    let persisted=host.load_job("41").unwrap();
    assert_eq!(persisted["tasks"].as_array().unwrap().len(),2);
    assert_eq!(persisted["tasks"][1]["agentName"],"job-acceptance-reviewer");
    assert_eq!(persisted["tasks"][1]["reviewHeadSha"],"head-immutable");
    assert_eq!(persisted["review"]["outcome"],"pending");
    assert_eq!(persisted["review"]["taskId"],persisted["tasks"][1]["id"]);
    assert_eq!(created.events.len(),1);
    assert_eq!(created.events[0]["type"],"review.created");
    assert_eq!(created.events[0]["data"]["agentName"],"job-acceptance-reviewer");
    assert_eq!(host.emitted.lock().unwrap().len(),1);
    // Reconciliation is idempotent: no duplicate reviewer for the same SHA.
    let subsequent=runtime.ensure_final_review("41",Some("head-immutable"),
        Some(&route)).unwrap();
    assert!(subsequent.events.is_empty());
    assert_eq!(host.load_job("41").unwrap()["tasks"].as_array().unwrap().len(),2);
    runtime.runtime.close().unwrap();drop(runtime);drop(host);
    std::fs::remove_dir_all(dir).unwrap();
}
