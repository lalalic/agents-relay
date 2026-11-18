// Real loopback Dashboard and SQLite Service lifecycle. No NATS, provider,
// production repository, global kill, live Relay Job or outbound network.
use agents_relay_rust2::{
    cli::{runtime,RuntimePaths,create_service,start_service},
    owned_process::OwnedProcessManager,
    relay_store::SQLiteRelayStore,
    relayd::{DaemonConfig,DaemonServices},
};
use serde_json::{json,Value};
use std::{
    fs,io::{Read,Write},net::TcpStream,path::{Path,PathBuf},
    sync::{Arc,atomic::{AtomicUsize,Ordering},mpsc::{self,Receiver}},
    time::{Duration,SystemTime,UNIX_EPOCH},
};
struct Local{
    store:SQLiteRelayStore,
    effects:Arc<AtomicUsize>,
    loads:Arc<AtomicUsize>,
    fault_initial:bool,
}
impl DaemonServices for Local{
    fn control(&mut self,_body:&Value)->Result<Value,String>{Err("Not in fixture".into())}
    fn load(&mut self,id:&str)->Result<Value,String>{
        let number=self.loads.fetch_add(1,Ordering::SeqCst)+1;
        if self.fault_initial&&number>1{return Err("injected SQLite read error".into());}
        self.store.load_job(id)?.ok_or_else(||format!("Job {id} missing"))
    }
    fn load_execution_process(&mut self,job_id:&str,task_id:&str,
        execution_id:&str)->Result<Option<Value>,String>{
        self.store.load_execution_process(job_id,task_id,execution_id)
    }
    fn save_exact(&mut self,id:&str,prior:&Value,next:&Value)->Result<Value,String>{
        self.store.mutate_job(id,|current|{
            if &current!=prior{return Err("Stale local SQLite candidate".into())}
            Ok(next.clone())
        })
    }
    fn job_action(&mut self,_id:&str,_action:&str)->Result<Value,String>{Err("Not in fixture".into())}
    fn task_command(&mut self,_body:&Value)->Result<Value,String>{Err("Not in fixture".into())}
    fn task_action(&mut self,_id:&str,_task:&str,_action:&str)->Result<Value,String>{Err("Not in fixture".into())}
    fn job_set_state(&mut self,_id:&str,_state:&str,_target:&Value)->Result<Value,String>{Err("Not in fixture".into())}
    fn task_set_state(&mut self,_id:&str,_task:&str,_state:&str,_target:&Value)->Result<Value,String>{Err("Not in fixture".into())}
    fn event_history(&mut self,_id:&str,_task:Option<&str>,_limit:i64)->Result<Vec<Value>,String>{Ok(vec![])}
    fn publish_event(&mut self,_event:&Value)->Result<(),String>{Ok(())}
    fn subscribe_events(&mut self)->Receiver<String>{mpsc::channel().1}
    fn router_test(&mut self,_id:&str,_task:&str)->Result<Value,String>{Err("Not in fixture".into())}
    fn decision_audit(&mut self)->Result<Vec<Value>,String>{Ok(vec![])}
    fn account_usage(&mut self)->Result<Value,String>{Ok(json!({}))}
    fn github_usage(&mut self)->Result<Option<Value>,String>{Ok(None)}
    fn status(&mut self)->Value{json!({"fixture":"sqlite-service"})}
    fn registered_agents(&mut self)->Result<Vec<Value>,String>{Ok(vec![])}
    fn effect(&mut self,_action:&Value)->Result<(),String>{
        self.effects.fetch_add(1,Ordering::SeqCst);Ok(())
    }
}
fn fixture()->(PathBuf,Vec<String>,DaemonConfig,Local,Arc<AtomicUsize>){
    let nanos=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root=std::env::temp_dir().join(format!("rust2-service-{}-{nanos}",std::process::id()));
    fs::create_dir_all(&root).unwrap();
    let work=root.join("project");fs::create_dir_all(&work).unwrap();
    let status=std::process::Command::new("git").args(["init","--quiet"])
        .current_dir(&work).status().unwrap();assert!(status.success());
    let store_path=root.join("job.sqlite");
    let store=SQLiteRelayStore::open(&store_path,Some("svc-1")).unwrap();
    let job=json!({"id":"svc-1","repository":"project","projectRoot":work,
        "prNumber":0,"title":"Ephemeral dashboard","objective":"Idle",
        "state":"COMPLETED","createdAt":"2026-11-18T09:00:00.000Z",
        "updatedAt":"2026-11-18T09:00:00.000Z","tasks":[],"plans":[],
        "reviewEnabled":false,"pause":null,"headSha":"known-sha"});
    store.save_job(&job).unwrap();
    let jsonfile=root.join("job.json");fs::write(&jsonfile,job.to_string()).unwrap();
    let args=vec!["--file".to_string(),jsonfile.display().to_string(),
        "--port".into(),"0".into(),"--interval".into(),"120000".into(),
        "--owner".into(),"isolated".into(),"--events".into(),"none".into()];
    let mut config=DaemonConfig::from_argv(&[],&json!({
        "workspaceRoot":root,"storeDirectory":root,"graphDirectory":
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow"),
        "dashboardAsset":root.join("dashboard.html"),"routerRulesPath":root.join("rules.md")
    })).unwrap();
    config.port=0;config.interval_ms=120000;
    let effects=Arc::new(AtomicUsize::new(0));
    let loads=Arc::new(AtomicUsize::new(0));
    let host=Local{store,effects:Arc::clone(&effects),loads,fault_initial:false};
    (root,args,config,host,effects)
}
fn read_http(port:u16,path:&str)->String{
    let mut socket=TcpStream::connect(("127.0.0.1",port)).unwrap();
    socket.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    write!(socket,"GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").unwrap();
    socket.flush().unwrap();
    let mut response=String::new();socket.read_to_string(&mut response).unwrap();
    response
}
#[test]
fn create_service_binds_loopback_and_owns_dashboard_watchdog_and_shutdown(){
    let (root,args,config,host,effects)=fixture();
    let mut paths=RuntimePaths::for_fixture(&root);paths.store=config.store_directory.clone();
    let planner=runtime(&args,paths).unwrap();
    let manager=Arc::new(OwnedProcessManager::default());
    let mut service=create_service(&args,config,host,planner.reconciler,None,manager).unwrap();
    let port=service.port;
    assert!(port>0);assert!(!service.is_stopped());
    let response=read_http(port,"/");
    assert!(response.starts_with("HTTP/1.1 200"),"{response}");
    assert!(!service.watchdog_cleared);
    assert_eq!(effects.load(Ordering::SeqCst),0);
    service.stop().unwrap();assert!(service.is_stopped());
    assert!(service.watchdog_cleared);
    service.stop().unwrap();
    assert!(TcpStream::connect(("127.0.0.1",port)).is_err());
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn start_service_initial_reconcile_fails_closed_and_dashboard_remains_available(){
    let (root,args,config,mut host,effects)=fixture();
    host.fault_initial=true;
    let mut paths=RuntimePaths::for_fixture(&root);paths.store=config.store_directory.clone();
    let planner=runtime(&args,paths).unwrap();
    let manager=Arc::new(OwnedProcessManager::default());
    let mut service=start_service(&args,config,host,planner.reconciler,None,manager).unwrap();
    assert!(read_http(service.port,"/").starts_with("HTTP/1.1 200"));
    assert_eq!(effects.load(Ordering::SeqCst),0);
    assert!(service.services.lock().unwrap().loads.load(Ordering::SeqCst)>=2);
    service.stop().unwrap();
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn missing_file_and_binding_mismatch_fail_before_any_socket(){
    let (root,mut args,config,host,_effects)=fixture();
    args[1]=root.join("missing.json").to_string_lossy().into();
    let manager=Arc::new(OwnedProcessManager::default());
    let mut paths=RuntimePaths::for_fixture(&root);paths.store=config.store_directory.clone();
    let planner=runtime(&args,paths).unwrap();
    let error=match create_service(&args,config,host,planner.reconciler,None,manager){
        Ok(_)=>panic!("Missing File should reject"),Err(error)=>error
    };
    assert!(error.contains("Local Job file"),"{error}");
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn event_wake_reuses_same_sqlite_reconciler_and_unsubscribes_on_stop(){
    use agents_relay_rust2::events::MemoryEventBus;
    let (root,args,config,host,effects)=fixture();
    let loads=Arc::clone(&host.loads);
    let mut paths=RuntimePaths::for_fixture(&root);paths.store=config.store_directory.clone();
    let planner=runtime(&args,paths).unwrap();
    let bus=Arc::new(MemoryEventBus::new());
    let manager=Arc::new(OwnedProcessManager::default());
    let mut service=create_service(&args,config,host,planner.reconciler,
        Some(Arc::clone(&bus) as Arc<dyn agents_relay_rust2::cli_support_events::ServiceEventBusPort>),
        manager).unwrap();
    let initial=loads.load(Ordering::SeqCst);
    bus.publish(&json!({"job_id":"svc-1","type":"job.wake"})).unwrap();
    for _ in 0..80{
        if loads.load(Ordering::SeqCst)>initial{break;}
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(loads.load(Ordering::SeqCst)>initial,
        "event subscription must wake the same owned native Reconciler");
    assert_eq!(effects.load(Ordering::SeqCst),0);
    service.stop().unwrap();
    let at_stop=loads.load(Ordering::SeqCst);
    bus.publish(&json!({"job_id":"svc-1","type":"job.wake"})).unwrap();
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(loads.load(Ordering::SeqCst),at_stop,
        "unsubscribe prevents further reconciliation after stop");
    fs::remove_dir_all(root).unwrap();
}
