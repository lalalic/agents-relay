// Node src/cli.ts createService/startService. A single caller-owned SQLite
// Store, Graph Reconciler and existing Dashboard HTTP backend serve one Job.
// Local session/watcher/owned subprocess cleanup belongs to this Service,
// not to a separate lifecycle scheduler or a process-name kill shortcut.
use crate::{
    cli_core_support::arg,
    cli_support_events::ServiceEventBusPort,
    dashboard::serve_dashboard,
    dashboard_api::{DashboardApiOptions,NativeDashboardApi},
    events::Wake,
    owned_process::{OwnedProcessManager,TerminationReason},
    reconciler::Reconciler,
    reconciler_durable::ReconcileHost,
    relayd::{DaemonConfig,DaemonDashboardBackend,DaemonServices},
};
use serde_json::{json,Value};
use std::{
    collections::HashSet,net::TcpListener,
    sync::{Arc,Mutex,atomic::{AtomicBool,Ordering},mpsc::{self,Sender,RecvTimeoutError}},
    thread::{self,JoinHandle},time::Duration,
};

struct ServiceReconcileHost<'a,S:DaemonServices>(&'a mut S);
impl<S:DaemonServices> ReconcileHost for ServiceReconcileHost<'_,S>{
    fn load(&mut self,id:&str)->Result<Value,String>{self.0.load(id)}
    fn persist(&mut self,id:&str,old:&Value,new:&Value)->Result<Value,String>{
        self.0.save_exact(id,old,new)
    }
    fn launch(&mut self,effect:&Value)->Result<(),String>{self.0.effect(effect)}
    fn broadcast(&mut self,event:&Value)->Result<(),String>{self.0.publish_event(event)}
    fn load_execution_process(&mut self,job_id:&str,task_id:&str,
        execution_id:&str)->Result<Option<Value>,String>{
        self.0.load_execution_process(job_id,task_id,execution_id)
    }
}
fn reconcile_one<S:DaemonServices>(
    store:&Arc<Mutex<S>>,reconciler:&Arc<Mutex<Reconciler>>,
    job_id:&str,config:&DaemonConfig,
)->Result<Value,String>{
    let mut runner=reconciler.lock().map_err(|_|"Service Reconciler poisoned")?;
    let mut host=store.lock().map_err(|_|"Service Store poisoned")?;
    let snapshot=host.load(job_id)?;
    let needs_dispatch=snapshot.get("state").and_then(Value::as_str)==Some("ACTIVE")
        &&snapshot.get("pause").is_none_or(Value::is_null);
    let project=if needs_dispatch{
        crate::workspace::resolve_job_project_root(&snapshot)?
    }else{
        snapshot.get("projectRoot").and_then(Value::as_str)
            .map(std::path::PathBuf::from)
            .unwrap_or_else(||config.workspace_root.clone())
    };
    let registered=if needs_dispatch{host.registered_agents()?}else{Vec::new()};
    let usage=if needs_dispatch{host.account_usage().ok()}else{None};
    let adapters=runner.options.get("adapters").and_then(Value::as_array)
        .cloned().unwrap_or_default();
    let roots=json!({"workspaceRoot":config.workspace_root});
    runner.reconcile(job_id,snapshot.get("headSha").and_then(Value::as_str),
        &project,&roots,&adapters,&registered,usage.as_ref(),
        &mut ServiceReconcileHost(&mut *host))
}

pub struct Service<S:DaemonServices+'static>{
    pub job:Value,
    pub port:u16,
    pub watchdog_cleared:bool,
    pub services:Arc<Mutex<S>>,
    pub reconciler:Arc<Mutex<Reconciler>>,
    config:DaemonConfig,
    shutdown:Arc<AtomicBool>,
    wake:Sender<()>,
    watcher:Option<Box<dyn FnOnce()+Send>>,
    event_bus:Option<Arc<dyn ServiceEventBusPort>>,
    watchdog:Option<JoinHandle<()>>,
    dashboard:Option<JoinHandle<Result<(),String>>>,
    owned:Arc<OwnedProcessManager>,
}
impl<S:DaemonServices+'static> Service<S>{
    /// The request is always read through the same bound local Store.
    /// Initial Reconciler failure cannot close the Dashboard listener.
    pub fn reconcile(&self)->Result<Value,String>{
        reconcile_one(&self.services,&self.reconciler,
            self.job["id"].as_str().unwrap_or(""),&self.config)
    }
    pub fn is_stopped(&self)->bool{self.shutdown.load(Ordering::Acquire)}
    pub fn stop(&mut self)->Result<(),String>{
        if self.shutdown.swap(true,Ordering::AcqRel){return Ok(());}
        self.watchdog_cleared=true;
        // Unsubscribe first; future event bus receipts must not rearm a job.
        if let Some(unsubscribe)=self.watcher.take(){unsubscribe();}
        let bus_error=self.event_bus.take().and_then(|bus|bus.close().err());
        let _=self.wake.send(());
        if let Some(watchdog)=self.watchdog.take(){
            watchdog.join().map_err(|_|"Service watchdog panicked")?;
        }
        if let Some(server)=self.dashboard.take(){
            server.join().map_err(|_|"Dashboard thread panicked".to_owned())??;
        }
        self.owned.shutdown_owned_processes(TerminationReason::ParentShutdown);
        if let Some(error)=bus_error{return Err(error);}
        Ok(())
    }
}
impl<S:DaemonServices+'static> Drop for Service<S>{
    fn drop(&mut self){let _=self.stop();}
}

