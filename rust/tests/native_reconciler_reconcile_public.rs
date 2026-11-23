// Native Reconciler.reconcile: real SQLite CAS before effects, terminal and
// paused Jobs preserve Graph/SQLite head refresh and reject stale generations.
use agents_relay_rust2::{reconciler::Reconciler,
    reconciler_durable::ReconcileHost,relay_store::SQLiteRelayStore};
use serde_json::{json,Value};
use std::{path::{Path,PathBuf},time::{SystemTime,UNIX_EPOCH}};
struct Host{store:SQLiteRelayStore,root:PathBuf,persisted:usize,launched:usize,
    emitted:usize,inject_race:bool,forced_failure:Option<String>,events:Vec<Value>}
impl ReconcileHost for Host{
 fn load(&mut self,id:&str)->Result<Value,String>{
     self.store.load_job(id)?.ok_or_else(||"Job missing".into())
 }
 fn load_execution_process(&mut self,job_id:&str,task_id:&str,
     execution_id:&str)->Result<Option<Value>,String>{
     self.store.load_execution_process(job_id,task_id,execution_id)
 }
 fn persist(&mut self,id:&str,prior:&Value,next:&Value)->Result<Value,String>{
     self.persisted+=1;
     if self.inject_race{
         self.store.mutate_job(id,|mut value|{
             value["headSha"]=json!("concurrent-writer");Ok(value)
         })?;
     }
     self.store.mutate_job(id,|current|{
         if &current!=prior{return Err("SQLite generation CAS conflict".into());}
         Ok(next.clone())
     })
 }
 fn launch(&mut self,action:&Value)->Result<(),String>{
     if let Some(error)=self.forced_failure.as_deref(){
         return Err(error.into());
     }
     if action["action"]!="effect.launchTask"{
         return Err("Unexpected external effect in recovery fixture".into());
     }
     let job_id=action["jobId"].as_str().ok_or("Job ID missing")?;
     let task_id=action["taskId"].as_str().ok_or("Task ID missing")?;
     let current=self.store.load_job(job_id)?.ok_or("Job missing")?;
     let mut rec=rec(&self.root);
     let claimed=rec.claim_task_execution(&current,task_id)?
         .ok_or("Task execution already claimed")?;
     self.store.mutate_job(job_id,|fresh|{
         if fresh!=current{return Err("Task lease CAS conflict".into());}
         Ok(claimed)
     })?;
     self.launched+=1;Ok(())
 }
 fn broadcast(&mut self,event:&Value)->Result<(),String>{
     self.events.push(event.clone());
     self.emitted+=1;Ok(())
 }
}
fn fixture(state:&str,paused:bool)->(PathBuf,Host){
 let suffix=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
 let root=std::env::temp_dir().join(format!("rust2-reconcile-{}-{suffix}",std::process::id()));
 std::fs::create_dir_all(&root).unwrap();
 let store=SQLiteRelayStore::open(&root.join("relay.sqlite"),Some("1")).unwrap();
 store.save_job(&json!({"id":"1","repository":"fixture","projectRoot":root,"prNumber":0,
     "title":"Reconcile","objective":"No work","state":state,
     "createdAt":"2026-11-18T09:00:00.000Z","updatedAt":"2026-11-18T09:00:00.000Z",
     "tasks":[],"plans":[],"reviewEnabled":false,
     "pause":if paused{json!({"reason":"operator"})}else{Value::Null},
     "headSha":"old-head"})).unwrap();
 (root.clone(),Host{store,root,persisted:0,launched:0,emitted:0,
     inject_race:false,forced_failure:None,events:Vec::new()})
}
fn rec(root:&Path)->Reconciler{
 Reconciler::new(Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow"),
     root,root,root,root,json!({"owner":"fixture","maxConcurrent":4}))
}
#[test]
fn paused_and_terminal_head_refresh_is_persisted_once_idempotently(){
 for (state,paused) in [("DRAFT",false),("COMPLETED",false),("ACTIVE",true)]{
     let (root,mut host)=fixture(state,paused);let mut reconciler=rec(&root);
     let first=reconciler.reconcile("1",Some("new-head"),&root,&json!({}),
         &[],&[],None,&mut host).unwrap();
     assert_eq!(first["headSha"],"new-head");
     assert_eq!(host.load("1").unwrap()["headSha"],"new-head");
     assert_eq!(host.persisted,1);
     let repeated=reconciler.reconcile("1",Some("new-head"),&root,
         &json!({}),&[],&[],None,&mut host).unwrap();
     assert_eq!(repeated["headSha"],"new-head");
     assert_eq!(host.persisted,1);
     assert_eq!(host.launched,0);assert_eq!(host.emitted,0);
     std::fs::remove_dir_all(root).unwrap();
 }
}
#[test]
fn concurrent_sqlite_mutation_rejects_stale_candidate_before_any_effect(){
 let (root,mut host)=fixture("DRAFT",false);host.inject_race=true;
 let mut reconciler=rec(&root);
 let error=reconciler.reconcile("1",Some("new-head"),&root,&json!({}),
     &[],&[],None,&mut host).unwrap_err();
 assert!(error.contains("CAS conflict"),"{error}");
 assert_eq!(host.load("1").unwrap()["headSha"],"concurrent-writer");
 assert_eq!(host.launched,0);assert_eq!(host.emitted,0);
 std::fs::remove_dir_all(root).unwrap();
}
fn expired_fixture()->(PathBuf,Host){
    let (root,host)=fixture("ACTIVE",false);
    host.store.mutate_job("1",|mut job|{
        let expired="2026-11-01T00:00:00.000Z";
        job["tasks"]=json!([{
            "id":"task-a","jobId":"1","kind":"work","agentName":"worker",
            "adapter":"script",
            "routing":{"decisionId":"decision-expired-1","provider":"fixture",
                "model":"owned-script","profile":"isolated"},
            "title":"Expired without a running process",
            "input":"never execute","state":"RUNNING",
            "createdAt":expired,"updatedAt":expired,
            "attempt":1,"maxAttempts":2,"dependencies":[],
            "executionId":"execution-old","leaseOwner":"fixture",
            "leaseExpiresAt":expired,"timeoutMs":10000,
            "executionHistory":[{"id":"execution-old","attempt":1,
                "startedAt":expired}]
        }]);Ok(job)
    }).unwrap();
    (root,host)
}
#[test]
fn expired_generation_recovered_through_graph_and_exact_sqlite_cas(){
    let (root,mut host)=expired_fixture();
    let mut reconciler=rec(&root);
    // The recovered Task is real and queued, but this legacy fixture has no
    // routing metadata or installed provider. Graph launch is now visible;
    // the production-equivalent claim must fail CLOSED, not fabricate a worker.
    let result=reconciler.reconcile("1",None,&root,&json!({}),
        &[],&[],None,&mut host).unwrap();
    assert!(result["tasks"].as_array().unwrap().iter().any(|task|
        task["state"]=="FAILED"&&task["error"].as_str()
            .is_some_and(|error|error.contains("requires routing metadata"))));
    let persisted=host.load("1").unwrap();
    assert_eq!(persisted["tasks"][0]["state"],"FAILED");
    assert_eq!(persisted["tasks"][0]["failureReason"],"worker_outcome_unknown");
    assert!(persisted["tasks"][0]["executionId"].is_null());
    assert!(persisted["tasks"].as_array().unwrap().iter().any(|task|
        task["agentName"]=="troubleshooter"
        &&task["parentTaskId"]=="task-a"
        &&task["state"]=="FAILED"
        &&task["executionId"].is_null()
        &&task["error"].as_str().is_some_and(|s|
            s.contains("requires routing metadata"))));
    assert!(host.emitted>=2);
    assert_eq!(host.launched,0,"No Worker may start without a proven routing receipt");
    let audit=std::fs::read_to_string(root.join("decision-audit.jsonl")).unwrap();
    let rows=audit.lines().map(|line|
        serde_json::from_str::<Value>(line).unwrap()).collect::<Vec<_>>();
    assert_eq!(rows.len(),1,"Only verified lease recovery may append watchdog evidence");
    assert_eq!(rows[0]["decision_id"],"decision-expired-1");
    assert_eq!(rows[0]["kind"],"timeout");
    assert_eq!(rows[0]["evidence"]["execution_id"],"execution-old");
    assert_eq!(rows[0]["evidence"]["watchdog"],true);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn unverified_recorded_process_identity_fails_closed_without_mutation(){
    let (root,mut host)=expired_fixture();
    host.store.record_execution_process(&json!({
        "jobId":"1","taskId":"task-a","executionId":"execution-old",
        "leaseOwner":"fixture","host":"unknown-foreign-host",
        "pid":9999999,"pgid":9999999,"startToken":"not-matching",
        "observedAt":"2026-11-01T00:00:00Z"
    })).unwrap();
    let mut reconciler=rec(&root);
    let result=reconciler.reconcile("1",None,&root,&json!({}),
        &[],&[],None,&mut host).unwrap();
    assert_eq!(result["tasks"][0]["state"],"RUNNING");
    assert_eq!(result["tasks"][0]["executionId"],"execution-old");
    assert_eq!(host.emitted,0);
    assert_eq!(host.launched,0);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn expired_generation_cas_race_refuses_transition_and_external_effects(){
    let (root,mut host)=expired_fixture();
    host.inject_race=true;
    let mut reconciler=rec(&root);
    let error=reconciler.reconcile("1",None,&root,&json!({}),
        &[],&[],None,&mut host).unwrap_err();
    assert!(error.contains("CAS conflict"),"{error}");
    assert_eq!(host.load("1").unwrap()["tasks"][0]["state"],"RUNNING");
    assert_eq!(host.emitted,0);
    assert_eq!(host.launched,0);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn actual_git_head_change_refreshes_sqlite_without_reusing_cached_sha(){
    use agents_relay_rust2::reconciler_git_head::verified_local_head;
    let (root,mut host)=fixture("COMPLETED",false);
    let git=|args:&[&str]|->String{
        let output=std::process::Command::new("git").arg("-C").arg(&root)
            .args(args).output().unwrap();
        assert!(output.status.success(),"{}: {}",args.join(" "),
            String::from_utf8_lossy(&output.stderr));
        String::from_utf8(output.stdout).unwrap().trim().to_string()
    };
    git(&["init","--quiet"]);
    let commit=|message:&str|{
        git(&["-c","user.name=Fixture","-c","user.email=fixture@example.invalid",
            "commit","--allow-empty","--quiet","-m",message]);
        git(&["rev-parse","HEAD"])
    };
    let first=commit("first");
    let mut rec=rec(&root);
    let job=host.load("1").unwrap();
    let observed=verified_local_head(&job,&root,true);
    assert_eq!(observed.as_deref(),Some(first.as_str()));
    let first_result=rec.reconcile("1",observed.as_deref(),&root,&json!({}),
        &[],&[],None,&mut host).unwrap();
    assert_eq!(first_result["headSha"],first);
    assert_eq!(host.load("1").unwrap()["headSha"],first);
    let second=commit("second");
    assert_ne!(first,second);
    let observed=verified_local_head(&host.load("1").unwrap(),&root,true);
    assert_eq!(observed.as_deref(),Some(second.as_str()));
    let second_result=rec.reconcile("1",observed.as_deref(),&root,&json!({}),
        &[],&[],None,&mut host).unwrap();
    assert_eq!(second_result["headSha"],second);
    assert_eq!(host.load("1").unwrap()["headSha"],second);
    assert_eq!(host.persisted,2);
    assert_eq!(host.launched,0);
    std::fs::remove_dir_all(root).unwrap();
}


// Failed external Graph effects must be observed and settled by the same
// original Node workflow-effect-failures reducer; never silently return a
// successful Worker receipt or mutate a different Job generation.
#[test]
fn canonical_launch_effect_failure_is_graph_sqlite_durable_with_exact_event(){
    let (root,mut host)=fixture("ACTIVE",false);
    host.forced_failure=Some("fixture worker runtime disconnected".into());
    host.store.mutate_job("1",|mut job|{
        job["tasks"]=json!([{
            "id":"2","jobId":"1","kind":"work",
            "agentName":"developer","adapter":"script",
            "routing":{"decisionId":"decision-2","provider":"fixture",
                "model":"isolated-runtime","profile":"test"},
            "title":"Expected launch failure","state":"QUEUED",
            "attempt":0,"maxAttempts":1,"dependencies":[],
            "input":"isolated","output":{"kind":"file","path":root.join("out.json")},
            "createdAt":"2026-11-18T00:00:00.000Z",
            "updatedAt":"2026-11-18T00:00:00.000Z"
        }]);Ok(job)
    }).unwrap();
    let mut reconciler=rec(&root);
    let custom_audit=root.join("configured-route-audit.jsonl");
    reconciler.options["decisionAuditPath"]=json!(custom_audit);
    let outcome=reconciler.reconcile("1",None,&root,&json!({}),
        &[],&[],None,&mut host).unwrap();
    let stored=host.load("1").unwrap();
    assert_eq!(outcome,stored);
    assert_eq!(stored["tasks"][0]["state"],"FAILED");
    assert_eq!(stored["tasks"][0]["error"],
        "fixture worker runtime disconnected");
    assert_eq!(host.launched,0,"A failed process launch cannot count as Worker");
    let audit_path=root.join("configured-route-audit.jsonl");
    let audit=std::fs::read_to_string(&audit_path).unwrap();
    let rows=audit.lines().map(|line|
        serde_json::from_str::<Value>(line).unwrap()).collect::<Vec<_>>();
    assert_eq!(rows.len(),1,"Only committed Worker launch failure creates route audit");
    assert_eq!(rows[0]["decision_id"],"decision-2");
    assert_eq!(rows[0]["kind"],"launch_failure");
    assert_eq!(rows[0]["evidence"]["phase"],"launch");
    assert_eq!(rows[0]["evidence"]["task_id"],"2");
    let events=host.events.iter().filter(|event|event["type"]=="workflow.effect.failed")
        .collect::<Vec<_>>();
    assert_eq!(events.len(),1,"Failure must be observable exactly once");
    assert_eq!(events[0]["job_id"],"1");
    assert_eq!(events[0]["task_id"],"2");
    assert_eq!(events[0]["data"]["effect"],"effect.launchTask");
    assert_eq!(events[0]["data"]["workflowEvent"],"effect.launchTask.failed");
    assert_eq!(events[0]["status"],"failed");
    let repeated=reconciler.reconcile("1",None,&root,&json!({}),
        &[],&[],None,&mut host).unwrap();
    assert_eq!(repeated["tasks"][0]["state"],"FAILED");
    assert_eq!(host.events.iter().filter(|event|
        event["type"]=="workflow.effect.failed"
        &&event["task_id"]=="2").count(),1,
        "Reconciliation may not duplicate the same Task's terminal launch error");
    assert!(host.events.iter().filter(|event|
        event["type"]=="workflow.effect.failed"
        &&event["task_id"]!="2").count()<=1,
        "A separate Troubleshooter's failure is a distinct Task generation");
    assert_eq!(std::fs::read_to_string(&audit_path).unwrap(),audit,
        "Repeated reconciliation may not re-audit a settled original Task");
    std::fs::remove_dir_all(root).unwrap();
}
