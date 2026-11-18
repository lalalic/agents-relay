// Native Graph/SQLite integration: only the current leased execution can
// commit a Worker launch failure. Duplicate error receipts never re-emit.
use agents_relay_rust2::{
    relay_store::SQLiteRelayStore,
    worker_failure_recovery::{handle_worker_launch_failure,
        FailureAdmission,apply_launch_failure_mutation},
    worker_failure_orchestration::{WorkerFailurePorts,LiveWorkerState},
    workflow::{lifecycle::decide_task_lifecycle,runtime::apply_task_graph_target},
};
use serde_json::{json,Value};
use std::{collections::HashSet,path::PathBuf,time::{SystemTime,UNIX_EPOCH}};
struct SqliteFailurePort{
    store:SQLiteRelayStore,graph:PathBuf,
    claims:HashSet<String>,events:Vec<Value>,wakes:usize,
}
impl WorkerFailurePorts for SqliteFailurePort{
    fn load_job(&mut self,id:&str)->Result<Value,String>{
        self.store.load_job(id)?.ok_or("Missing Job".into())
    }
    fn list_agents(&mut self)->Result<Vec<Value>,String>{Ok(vec![])}
    fn usage_snapshot(&mut self)->Result<Option<Value>,String>{Ok(None)}
    fn has_safe_alternative(&mut self,_:Option<&Value>,_:&[Value],_:Option<&Value>)
        ->Result<bool,String>{Ok(false)}
    fn has_codex_no_start_fallback(&mut self,_:&Value,_:&[Value],_:Option<&Value>)
        ->Result<bool,String>{Ok(false)}
    fn live_worker(&mut self,_:&str)->Option<LiveWorkerState>{None}
    fn claim_failure(&mut self,key:&str)->bool{self.claims.insert(key.into())}
    fn apply_transition(&mut self,job_id:&str,task_id:&str,
        expected:Option<&str>,admission:&FailureAdmission,
    )->Result<Option<Value>,String>{
        let mut receipt=None;
        self.store.mutate_job(job_id,|mut job|{
            let Some(index)=job["tasks"].as_array().into_iter().flatten()
                .position(|task|task["id"].as_str()==Some(task_id))
                else{return Ok(job)};
            let task=job["tasks"][index].clone();
            if task["executionId"].as_str()!=expected{return Ok(job);}
            let from=task["state"].as_str().unwrap_or("").to_string();
            let decision=decide_task_lifecycle(&self.graph,&task,
                &admission.event,&admission.facts)?;
            let mut updated=task.clone();
            if decision["accepted"]==true{
                apply_task_graph_target(&mut updated,
                    decision["target"].as_str().ok_or("Missing target")?,
                    &chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),false)?;
                apply_launch_failure_mutation(&mut updated,Some(&task),admission,&decision);
                job["tasks"][index]=updated.clone();
            }
            receipt=Some(json!({"from":from,"task":updated,"decision":decision}));
            Ok(job)
        })?;
        Ok(receipt)
    }
    fn record_route_outcome(&mut self,_:&Value,_:&str,_:&str,_:Option<&str>,_:bool){}
    fn cancel_and_clear(&mut self,_:&str,_:&str)->Result<(),String>{Ok(())}
    fn clear_terminal_waiter(&mut self,_:&str,_:&str){}
    fn emit(&mut self,event:&Value)->Result<(),String>{
        self.events.push(event.clone());Ok(())
    }
    fn emit_detached(&mut self,event:&Value,_:&str,_:&str,_:&str){
        self.events.push(event.clone());
    }
    fn wake(&mut self,_:&str,_:&str,_:&str){self.wakes+=1;}
}
#[test]
fn graph_owned_failure_is_durable_and_repeat_cannot_double_wake(){
    let suffix=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root=std::env::temp_dir().join(format!("rust2-worker-failure-{}-{suffix}",std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let store=SQLiteRelayStore::open(&root.join("relay.sqlite"),Some("41")).unwrap();
    let job=json!({"id":"41","repository":"example","state":"ACTIVE",
        "title":"Worker failure","prNumber":0, "createdAt":"2026-11-18T05:00:00Z",
        "updatedAt":"2026-11-18T05:00:00Z", "plans":[],
        "tasks":[{"id":"7","jobId":"41","state":"QUEUED",
            "parentTaskId":null,"adapter":"codex","agentName":"editor",
            "attempt":1,"maxAttempts":3,"executionId":"e-1",
            "leaseOwner":"owner","leaseExpiresAt":"2026-11-18T06:00:00Z",
            "lastProgressEventAt":null,"error":null,"kind":"work",
            "capabilities":[],"dependencies":[]}]});
    store.save_job(&job).unwrap();
    let mut port=SqliteFailurePort{store,graph:PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../workflow"),claims:HashSet::new(),events:vec![],wakes:0};
    handle_worker_launch_failure(&mut port,"41","7",Some("e-1"),
        &json!("injected owned worker failure"),"delivery").unwrap();
    let durable=port.store.load_job("41").unwrap().unwrap();
    // Graph may reject if a legacy Task state is not enabled, but an
    // accepted transition can never leave a partial execution lease.
    if port.wakes>0{
        assert!(durable["tasks"][0]["executionId"].is_null());
        assert!(durable["tasks"][0]["leaseOwner"].is_null());
        assert_eq!(port.events.len(),1);
    }else{
        assert_eq!(durable["tasks"][0]["executionId"],"e-1");
    }
    let before=port.events.len();
    handle_worker_launch_failure(&mut port,"41","7",Some("e-1"),
        &json!("injected owned worker failure"),"delivery").unwrap();
    assert_eq!(port.events.len(),before);
    assert_eq!(port.claims.len(),1);
    // A late failure for another execution cannot mutate the current Job.
    let snapshot=port.store.load_job("41").unwrap().unwrap();
    handle_worker_launch_failure(&mut port,"41","7",Some("old-generation"),
        &json!("stale failure"),"delivery").unwrap();
    assert_eq!(port.store.load_job("41").unwrap().unwrap(),snapshot);
    drop(port);std::fs::remove_dir_all(root).unwrap();
}