/// Construct a live, locally bound Dashboard+watchdog session against the
/// caller's exact SQLite-backed Job/Store. All network and process resources
/// are owned here and closed together. A caller supplies the runtime ports;
/// they must not be synthesized from an in-memory dashboard snapshot.
pub fn create_service<S:DaemonServices+'static>(
    args:&[String],config:DaemonConfig,services:S,
    reconciler:Reconciler,bus:Option<Arc<dyn ServiceEventBusPort>>,
    owned:Arc<OwnedProcessManager>,
)->Result<Service<S>,String>{
    let bound_file=arg(args,"--file","");
    let file_id=if !bound_file.is_empty(){
        let raw=std::fs::read_to_string(bound_file)
            .map_err(|error|format!("Local Job file {bound_file}: {error}"))?;
        let parsed:Value=serde_json::from_str(&raw).map_err(|error|error.to_string())?;
        Some(parsed.get("id").and_then(Value::as_str)
            .filter(|id|!id.is_empty()).ok_or("Local Job file missing ID")?.to_owned())
    }else{None};
    let job_id=arg(args,"--id","");
    let job_id=if job_id.is_empty(){file_id.as_deref().unwrap_or("")}
        else{job_id};
    if job_id.is_empty(){return Err("Local Job requires --id or --file Store binding".into());}
    if let Some(bound)=file_id.as_deref(){
        if bound!=job_id{return Err("Local --file Job ID binding mismatch".into());}
    }
    // The Reconciler task/Plan ID allocator and the host must address the
    // same authoritative SQLite root; two roots would split Job identity.
    let same_store=std::fs::canonicalize(&reconciler.store_directory).ok()
        .zip(std::fs::canonicalize(&config.store_directory).ok())
        .is_some_and(|(left,right)|left==right)
        ||reconciler.store_directory==config.store_directory;
    if !same_store{
        return Err("CLI Reconciler and service must use the same SQLite Store directory".into());
    }
    let services=Arc::new(Mutex::new(services));
    let job=services.lock().map_err(|_|"Service Store poisoned")?.load(job_id)?;
    if job["id"].as_str()!=Some(job_id){
        return Err("Immutable local Job ID binding mismatch".into());
    }
    let config=DaemonConfig{repositories:vec![job["repository"].as_str().unwrap_or("").into()],
        ..config};
    let port=if args.iter().any(|arg|arg=="--port"){
        arg(args,"--port","").parse::<u16>()
            .map_err(|_|"--port must be an integer between 0 and 65535".to_string())?
    }else{config.port};
    let listener=TcpListener::bind(("127.0.0.1",port))
        .map_err(|error|format!("Dashboard bind: {error}"))?;
    let port=listener.local_addr().map_err(|error|error.to_string())?.port();
    let stop=Arc::new(AtomicBool::new(false));
    let api=Arc::new(NativeDashboardApi::new(DashboardApiOptions{
        graph_directory:config.graph_directory.clone(),
        router_rules_path:config.router_rules_path.clone(),
        webhook_secret:None,webhook_repositories:HashSet::new(),
        webhook_job_id:None,webhook_pr_number:None,
    },DaemonDashboardBackend{config:config.clone(),services:Arc::clone(&services)}));
    let server_stop=Arc::clone(&stop);
    let dashboard=thread::spawn(move||serve_dashboard(listener,api,server_stop)
        .map_err(|error|format!("Dashboard server: {error}")));
    let reconciler=Arc::new(Mutex::new(reconciler));
    let (wake,receive)=mpsc::channel::<()>();
    let callback:Wake=Arc::new({let wake=wake.clone();move |_event|{
        wake.send(()).map_err(|error|error.to_string())
    }});
    let watcher=if let Some(bus)=&bus{
        match bus.subscribe(job_id,callback){
            Ok(stop)=>Some(stop),
            Err(error)=>{
                stop.store(true,Ordering::Release);
                let _=dashboard.join();
                return Err(error);
            }
        }
    }else{None};
    let interval=arg(args,"--interval","").parse::<u64>()
        .ok().unwrap_or(config.interval_ms).max(1);
    let tick=Duration::from_millis(interval);
    let worker_stop=Arc::clone(&stop);
    let worker_store=Arc::clone(&services);
    let worker_reconciler=Arc::clone(&reconciler);
    let worker_config=config.clone();
    let worker_id=job_id.to_string();
    let watchdog=thread::spawn(move||while !worker_stop.load(Ordering::Acquire){
        match receive.recv_timeout(tick){
            Ok(())|Err(RecvTimeoutError::Timeout)=>{
                if worker_stop.load(Ordering::Acquire){break;}
                if let Err(error)=reconcile_one(&worker_store,&worker_reconciler,
                    &worker_id,&worker_config){
                    eprintln!("warning: Service reconcile failed: {error}");
                }
            },
            Err(RecvTimeoutError::Disconnected)=>break,
        }
    });
    Ok(Service{job,port,watchdog_cleared:false,services,reconciler,
        config,shutdown:stop,wake,watcher,event_bus:bus,watchdog:Some(watchdog),
        dashboard:Some(dashboard),owned})
}

/// Node startService: initial Graph reconcile is best effort after the server
/// is listening; failures must not make Dashboard inspection unavailable.
pub fn start_service<S:DaemonServices+'static>(
    args:&[String],config:DaemonConfig,services:S,
    reconciler:Reconciler,bus:Option<Arc<dyn ServiceEventBusPort>>,
    owned:Arc<OwnedProcessManager>,
)->Result<Service<S>,String>{
    let session=create_service(args,config,services,reconciler,bus,owned)?;
    if let Err(error)=session.reconcile(){
        eprintln!("Initial reconciliation failed; dashboard remains available: {error}");
    }
    Ok(session)
}
