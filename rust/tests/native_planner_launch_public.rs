// Real SQLite Plan claiming, worker ownership, deterministic finish and
// duplicate start prevention. All work is fixture owned; no provider exec.
use agents_relay_rust2::{
    planner_runtime::{PlannerFinishPorts,PlannerLaunchPorts,launch_plan_execution},
    relay_store::SQLiteRelayStore,
};
use serde_json::{json,Value};
use std::{path::{Path,PathBuf},sync::{Arc,Mutex,atomic::{AtomicUsize,Ordering}},
    time::{SystemTime,UNIX_EPOCH,Duration,Instant}};
struct Host{
    root:PathBuf,file:PathBuf,live:Option<String>,has_planner:bool,
    started:Arc<AtomicUsize>,in_flight:Arc<AtomicUsize>,
    emitted:Vec<String>,reconciles:usize,owned_errors:Vec<String>,
}
impl Host{
    fn store(&self)->SQLiteRelayStore{
        SQLiteRelayStore::open(&self.file,Some("41")).unwrap()
    }
}
impl PlannerFinishPorts for Host{
    fn load(&mut self,id:&str)->Result<Value,String>{
        self.store().load_job(id)?.ok_or("Job missing".into())
    }
    fn mutate(&mut self,id:&str,fn_mut:&mut dyn FnMut(Value)->Result<Value,String>)
        ->Result<Value,String>{self.store().mutate_job(id,fn_mut)}
    fn execution_context(&mut self,_job:&Value,_plan:&Value)->Result<Value,String>{
        Ok(json!({}))
    }
    fn registered_workers(&mut self)->Result<Vec<Value>,String>{Ok(vec![])}
    fn emit(&mut self,event:&Value)->Result<(),String>{
        self.emitted.push(event["type"].as_str().unwrap_or("").into());Ok(())
    }
    fn reconcile(&mut self,_id:&str,_plan:&str,_why:&str)->Result<(),String>{
        self.reconciles+=1;Ok(())
    }
    fn release_live(&mut self,_id:&str,execution:Option<&str>){
        if self.live.is_some()&&self.live.as_deref()==execution{self.live=None;}
    }
    fn has_live(&self,_id:&str,execution:Option<&str>)->bool{
        self.live.is_some()&&self.live.as_deref()==execution
    }
    fn store_directory(&self)->&Path{&self.root}
}
impl PlannerLaunchPorts for Host{
    fn has_planner(&self)->bool{self.has_planner}
    fn owner(&self)->&str{"native-relay"}
    fn now(&self)->String{"2026-11-18T09:00:00.000Z".into()}
    fn timeout_ms(&self)->u64{3_000}
    fn head_sha(&mut self)->Result<Option<String>,String>{Ok(Some("head-1".into()))}
    fn save_claimed_plan(&mut self,id:&str,plan:&Value)->Result<(),String>{
        self.store().mutate_job(id,|mut job|{
            if let Some(current)=job["plans"].as_array_mut()
                .and_then(|plans|plans.iter_mut().find(|p|p["id"]==plan["id"])){
                *current=plan.clone();
            }Ok(job)
        })?;
        Ok(())
    }
    fn register_live(&mut self,_pid:&str,execution:&str,_timeout:u64)->Result<(),String>{
        self.live=Some(execution.into());Ok(())
    }
    fn begin_planner(&mut self,_context:Value,_timeout:u64)
        ->Result<Box<dyn FnOnce()->Result<Value,String>+Send>,String>{
        self.started.fetch_add(1,Ordering::SeqCst);
        let inflight=Arc::clone(&self.in_flight);
        Ok(Box::new(move||{
            inflight.fetch_add(1,Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(150));
            inflight.fetch_sub(1,Ordering::SeqCst);
            Ok(json!({"objective_status":"satisfied",
                "assessment":"Native Planner completed", "next_tasks":[],"unblocks":[]}))
        }))
    }
    fn detached_failure(&mut self,_id:&str,_pid:&str,error:&str){
        self.owned_errors.push(error.into());
    }
}
fn fixture(has_planner:bool)->(PathBuf,Arc<Mutex<Host>>,Value,Value){
    let suffix=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let dir=std::env::temp_dir().join(format!("rust2-plan-launch-{}-{suffix}",std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file=dir.join("jobs.sqlite");
    let host=Host{root:dir.clone(),file:file.clone(),live:None,has_planner,
        started:Arc::new(AtomicUsize::new(0)),in_flight:Arc::new(AtomicUsize::new(0)),
        emitted:vec![],reconciles:0,owned_errors:vec![]};
    let job=json!({"id":"41","state":"ACTIVE","repository":"fixture",
        "title":"Plan test","objective":"Complete task","prNumber":0,
        "reviewEnabled":false,"headSha":"head-1",
        "createdAt":"2026-11-18T07:00:00.000Z",
        "updatedAt":"2026-11-18T07:00:00.000Z",
        "plans":[{"id":"plan-1","jobId":"41","status":"PLANNING",
            "round":1,"source":"model-planner","executionId":null,
            "leaseOwner":null,"leaseExpiresAt":null,"attempt":0,
            "maxAttempts":3,"manualPlanning":false,"headSha":"head-1",
            "createdAt":"2026-11-18T07:00:00.000Z",
            "updatedAt":"2026-11-18T07:00:00.000Z",
            "trigger":{"source":"manual"},"forceRestate":false}],
        "tasks":[{"id":"work1","jobId":"41","kind":"work",
            "title":"Work","state":"SUCCEEDED","agentName":"worker",
            "adapter":"codex","attempt":1,"maxAttempts":3,
            "executionId":null,"leaseOwner":null,"leaseExpiresAt":null,
            "createdAt":"2026-11-18T07:00:00.000Z",
            "updatedAt":"2026-11-18T07:00:00.000Z",
            "dependencies":[]}]
    });
    let p=job["plans"][0].clone();
    host.store().save_job(&job).unwrap();
    (dir,Arc::new(Mutex::new(host)),job,p)
}
#[test]
fn detached_planner_claim_is_exclusive_and_settles_exact_owned_sqlite_generation(){
    let (dir,host,job,p)=fixture(true);
    let graph=Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow");
    launch_plan_execution(Arc::clone(&host),&graph,&job,&p,false).unwrap();
    let claimed=host.lock().unwrap().store().load_job("41").unwrap().unwrap();
    assert_eq!(claimed["plans"][0]["status"],"PLANNING");
    assert_eq!(claimed["plans"][0]["attempt"],1);
    assert_eq!(claimed["plans"][0]["leaseOwner"],"native-relay");
    let execution=claimed["plans"][0]["executionId"].as_str().unwrap().to_owned();
    assert!(!execution.is_empty());
    assert_eq!(host.lock().unwrap().started.load(Ordering::SeqCst),1);
    // Same Job cannot claim a second Planner execution while generation 1
    // is still live; retains the same durable ID and no new provider spawn.
    launch_plan_execution(Arc::clone(&host),&graph,&job,&p,false).unwrap();
    assert_eq!(host.lock().unwrap().started.load(Ordering::SeqCst),1);
    let deadline=Instant::now()+Duration::from_secs(6);
    loop{
        let complete={
            let state=host.lock().unwrap();
            state.store().load_job("41").unwrap().unwrap()["plans"][0]["status"]=="SUCCEEDED"
        };
        if complete{break;}
        assert!(Instant::now()<deadline,"Owned Planner settlement timed out");
        std::thread::sleep(Duration::from_millis(10));
    }
    let state=host.lock().unwrap();
    let durable=state.store().load_job("41").unwrap().unwrap();
    assert_eq!(durable["plans"][0]["appliedExecutionId"],execution);
    assert_eq!(durable["plans"][0]["executionId"],Value::Null);
    assert_eq!(durable["plans"][0]["status"],"SUCCEEDED");
    assert_eq!(state.started.load(Ordering::SeqCst),1);
    assert_eq!(state.in_flight.load(Ordering::SeqCst),0);
    assert_eq!(state.emitted,vec!["planner.started","planner.completed"]);
    assert_eq!(state.reconciles,1);
    assert!(state.owned_errors.is_empty());
    assert!(state.live.is_none());
    drop(state);drop(host);std::fs::remove_dir_all(dir).unwrap();
}
#[test]
fn missing_planner_fails_durable_round_without_starting_owned_process(){
    let (dir,host,job,p)=fixture(false);
    let graph=Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow");
    launch_plan_execution(Arc::clone(&host),&graph,&job,&p,true).unwrap();
    let state=host.lock().unwrap();
    let durable=state.store().load_job("41").unwrap().unwrap();
    assert_eq!(durable["plans"][0]["status"],"FAILED");
    assert_eq!(durable["plans"][0]["error"],"Planner unavailable");
    assert_eq!(durable["plans"][0]["executionId"],Value::Null);
    assert_eq!(state.started.load(Ordering::SeqCst),0);
    assert_eq!(state.emitted,vec!["planner.failed"]);
    drop(state);drop(host);std::fs::remove_dir_all(dir).unwrap();
}
