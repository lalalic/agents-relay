// Node finishPlanner native path: atomic SQLite BEGIN IMMEDIATE, durable
// candidate fingerprint and generation CAS; no remote worker/model.
use agents_relay_rust2::{
    planner_runtime::{finish_planner,PlannerFinishPorts},
    relay_store::SQLiteRelayStore,
};
use serde_json::{json,Value};
use std::{path::{Path,PathBuf},sync::{Arc,atomic::{AtomicUsize,Ordering}},
    time::{SystemTime,UNIX_EPOCH}};
struct Local{
    store:SQLiteRelayStore,root:PathBuf,
    emitted:Vec<Value>,reconciled:usize,released:usize,
    live:Option<String>,race:bool,atomic:bool,
    mutations:Arc<AtomicUsize>,
}
impl PlannerFinishPorts for Local{
    fn load(&mut self,id:&str)->Result<Value,String>{
        self.store.load_job(id)?.ok_or(format!("Job {id} missing"))
    }
    fn atomic_available(&self)->bool{self.atomic}
    fn mutate(&mut self,id:&str,mutation:&mut dyn FnMut(Value)->Result<Value,String>)
        ->Result<Value,String>{
        self.mutations.fetch_add(1,Ordering::SeqCst);
        // Simulate independent concurrent SQLite writer, after observed
        // load but before this mutation enters BEGIN IMMEDIATE.
        if self.race{
            self.store.mutate_job(id,|mut job|{
                job["headSha"]=json!("concurrent-head");Ok(job)
            })?;
            self.race=false;
        }
        self.store.mutate_job(id,mutation)
    }
    fn save_plan(&mut self,_plan:&Value)->Result<(),String>{
        Err("Atomic test must not use legacy savePlan".into())
    }
    fn execution_context(&mut self,_job:&Value,_plan:&Value)->Result<Value,String>{
        Ok(json!({}))
    }
    fn emit(&mut self,event:&Value)->Result<(),String>{
        self.emitted.push(event.clone());Ok(())
    }
    fn reconcile(&mut self,_id:&str,_round:&str,_context:&str)->Result<(),String>{
        self.reconciled+=1;Ok(())
    }
    fn release_live(&mut self,_plan:&str,execution:Option<&str>){
        if self.live.is_some()&&self.live.as_deref()==execution{
            self.live=None;self.released+=1;
        }
    }
    fn has_live(&self,_plan:&str,execution:Option<&str>)->bool{
        self.live.is_some()&&self.live.as_deref()==execution
    }
    fn store_directory(&self)->&Path{&self.root}
}
fn fixture() ->(PathBuf,Local){
    let suffix=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root=std::env::temp_dir().join(format!("rust2-finish-plan-{}-{suffix}",std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let store=SQLiteRelayStore::open(&root.join("job.sqlite"),Some("41")).unwrap();
    let stamp="2026-11-18T08:00:00.000Z";
    store.save_job(&json!({
        "id":"41","title":"Plan test","repository":"fixture","prNumber":0,
        "state":"ACTIVE","objective":"Complete work","reviewEnabled":false,
        "headSha":"stable-head","createdAt":stamp,"updatedAt":stamp,
        "tasks":[{"id":"worker-task","jobId":"41","kind":"work",
            "state":"SUCCEEDED","agentName":"worker","adapter":"codex",
            "title":"Verified previous work","executionId":null,
            "leaseOwner":null,"leaseExpiresAt":null,
            "dependencies":[],"attempt":1,"maxAttempts":3,
            "createdAt":stamp,"updatedAt":stamp}],
        "plans":[{"id":"plan-1","jobId":"41","status":"PLANNING",
            "round":1,"source":"model-planner","executionId":"exec-1",
            "leaseOwner":"relay","leaseExpiresAt":"2026-11-19T10:00:00Z",
            "attempt":1,"maxAttempts":3,"manualPlanning":false,
            "createdAt":stamp,"updatedAt":stamp,"trigger":{"source":"manual"},
            "forceRestate":false,"generatedTaskIds":[]
        }]
    })).unwrap();
    let fixture=Local{store,root:root.clone(),emitted:vec![],reconciled:0,
        released:0,live:Some("exec-1".into()),race:false,atomic:true,
        mutations:Arc::new(AtomicUsize::new(0))};
    (root,fixture)
}
#[test]
fn durable_satisfied_candidate_commits_once_and_repeated_generation_is_idempotent(){
    let (root,mut host)=fixture();
    let graph=Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow");
    let raw=json!({"objective_status":"satisfied",
        "assessment":"Implementation complete","next_tasks":[],"unblocks":[]});
    finish_planner(&mut host,&graph,"41","plan-1",Some("exec-1"),
        None,Some(&raw),false).unwrap();
    let accepted=host.load("41").unwrap();
    assert_eq!(accepted["plans"][0]["status"],"SUCCEEDED");
    assert_eq!(accepted["plans"][0]["appliedExecutionId"],"exec-1");
    assert_eq!(accepted["plans"][0]["generatedTaskIds"],json!([]));
    assert!(accepted["plans"][0]["appliedCandidateFingerprint"]
        .as_str().is_some_and(|hash|hash.len()==64));
    assert_eq!(host.emitted.len(),1);
    assert_eq!(host.emitted[0]["type"],"planner.completed");
    assert_eq!(host.reconciled,1);
    assert_eq!(host.released,1);
    let writes=host.mutations.load(Ordering::SeqCst);
    finish_planner(&mut host,&graph,"41","plan-1",Some("exec-1"),
        None,Some(&raw),true).unwrap();
    assert_eq!(host.mutations.load(Ordering::SeqCst),writes);
    assert_eq!(host.load("41").unwrap(),accepted);
    let different=json!({"objective_status":"satisfied",
        "assessment":"Different candidate","next_tasks":[],"unblocks":[]});
    let err=finish_planner(&mut host,&graph,"41","plan-1",Some("exec-1"),
        None,Some(&different),true).unwrap_err();
    assert!(err.contains("already committed a different candidate"));
    assert_eq!(host.load("41").unwrap(),accepted);
    drop(host);std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn sqlite_cas_fencing_and_failed_validation_roll_back_all_task_and_plan_writes(){
    let (root,mut host)=fixture();
    let graph=Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow");
    let raw=json!({"objective_status":"satisfied","assessment":"Complete",
        "next_tasks":[],"unblocks":[]});
    host.race=true;
    let err=finish_planner(&mut host,&graph,"41","plan-1",Some("exec-1"),
        None,Some(&raw),true).unwrap_err();
    assert!(err.contains("PLAN_APPLY_VALIDATION_FAILED"));
    assert!(err.contains("fencing"));
    let after=host.load("41").unwrap();
    assert_eq!(after["headSha"],"concurrent-head");
    assert_eq!(after["plans"][0]["status"],"PLANNING");
    assert!(after["plans"][0].get("plannerResult").is_none());
    assert_eq!(host.emitted.len(),0);
    // The same generation may retry against the new durable snapshot.
    host.live=Some("exec-1".into());
    let invalid=json!({"objective_status":"satisfied","assessment":"Task invalid",
        "next_tasks":[{"id":"child","input":"do work","title":"bad"}],"unblocks":[]});
    let err=finish_planner(&mut host,&graph,"41","plan-1",Some("exec-1"),
        None,Some(&invalid),true).unwrap_err();
    assert!(err.contains("PLAN_APPLY_VALIDATION_FAILED"));
    assert_eq!(host.load("41").unwrap(),after);
    assert_eq!(host.emitted.len(),0);
    drop(host);std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn reconciler_apply_planner_tree_uses_same_durable_sqlite_cas_and_rejects_stale_generation(){
    use agents_relay_rust2::reconciler::Reconciler;
    let (root,mut host)=fixture();
    let graph=Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow");
    let mut rec=Reconciler::new(&graph,&root,&root,&root,&root,
        json!({"owner":"relay"}));
    let proposal=json!({"objective_status":"satisfied",
        "assessment":"Implementation complete","next_tasks":[],"unblocks":[]});
    let before=host.load("41").unwrap();
    let rejected=rec.apply_planner_tree(&mut host,"41","plan-1","other-generation",
        &proposal).unwrap_err();
    assert!(rejected.contains("not owned by this active execution"));
    assert_eq!(host.load("41").unwrap(),before);
    assert_eq!(host.mutations.load(Ordering::SeqCst),0);
    host.race=true;
    let fenced=rec.apply_planner_tree(&mut host,"41","plan-1","exec-1",
        &proposal).unwrap_err();
    assert!(fenced.contains("fencing"),"{fenced}");
    assert_eq!(host.load("41").unwrap()["plans"][0]["status"],"PLANNING");
    assert!(host.emitted.is_empty());
    let applied=rec.apply_planner_tree(&mut host,"41","plan-1","exec-1",
        &proposal).unwrap();
    assert_eq!(applied["status"],"SUCCEEDED");
    assert_eq!(applied["appliedExecutionId"],"exec-1");
    assert_eq!(host.load("41").unwrap()["plans"][0],applied);
    let writes=host.mutations.load(Ordering::SeqCst);
    let repeated=rec.apply_planner_tree(&mut host,"41","plan-1","exec-1",
        &proposal).unwrap();
    assert_eq!(repeated,applied);
    assert_eq!(host.mutations.load(Ordering::SeqCst),writes);
    drop(host);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn planner_rejects_executable_dag_before_task_creation_and_allows_direct_task() {
    use agents_relay_rust2::{planner::parse_planner_result,reconciler::Reconciler};
    let (root,mut host)=fixture();
    let graph=Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow");
    let mut rec=Reconciler::new(&graph,&root,&root,&root,&root,json!({"owner":"relay"}));
    let mut proposal=json!({"objective_status":"in_progress",
        "assessment":"```mermaid\nflowchart LR\n  A --> B\n```\nDirect source work",
        "next_tasks":[{"id":"fix","title":"Repair Dashboard usage and telemetry reporting",
            "input":"Fix and verify the source", "agentName":"implementation",
            "output":{"kind":"task_pr"},"storySize":"M"}]});
    assert!(parse_planner_result(&proposal).is_ok());
    let before=host.load("41").unwrap();
    for invalid in [json!("flowchart LR\n  implementation[agent:implementation]"),
        json!("flowchart LR\n  implementation --> reviewer"),json!({"nodes":[]}),json!("")] {
        proposal["next_tasks"][0]["agentGraph"]=invalid;
        let rejected=rec.apply_planner_tree(&mut host,"41","plan-1","exec-1",&proposal).unwrap_err();
        assert!(rejected.contains("PLAN_APPLY_VALIDATION_FAILED"),"{rejected}");
        assert!(rejected.contains("agentGraph is not allowed"),"{rejected}");
        assert_eq!(host.load("41").unwrap(),before);
        assert_eq!(host.mutations.load(Ordering::SeqCst),0);
        assert!(host.emitted.is_empty());
    }
    proposal["next_tasks"][0].as_object_mut().unwrap().remove("agentGraph");
    let parsed=parse_planner_result(&proposal).unwrap();
    assert_eq!(parsed["next_tasks"][0]["agentName"],"implementation");
    assert_eq!(parsed["next_tasks"][0]["output"]["kind"],"task_pr");
    assert!(parsed["next_tasks"][0].get("agentGraph").is_none());
    drop(host);std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn manual_plan_quota_recovery_preserves_round_and_logical_attempt_budget(){
    let (root,mut host)=fixture();
    let graph=Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow");
    host.store.mutate_job("41",|mut job|{
        let plan=&mut job["plans"][0];
        plan["manualPlanning"]=json!(true);
        plan["maxAttempts"]=json!(1);
        plan["routing"]=json!({"provider":"zai","model":"glm","profile":"zai"});
        Ok(job)
    }).unwrap();
    let quota="codex_quota_no_side_effects: rate_limit_exceeded";
    finish_planner(&mut host,&graph,"41","plan-1",Some("exec-1"),Some(quota),None,false).unwrap();
    let after=host.load("41").unwrap();
    let plan=&after["plans"][0];
    assert_eq!(plan["status"],"PLANNING");
    assert_eq!(plan["attempt"],1);
    assert_eq!(plan["maxAttempts"],1);
    assert_eq!(plan["providerRecoveryCount"],1);
    assert_eq!(plan["providerRecoveryPending"],true);
    assert_eq!(plan["routingExclusions"][0]["profile"],"zai");
    assert!(plan["executionId"].is_null());
    assert_eq!(host.emitted[0]["type"],"planner.retry");
    host.store.mutate_job("41",|mut job|{
        let p=&mut job["plans"][0];
        agents_relay_rust2::native_codex_thread::claim_logical_attempt(p);
        p["executionId"]=json!("exec-2");
        p["providerRecoveryCount"]=json!(2);
        Ok(job)
    }).unwrap();
    finish_planner(&mut host,&graph,"41","plan-1",Some("exec-2"),Some(quota),None,false).unwrap();
    let after=host.load("41").unwrap();
    assert_eq!(after["plans"][0]["status"],"FAILED");
    assert_eq!(after["plans"][0]["attempt"],1);
    drop(host);std::fs::remove_dir_all(root).unwrap();
}
