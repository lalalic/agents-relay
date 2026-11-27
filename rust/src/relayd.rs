// Head-to-head Phase1 port: src/relayd.ts
// Workspace Relay daemon: SQLite-first discovery, one Job ID registry,
// one Pool, optional NATS and optional post-completion remote delivery.
// During Phase1 this is SOURCE ONLY; it must not be launched against live
// Relay. The Dashboard client is served unchanged by dashboard.rs.
use crate::{
    dashboard::serve_dashboard,
    dashboard_api::{DashboardApiOptions,DashboardApiServices,NativeDashboardApi},
    local_merge_projection::reconcile_completed_local_delivery,
    pool::{RepositoryWorkerPool,runnable_managed_jobs},
    reconciler::Reconciler,
    reconciler_durable::ReconcileHost,
    relay_store::SQLiteRelayStore,
    relay_store_discovery::{
        discover_local_relay_store_snapshots,relay_unified_store_path,
        LocalRelayStoreSnapshot,
    },
    relayd_utilities::{
        normalize_daemon_arguments,value,DAEMON_HELP,
    },
    runtime_status::derive_job_runtime_status,
    runtime_summary::summarize_runtime,
    store::dashboard_managed_jobs,
    workspace::{default_workspace_root,resolve_job_project_root,
        task_requires_managed_worktree,ensure_local_job_source_branch,
        prepare_local_job_execution_worktree},
};
use chrono::Utc;
use serde_json::{json,Value};
use std::{
    collections::{HashMap,HashSet},path::{Path,PathBuf},
    net::TcpListener,
    sync::{mpsc::Receiver,Arc,Mutex,atomic::{AtomicBool,Ordering}},
    time::{Duration,Instant},
};
fn field<'a>(v:&'a Value,key:&str)->&'a str{
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
pub const DEFAULT_DASHBOARD_PORT:u16=8787;
pub const DEFAULT_CONCURRENCY:usize=4;
pub const DEFAULT_RECONCILE_INTERVAL:u64=300_000;
pub fn daemon_help()->&'static str{DAEMON_HELP}
pub fn troubleshooter_qa_path()->Result<PathBuf,String>{
    if let Some(path)=std::env::var_os("AGENTS_RELAY_TROUBLESHOOTER_QA_PATH"){
        return Ok(PathBuf::from(path));
    }
    Ok(crate::runtime_resources::package_root()?.join("skills/agents-relay/troubleshooter-qa.md"))
}
#[derive(Clone,Debug)]
pub struct DaemonConfig{
    pub workspace_root:PathBuf,
    pub store_directory:PathBuf,
    pub graph_directory:PathBuf,
    pub profile_home:PathBuf,
    pub policy_path:PathBuf,
    pub router_rules_path:PathBuf,
    pub dashboard_asset:PathBuf,
    pub repositories:Vec<String>,
    pub port:u16,
    pub concurrency:usize,
    pub interval_ms:u64,
    pub event_transport:Value,
}
impl DaemonConfig{
    pub fn from_argv(args:&[String],options:&Value)->Result<Self,String>{
        let roots=normalize_daemon_arguments(args,
            options.get("workspaceRoot").and_then(Value::as_str))?;
        let get_path=|key:&str,default:&str|{
            options.get(key).and_then(Value::as_str)
                .filter(|s|!s.is_empty()).map(PathBuf::from)
                .unwrap_or_else(||PathBuf::from(default))
        };
        let workspace=roots.workspace_root.unwrap_or_else(default_workspace_root);
        let port=value(args,"--port","8787").parse::<u16>()
            .map_err(|_|"Invalid --port")?;
        if port==0{return Err("Daemon port must be positive".into());}
        let concurrency=value(args,"--concurrency","4").parse::<usize>()
            .map_err(|_|"Invalid --concurrency")?.max(1);
        let interval_ms=value(args,"--interval","300000").parse::<u64>()
            .map_err(|_|"Invalid --interval")?;
        let repositories=roots.repository.into_iter().collect::<Vec<_>>();
        let event_transport=crate::events_bus_runtime::resolve_events_bus_runtime(
            options.get("environment").unwrap_or(&json!({})))?;
        Ok(Self{
            workspace_root:workspace,
            store_directory:get_path("storeDirectory",
                &crate::relay_store::relay_store_directory().to_string_lossy()),
            graph_directory:get_path("graphDirectory","workflow"),
            profile_home:get_path("codexHome",".codex"),
            policy_path:get_path("routingPolicyPath",
                ".agents-relay/routing-policy.json"),
            router_rules_path:get_path("routerRulesPath",
                ".agents-relay/execution-router-rules.md"),
            dashboard_asset:get_path("dashboardAsset",
                "dist/dashboard.html"),
            repositories,port,concurrency,interval_ms,
            event_transport,
        })
    }
}
pub(crate) fn managed_view(snapshot:&LocalRelayStoreSnapshot,job:&Value)->Value{
    let publication=snapshot.publications.get(field(job,"id"));
    let pr_state=snapshot.facts.as_ref().and_then(|v|v.get("state"))
        .and_then(Value::as_str).unwrap_or("UNKNOWN");
    let mut display=job.clone();
    display["githubState"]=json!(pr_state);
    display["runtimeStatus"]=json!(derive_job_runtime_status(job,pr_state));
    display["draft"]=json!(false);
    display["mergedAt"]=Value::Null;
    display["closedAt"]=Value::Null;
    display["publication"]=publication.and_then(|p|p.get("latest"))
        .cloned().unwrap_or(Value::Null);
    display["publicationFailure"]=publication.and_then(|p|p.get("failure"))
        .cloned().unwrap_or(Value::Null);
    display["publicationObservedAt"]=publication.and_then(|p|p.get("updatedAt"))
        .cloned().unwrap_or(Value::Null);
    display
}
/// Exactly the Node inventory rules: all sqlite-scoped active Jobs are
/// retained; only obsolete terminal copies are hidden if a single current
/// live Job owns the ID. Never recursively scan Workspace for jobs.
pub fn inventory_from_local(
    config:&DaemonConfig,limit_history:bool,
)->Result<Vec<Value>,String>{
    let snapshots=discover_local_relay_store_snapshots(&config.store_directory)?;
    let mut allowed=config.repositories.iter().cloned()
        .collect::<HashSet<_>>();
    if allowed.is_empty(){
        for snapshot in &snapshots{
            for job in &snapshot.jobs{
                allowed.insert(field(job,"repository").into());
            }
        }
    }
    let mut entries=Vec::new();
    for snapshot in &snapshots{
        for job in &snapshot.jobs{
            if allowed.contains(field(job,"repository")){
                entries.push(managed_view(snapshot,job));
            }
        }
    }
    let mut live=HashMap::<String,usize>::new();
    for entry in &entries{
        if !matches!(field(entry,"state"),"COMPLETED"|"CANCELLED"){
            *live.entry(field(entry,"id").into()).or_default()+=1;
        }
    }
    entries.retain(|job|
        !matches!(field(job,"state"),"COMPLETED"|"CANCELLED")
            ||live.get(field(job,"id")).copied()!=Some(1));
    if limit_history{Ok(dashboard_managed_jobs(&entries))}
    else{Ok(entries)}
}
fn dashboard_inventory(config:&DaemonConfig)->Result<Vec<Value>,String>{
    // Job visibility is strictly a local SQLite read. Publication receipts
    // are projected by the independent observer, never fetched here.
    inventory_from_local(config,false)
}
fn dashboard_job_by_id(config:&DaemonConfig,id:&str,repo:Option<&str>)
    ->Result<Option<Value>,String>{
    let snapshot=crate::relay_store_discovery::discover_unified_job_by_id(
        &config.store_directory,id)?;
    let Some(snapshot)=snapshot else{return Ok(None);};
    let Some(source)=snapshot.jobs.first() else{return Ok(None);};
    let job=managed_view(&snapshot,source);
    if field(&job,"id")!=id||repo.is_some_and(|repo|field(&job,"repository")!=repo)
        ||(!config.repositories.is_empty()&&!config.repositories.iter().any(|r|r==field(&job,"repository"))){
        return Ok(None);
    }
    Ok(Some(job))
}
pub fn repository_bindings(inventory:&[Value])->Result<HashMap<String,String>,String>{
    let mut bound=HashMap::new();
    for job in inventory{
        let repository=field(job,"repository");
        let root=field(job,"projectRoot");
        if repository.is_empty()||root.is_empty(){continue;}
        if let Some(existing)=bound.insert(repository.into(),root.into()){
            if existing!=root{return Err(format!(
                "Local repository binding {repository} conflicts: {existing} vs {root}"));
            }
        }
    }
    Ok(bound)
}
pub fn exact_job(inventory:&[Value],job_id:&str,repo:Option<&str>)->Result<Option<Value>,String>{
    let matches=inventory.iter().filter(|job|
        field(job,"id")==job_id
            &&repo.is_none_or(|repo|field(job,"repository")==repo)
).collect::<Vec<_>>();
    if matches.len()>1{
        return Err(format!("Job {job_id} has ambiguous durable SQLite identities"));
    }
    Ok(matches.first().map(|v|(*v).clone()))
}
/// Every selectable local Job must be read back through its exact immutable
/// ID; matching a repository name or PR number is not enough.
pub fn require_local_job_binding(
    config:&DaemonConfig,job_id:&str,
)->Result<Value,String>{
    let inventory=inventory_from_local(config,false)?;
    exact_job(&inventory,job_id,None)?.ok_or_else(||format!(
        "Local Job {job_id} not found or ambiguous in SQLite registry"))
}
pub struct DaemonWorkPort<'a>{
    pub load:&'a mut dyn FnMut(&str)->Result<Value,String>,
    pub persist:&'a mut dyn FnMut(&str,&Value,&Value)->Result<Value,String>,
    pub launch:&'a mut dyn FnMut(&Value)->Result<(),String>,
    pub broadcast:&'a mut dyn FnMut(&Value)->Result<(),String>,
}
/// The workspace daemon and single-Job CLI run the same Reconciler Graph
/// and SQLite persistence path; neither owns a second Job state machine.
pub fn reconcile_durable_job(
    reconciler:&mut Reconciler,job_id:&str,
    verified_head:Option<&str>,project:&Path,roots:&Value,
    adapters:&[Value],registered:&[Value],usage:Option<&Value>,
    ports:&mut DaemonWorkPort<'_>,
)->Result<Value,String>{
    struct Adapter<'a,'b>(&'a mut DaemonWorkPort<'b>);
    impl ReconcileHost for Adapter<'_,'_>{
        fn load(&mut self,id:&str)->Result<Value,String>{(self.0.load)(id)}
        fn persist(&mut self,id:&str,prior:&Value,next:&Value)->Result<Value,String>{
            (self.0.persist)(id,prior,next)
        }
        fn launch(&mut self,action:&Value)->Result<(),String>{(self.0.launch)(action)}
        fn broadcast(&mut self,event:&Value)->Result<(),String>{(self.0.broadcast)(event)}
        fn load_execution_process(&mut self,_job_id:&str,_task_id:&str,
            _execution_id:&str)->Result<Option<Value>,String>{
            Err("DaemonWorkPort requires execution process SQLite binding".into())
        }
    }
    reconciler.reconcile(job_id,verified_head,project,roots,
        adapters,registered,usage,&mut Adapter(ports))
}
/// Only an explicit marker grants optional remote delivery. Historical
/// COMPLETED Jobs without markers are not even opened writable.
pub fn eligible_remote_delivery(job:&Value)->bool{
    field(job,"state")=="COMPLETED"
        &&job.pointer("/localMerge/status").and_then(Value::as_str)==Some("succeeded")
        &&job.pointer("/localMerge/mergedCommitSha")
            ==job.pointer("/remoteDelivery/mergedCommitSha")
        &&matches!(job.pointer("/remoteDelivery/status")
            .and_then(Value::as_str),Some("pending"|"failed"|"processing"))
}
pub fn remote_delivery_candidates(config:&DaemonConfig)
    ->Result<Vec<Value>,String>{
    Ok(inventory_from_local(config,false)?.into_iter()
        .filter(eligible_remote_delivery).collect())
}
/// DaemonServices are supplied by the executable host. No production ports
/// are initialized, and NO daemon is started, merely by importing this file.
/// Independent observation callbacks can never commit Graph state or launch
/// a worker. Concurrency budgets are per external service, not per API call.
pub type HistoryRead=Arc<dyn Fn(&str,Option<&str>,i64)->Result<Vec<Value>,String>+Send+Sync>;
pub type UsageRead=Arc<dyn Fn()->Result<Value,String>+Send+Sync>;
pub type RouterRead=Arc<dyn Fn(&str,&str)->Result<Value,String>+Send+Sync>;
#[derive(Clone)]
pub struct DashboardObservationPorts{
    pub history:HistoryRead,
    pub usage:UsageRead,
    pub routing_usage:UsageRead,
    pub router:RouterRead,
    pub status:Arc<dyn Fn()->Value+Send+Sync>,
}
struct ObservationBudget{
    in_flight:std::sync::atomic::AtomicUsize,
    maximum:usize,
}
impl ObservationBudget{
    fn new(maximum:usize)->Self{Self{in_flight:std::sync::atomic::AtomicUsize::new(0),maximum}}
    fn run<T>(&self,read:impl FnOnce()->Result<T,String>)->Result<T,String>{
        self.in_flight.fetch_update(Ordering::AcqRel,Ordering::Acquire,|n|
            (n<self.maximum).then_some(n+1)).map_err(|_|"Observation busy; retry later".to_owned())?;
        struct Permit<'a>(&'a std::sync::atomic::AtomicUsize);
        impl Drop for Permit<'_>{fn drop(&mut self){self.0.fetch_sub(1,Ordering::Release);}}
        let _permit=Permit(&self.in_flight);
        read()
    }
}
pub trait DaemonServices:Send{
    fn dashboard_observation_ports(&self)->Option<DashboardObservationPorts>{None}
    fn dashboard_sse(&self)->Option<crate::dashboard_sse::DashboardSse>{None}

    /// A live-store shadow must not run Pool scheduling, Graph reconcile,
    /// remote delivery or SSE emit loops. It only serves on-demand SQLite
    /// read-only HTTP observations; it never owns the production lease.
    fn is_read_only_shadow(&self)->bool{false}
    fn control(&mut self,body:&Value)->Result<Value,String>;
    fn load(&mut self,id:&str)->Result<Value,String>;
    fn load_execution_process(&mut self,_job_id:&str,_task_id:&str,
        _execution_id:&str)->Result<Option<Value>,String>{
        Err("Daemon Store execution process lookup is not wired".into())
    }
    fn save_exact(&mut self,id:&str,prior:&Value,next:&Value)
        ->Result<Value,String>;
    fn job_action(&mut self,id:&str,action:&str)->Result<Value,String>;
    fn task_command(&mut self,body:&Value)->Result<Value,String>;
    fn task_action(&mut self,id:&str,task_id:&str,action:&str)
        ->Result<Value,String>;
    fn job_set_state(&mut self,id:&str,state:&str,target:&Value)
        ->Result<Value,String>;
    fn task_set_state(&mut self,id:&str,task_id:&str,state:&str,
        target:&Value)->Result<Value,String>;
    fn event_history(&mut self,id:&str,task_id:Option<&str>,limit:i64)
        ->Result<Vec<Value>,String>;
    fn publish_event(&mut self,event:&Value)->Result<(),String>;
    /// Observation/effect adapter, not a workflow scheduler. Poll leased
    /// Model Workers independently from Pool admission: a Worker already
    /// running cannot be "runnable" merely to get its terminal event.
    fn poll_model_events(&mut self,_id:&str)->Result<usize,String>{Ok(0)}
    /// Optional, explicitly bound observational publication transport.
    fn publication_history_runtime(&self)->Option<Value>{None}
    fn drain_dashboard_events(&mut self)->Result<(),String>{Ok(())}
    /// Publish only transactionally committed Worker outbox receipts to the
    /// existing Events Bus. External Worker processes do not call the
    /// daemon's in-process broadcast port, so that port alone is insufficient.
    fn flush_workflow_events(&mut self)->Result<usize,String>{Ok(0)}
    /// An observed broker callback requests one early Graph/SQLite scan.
    /// The callback never applies Worker events or mutates the Job directly.
    fn has_pending_model_events(&mut self)->bool{false}
    fn deliver_pending_escalations(&mut self,id:&str)->Result<(),String>{
        let snapshot=self.load(id)?;
        if crate::escalation_notifier::candidate_notifications(&snapshot).is_empty(){
            return Ok(());
        }
        Err("Daemon escalation notification Store is not bound".into())
    }
    // SSE frames are observations from the authoritative live Event Bus.
    fn subscribe_events(&mut self)->Receiver<String>;
    /// Observe committed SQLite revisions that were written by a separate
    /// Script/Provider worker process, outside this daemon host's in-memory
    /// publish callbacks. Never mutate Job state or invent Worker events.
    fn observe_committed_job_snapshot(&mut self,_id:&str)->Result<(),String>{
        Ok(())
    }
    fn router_test(&mut self,id:&str,task_id:&str)->Result<Value,String>;
    fn decision_audit(&mut self)->Result<Vec<Value>,String>;
    fn account_usage(&mut self)->Result<Value,String>;
    fn routing_usage(&mut self)->Result<Value,String>{self.account_usage()}
    fn github_usage(&mut self)->Result<Option<Value>,String>;
    fn status(&mut self)->Value;
    fn registered_agents(&mut self)->Result<Vec<Value>,String>;
    fn routing_adapters(&self)->Vec<Value>{
        vec![json!({"id":"codex","name":"codex","capabilities":["model","codex"]})]
    }
    /// Only an authoritative SQLite owner can preallocate numeric child IDs
    /// and atomically schedule Graph-approved dependency revision Tasks.
    /// Read-only and unbound hosts never fabricate new revisions.
    fn prepare_dependency_revisions(&mut self,_id:&str)->Result<(),String>{Ok(())}
    /// Physical completion is an action selected by Job Lifecycle Graph, not
    /// a Task side effect or a CLI status override. Hosts without a verified
    /// merge/SQLite binding leave the Job ACTIVE and fail closed.
    fn reconcile_local_completion(&mut self,_id:&str)->Result<bool,String>{Ok(false)}
    fn effect(&mut self,action:&Value)->Result<(),String>;
}
// A live daemon has one owner of mutable orchestration state. HTTP mutations
// request canonical actions through a bounded queue and await the actual receipt.
// The standalone legacy Service fixture keeps its injected host binding.
type ServiceCall<S>=Box<dyn FnOnce(&mut S)+Send>;
enum ServiceAccess<S>{
    Shared(Arc<Mutex<S>>),
    Owner(std::sync::mpsc::SyncSender<ServiceCall<S>>),
}
impl<S> Clone for ServiceAccess<S>{
    fn clone(&self)->Self{match self{
        Self::Shared(host)=>Self::Shared(Arc::clone(host)),
        Self::Owner(tx)=>Self::Owner(tx.clone()),
    }}
}
impl<S:DaemonServices+'static> ServiceAccess<S>{
    fn call<T:Send+'static>(&self,f:impl FnOnce(&mut S)->Result<T,String>+Send+'static)->Result<T,String>{
        match self{
            Self::Shared(host)=>f(&mut *host.lock().map_err(|_|"Service host poisoned")?),
            Self::Owner(tx)=>{
                let (reply,receipt)=std::sync::mpsc::sync_channel(1);
                tx.try_send(Box::new(move|host|{let _=reply.send(f(host));}))
                    .map_err(|error|match error{
                        std::sync::mpsc::TrySendError::Full(_)=>"Daemon control queue busy; retry later",
                        std::sync::mpsc::TrySendError::Disconnected(_)=>"Daemon service unavailable",
                    })?;
                // Do not time out an accepted mutation and accidentally invite
                // a duplicate action while the owner still holds the command.
                receipt.recv().map_err(|_|"Daemon control receipt unavailable".to_owned())?
            }
        }
    }
}
pub struct DaemonDashboardBackend<S:DaemonServices>{
    pub config:DaemonConfig,
    services:ServiceAccess<S>,
    observation_ports:Option<DashboardObservationPorts>,
    sse:Option<crate::dashboard_sse::DashboardSse>,
    history_budget:Arc<ObservationBudget>,
    router_budget:Arc<ObservationBudget>,
    usage_budget:Arc<ObservationBudget>,
    read_only:bool,
}
impl<S:DaemonServices+'static> DaemonDashboardBackend<S>{
    pub fn new(config:DaemonConfig,services:Arc<Mutex<S>>,read_only:bool)->Self{
        let (ports,sse)=services.lock().map(|host|(host.dashboard_observation_ports(),host.dashboard_sse())).unwrap_or_default();
        Self::with_access(config,ServiceAccess::Shared(services),ports,sse,read_only)
    }
    fn with_access(config:DaemonConfig,services:ServiceAccess<S>,observation_ports:Option<DashboardObservationPorts>,
        sse:Option<crate::dashboard_sse::DashboardSse>,read_only:bool)->Self{
        Self{config,services,observation_ports,sse,
            history_budget:Arc::new(ObservationBudget::new(4)),
            router_budget:Arc::new(ObservationBudget::new(1)),
            usage_budget:Arc::new(ObservationBudget::new(4)),read_only}
    }
}
impl<S:DaemonServices+'static> DashboardApiServices for DaemonDashboardBackend<S>{
    fn detached_observations(&self)->Option<Self>{
        // Legacy fixture/observer hosts without a real independent port
        // retain the original behavior; never bypass authorization.
        self.observation_ports.as_ref()?;
        Some(Self{config:self.config.clone(),services:self.services.clone(),
            observation_ports:self.observation_ports.clone(),sse:self.sse.clone(),
            history_budget:Arc::clone(&self.history_budget),
            router_budget:Arc::clone(&self.router_budget),usage_budget:Arc::clone(&self.usage_budget),
            read_only:self.read_only})
    }
    fn supports_indexed_readonly_job(&self)->bool{self.read_only}
    fn supports_indexed_job(&self)->bool{true}
    fn discovered_jobs(&mut self,force:bool)->Result<Vec<Value>,String>{
        let _=force;dashboard_inventory(&self.config)
    }
    fn exact_job(&mut self,id:&str,repo:Option<&str>)
        ->Result<Option<Value>,String>{
        dashboard_job_by_id(&self.config,id,repo)
    }
    fn control(&mut self,body:&Value)->Result<Value,String>{
        let body=body.clone();self.services.call(move|s|s.control(&body))
    }
    fn job_action(&mut self,id:&str,action:&str)->Result<Value,String>{
        let (id,action)=(id.to_owned(),action.to_owned());self.services.call(move|s|s.job_action(&id,&action))
    }
    fn task_command(&mut self,body:&Value)->Result<Value,String>{
        let body=body.clone();self.services.call(move|s|s.task_command(&body))
    }
    fn task_action(&mut self,id:&str,task_id:&str,action:&str)->Result<Value,String>{
        let (id,task_id,action)=(id.to_owned(),task_id.to_owned(),action.to_owned());self.services.call(move|s|s.task_action(&id,&task_id,&action))
    }
    fn job_set_state(&mut self,id:&str,state:&str,target:&Value)
        ->Result<Value,String>{
        let (id,state,target)=(id.to_owned(),state.to_owned(),target.clone());self.services.call(move|s|s.job_set_state(&id,&state,&target))
    }
    fn task_set_state(&mut self,id:&str,task_id:&str,state:&str,target:&Value)
        ->Result<Value,String>{
        let (id,task_id,state,target)=(id.to_owned(),task_id.to_owned(),state.to_owned(),target.clone());self.services.call(move|s|s.task_set_state(&id,&task_id,&state,&target))
    }
    fn events(&mut self,id:&str,task_id:Option<&str>,limit:i64)
        ->Result<Vec<Value>,String>{
        if let Some(ports)=&self.observation_ports{
            return self.history_budget.run(||(ports.history)(id,task_id,limit));
        }
        let (id,task_id)=(id.to_owned(),task_id.map(str::to_owned));self.services.call(move|s|s.event_history(&id,task_id.as_deref(),limit))
    }
    fn github_webhook(&mut self,event:&Value)->Result<(),String>{
        let event=event.clone();self.services.call(move|s|s.publish_event(&event))
    }
    fn router_test(&mut self,id:&str,task_id:&str)->Result<Value,String>{
        if let Some(ports)=&self.observation_ports{
            return self.router_budget.run(||(ports.router)(id,task_id));
        }
        let (id,task_id)=(id.to_owned(),task_id.to_owned());self.services.call(move|s|s.router_test(&id,&task_id))
    }
    fn decision_audit(&mut self)->Result<Vec<Value>,String>{
        if self.observation_ports.is_some(){
            return crate::decision_audit::dashboard_records(&self.config.store_directory);
        }
        self.services.call(|s|s.decision_audit())
    }
    fn runtime_status(&mut self)->Value{
        if let Some(ports)=&self.observation_ports{return (ports.status)();}
        self.services.call(|s|Ok(s.status())).unwrap_or_else(|error|json!({"error":error}))
    }
    fn account_usage(&mut self)->Result<Value,String>{
        if let Some(ports)=&self.observation_ports{
            return self.usage_budget.run(||(ports.usage)());
        }
        self.services.call(|s|s.account_usage())
    }
    fn routing_usage(&mut self)->Result<Value,String>{
        if let Some(ports)=&self.observation_ports{
            return self.usage_budget.run(||(ports.routing_usage)());
        }
        self.services.call(|s|s.routing_usage())
    }
    fn github_usage(&mut self)->Result<Option<Value>,String>{
        // The native observation host does not expose a GitHub provider.
        if self.observation_ports.is_some(){return Ok(None);}
        self.services.call(|s|s.github_usage())
    }
    fn event_subscription(&self)->Option<Arc<dyn Fn()->Receiver<String>+Send+Sync>>{
        let sse=self.sse.clone()?;Some(Arc::new(move||sse.subscribe()))
    }
    fn subscribe_events(&mut self)->Receiver<String>{
        if let Some(sse)=&self.sse{return sse.subscribe();}
        self.services.call(|s|Ok(s.subscribe_events()))
            .unwrap_or_else(|_|std::sync::mpsc::channel().1)
    }
}
// The production daemon implements the same real SQLite CAS and Graph effect
// ports as the standalone CLI. No fixture-only persistence path is involved.
struct DaemonReconcileHost<'a,S:DaemonServices>(&'a mut S);
impl<S:DaemonServices> ReconcileHost for DaemonReconcileHost<'_,S>{
    fn load(&mut self,id:&str)->Result<Value,String>{self.0.load(id)}
    fn persist(&mut self,id:&str,prior:&Value,next:&Value)->Result<Value,String>{
        self.0.save_exact(id,prior,next)
    }
    fn launch(&mut self,action:&Value)->Result<(),String>{self.0.effect(action)}
    fn broadcast(&mut self,event:&Value)->Result<(),String>{self.0.publish_event(event)}
    fn deliver_pending_escalations(&mut self,job_id:&str)->Result<(),String>{
        self.0.deliver_pending_escalations(job_id)
    }
    fn request_troubleshooter_escalation(
        &mut self,job_id:&str,recovery_id:&str,request:&Value
    )->Result<Value,String>{
        self.0.control(&json!({
            "command":"task.escalate","jobId":job_id,"taskId":recovery_id,
            "requiredAction":request.get("requiredAction"),
            "resolutionCondition":request.get("resolutionCondition"),
            "context":request.get("context"),
        }))
    }
    fn load_execution_process(&mut self,job_id:&str,task_id:&str,
        execution_id:&str)->Result<Option<Value>,String>{
        self.0.load_execution_process(job_id,task_id,execution_id)
    }
}
/// One canonical daemon Reconciler pass. Both periodic Pool admission and
/// explicit Dashboard reconcile converge here. A wake receipt alone is not a
/// completed reconcile: graph-selected effects run after SQLite CAS.
pub fn reconcile_one_daemon_job<S:DaemonServices>(
    config:&DaemonConfig,services:&mut S,job_id:&str,capacity:usize,
    make_reconciler:impl FnOnce(&Value)->Result<Reconciler,String>,
)->Result<Value,String>{
    services.prepare_dependency_revisions(job_id)?;
    let snapshot=services.load(job_id)?;
    let project=resolve_job_project_root(&snapshot)?;
    let usage=services.routing_usage().ok();
    let registered=services.registered_agents()?;
    let adapters=services.routing_adapters();
    let mut reconciler=make_reconciler(&snapshot)?;
    reconciler.options["maxConcurrent"]=json!(capacity);
    let roots=json!({"workspaceRoot":config.workspace_root});
    let head=crate::reconciler_git_head::verified_local_head(
        &snapshot,&project,true);
    reconciler.reconcile(job_id,head.as_deref(),&project,&roots,
        &adapters,&registered,
        usage.as_ref(),&mut DaemonReconcileHost(services))
}
/// Runtime host explicit opt-in: one server, one Pool, SQLite inventory only.
pub fn run_daemon<S:DaemonServices+'static>(
    config:DaemonConfig,services:S,
    stop:&AtomicBool,
    mut make_reconciler:impl FnMut(&Value)->Result<Reconciler,String>,
)->Result<(),String>{
    let opts=DashboardApiOptions{
        graph_directory:config.graph_directory.clone(),
        router_rules_path:config.router_rules_path.clone(),
        troubleshooter_qa_path:troubleshooter_qa_path()?,
        webhook_secret:None,webhook_repositories:HashSet::new(),
        webhook_job_id:None,
    };
    let read_only_shadow=services.is_read_only_shadow();
    let publication_runtime=services.publication_history_runtime();
    let observations=services.dashboard_observation_ports();
    let sse=services.dashboard_sse();
    let (control_tx,control_rx)=std::sync::mpsc::sync_channel::<ServiceCall<S>>(64);
    let access=ServiceAccess::Owner(control_tx);
    let dashboard=Arc::new(NativeDashboardApi::new(opts,DaemonDashboardBackend::with_access(
        config.clone(),access.clone(),observations,sse,read_only_shadow)));
    // This cell is local to the single scheduler thread. Pool invokes its
    // resolve/reconcile callbacks sequentially; no shared mutable host lock.
    let services=std::cell::RefCell::new(services);
    fn drain_controls<S>(rx:&std::sync::mpsc::Receiver<ServiceCall<S>>,
        host:&std::cell::RefCell<S>,limit:usize){
        for _ in 0..limit{
            match rx.try_recv(){Ok(call)=>call(&mut *host.borrow_mut()),Err(_)=>break}
        }
    }
    // The bound loopback socket is owned by this daemon, never the production
    // Node Relay. It serves the immutable shared PWA resources and delegates
    // business requests to the single Graph/SQLite-backed daemon service.
    let listener=TcpListener::bind(("127.0.0.1",config.port))
        .map_err(|e|format!("Dashboard bind: {e}"))?;
    let dashboard_shutdown=Arc::new(AtomicBool::new(false));
    let mut pool=RepositoryWorkerPool::new(
        config.concurrency,config.graph_directory.clone());
    std::thread::scope(|scope|->Result<(),String>{
        let server_stop=Arc::clone(&dashboard_shutdown);
        let dash=scope.spawn(move ||serve_dashboard(listener,dashboard,server_stop)
            .map_err(|e|format!("Dashboard server: {e}")));
        let publication_config=config.clone();
        let publication_stop=Arc::clone(&dashboard_shutdown);
        let publication_services=access.clone();
        let publication_observer=publication_runtime.map(|runtime|scope.spawn(move||
            crate::dashboard_publication::observe_releases(
                &publication_config,&runtime,&publication_stop,|event|{
                    // Publication observation has already been persisted.
                    // Dispatch only its notification to the canonical owner.
                    let event=event.clone();
                    if let Err(error)=publication_services.call(move|host|host.publish_event(&event)){
                        eprintln!("warning: Dashboard publication notification: {error}");
                    }
                })));
        let mut first=true;
        while !stop.load(Ordering::Acquire){
            drain_controls(&control_rx,&services,32);
            if read_only_shadow{
                // No background Job scan or model/provider activity in the
                // live store. Dashboard reads use the original strictly
                // read-only connection on demand, with no stale cached Job.
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
            let result=(||->Result<(),String>{
                services.borrow_mut()
                    .drain_dashboard_events()?;
                drain_controls(&control_rx,&services,16);
                let inventory=inventory_from_local(&config,true)?;
                // Script/Model Workers commit Graph facts and append identical
                // durable event receipts from separate subprocesses. Flush
                // their outbox before reconciling successors, with a broker
                // round-trip acknowledgment before marking an event delivered.
                // A disconnected Event Bus must not block Script admission.
                if let Err(error)=services.borrow_mut()
                    .flush_workflow_events(){
                    eprintln!("warning: durable Worker EventBus outbox: {error}");
                }
                // The live Model event subscription is a daemon-level
                // observation. A leased QUEUED/RUNNING Task is intentionally
                // not in the Pool's runnable admission set, but still needs
                // task.started/progress/terminal ingestion. Never let an
                // unavailable EventBus block unrelated Script workers.
                for job in inventory.iter().filter(|job|field(job,"state")=="ACTIVE"){
                    drain_controls(&control_rx,&services,16);
                    let id=field(job,"id");
                    let receipt=services.borrow_mut()
                        .poll_model_events(id);
                    if let Err(error)=receipt{
                        eprintln!("warning: Model EventBus observation for Job {id}: {error}");
                    }
                }
                let overview=inventory.iter().map(|job|json!({"job":job}))
                    .collect::<Vec<_>>();
                pool.reconcile_discovered(&overview,
                    |id|{
                        let mut guard=services.borrow_mut();
                        guard.load(id).map(Some)
                    },
                    |id,capacity|{
                        drain_controls(&control_rx,&services,16);
                        let mut guard=services.borrow_mut();
                        reconcile_one_daemon_job(
                            &config,&mut *guard,id,capacity,|snapshot|{
                                make_reconciler(snapshot)
                            })
                    })?;
                // Only the canonical Job Lifecycle may authorize local Git
                // merge or COMPLETE. Reconcile after Task results are durably
                // written; never infer completion from a Worker receipt.
                for job in inventory.iter().filter(|j|field(j,"state")=="ACTIVE"){
                    drain_controls(&control_rx,&services,16);
                    let mut guard=services.borrow_mut();
                    guard.reconcile_local_completion(field(job,"id"))?;
                }
                // Node subscribeLocalCommits observes durable writes even
                // from a separate Worker process. Poll the authoritative
                // SQLite snapshot on this same daemon tick to close the
                // native SSE gap for Script/Provider out-of-process commits.
                // The host de-duplicates identical revisions and skips work
                // when no SSE client is listening.
                for job in &inventory{
                    let id=field(job,"id");
                    let result=services.borrow_mut()
                        .observe_committed_job_snapshot(id);
                    if let Err(error)=result{
                        eprintln!("warning: Dashboard SQLite observation for Job {id}: {error}");
                    }
                }
                // Optional remote push is a distinct, durable projection.
                // A historic COMPLETED Job without a matching marker never
                // enters this effect queue, not even for metadata inspection.
                for job in remote_delivery_candidates(&config)?{
                    drain_controls(&control_rx,&services,16);
                    let id=field(&job,"id");
                    let mut guard=services.borrow_mut();
                    guard.effect(&json!({
                        "action":"effect.remoteDelivery",
                        "jobId":id,
                        "expectedMergedCommitSha":job.pointer("/localMerge/mergedCommitSha"),
                        "projectRoot":job.get("projectRoot"),
                        "idempotencyKey":format!("remoteDelivery:{id}:{}",
                            job.pointer("/localMerge/mergedCommitSha")
                                .and_then(Value::as_str).unwrap_or(""))
                    }))?;
                }
                Ok(())
            })();
            if let Err(error)=result{
                // Preserve an inspectable daemon and keep polling; a failed
                // Job must not kill the Dashboard or spawn an extra scheduler.
                eprintln!("warning: Relay workspace reconciliation: {error}");
            }
            if first { first=false; }
            let interval=Duration::from_millis(config.interval_ms.max(100));
            let until=Instant::now()+interval;
            while !stop.load(Ordering::Acquire)&&Instant::now()<until{
                if services.borrow_mut()
                    .has_pending_model_events(){
                    // NATS already queued immutable rows. Re-run the same
                    // lifecycle owner now instead of waiting up to 5 minutes.
                    // No side effect is trusted until exact SQLite CAS.
                    break;
                }
                match control_rx.recv_timeout(Duration::from_millis(100)){
                    Ok(call)=>{call(&mut *services.borrow_mut());break;},
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout)=>{},
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected)=>break,
                }
            }
        }
        // Close receipts before joining an observer that may be awaiting one.
        drop(control_rx);
        dashboard_shutdown.store(true,Ordering::Release);
        if let Some(observer)=publication_observer{
            observer.join().map_err(|_|"Dashboard publication observer panicked".to_owned())?;
        }
        dash.join().map_err(|_|"Dashboard server thread panicked".to_owned())?
    })
}

#[cfg(test)]
mod dashboard_projection_tests {
    use super::*;
    #[test]
    fn queued_control_waits_for_receipt_but_not_sse_or_read_only_observations(){
        use crate::{dashboard::{DashboardBackend,DashboardRequest},
            relayd_sqlite_write::IsolatedSQLiteWriteHost};
        use std::sync::mpsc;
        let root=std::env::temp_dir().join(format!("relay-owner-{}-{}",
            std::process::id(),Utc::now().timestamp_nanos_opt().unwrap()));
        std::fs::create_dir_all(root.join("stores")).unwrap();
        let mut config=DaemonConfig::from_argv(&[],&json!({})).unwrap();
        config.store_directory=root.join("stores");
        config.graph_directory=Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow");
        config.repositories=vec!["fixture".into()];config.event_transport=json!({});
        let db=relay_unified_store_path(&config.store_directory);
        let store=SQLiteRelayStore::open(&db,Some("42")).unwrap();
        store.save_job(&json!({"id":"42","title":"fixture","repository":"fixture",
            "projectRoot":root,"state":"ACTIVE","tasks":[],"plans":[],
            "createdAt":"2026-11-25T09:00:00Z","updatedAt":"2026-11-25T09:00:00Z"})).unwrap();
        store.close().unwrap();
        let mut host=IsolatedSQLiteWriteHost::new(config.clone());
        let sse=host.dashboard_sse().unwrap();
        let observations=host.dashboard_observation_ports();
        let (tx,rx)=mpsc::sync_channel::<ServiceCall<IsolatedSQLiteWriteHost>>(4);
        let (queued,waiting)=mpsc::channel();let (release,gate)=mpsc::channel();
        let owner=std::thread::spawn(move||{
            let command=rx.recv_timeout(Duration::from_secs(3)).unwrap();
            queued.send(()).unwrap();gate.recv_timeout(Duration::from_secs(4)).unwrap();
            command(&mut host);
        });
        let opts=DashboardApiOptions{graph_directory:config.graph_directory.clone(),
            router_rules_path:config.router_rules_path.clone(),
            troubleshooter_qa_path:troubleshooter_qa_path().unwrap(),webhook_secret:None,
            webhook_repositories:HashSet::new(),webhook_job_id:None};
        let api=Arc::new(NativeDashboardApi::new(opts,DaemonDashboardBackend::with_access(
            config,ServiceAccess::Owner(tx),observations,Some(sse.clone()),false)));
        let client=Arc::clone(&api);let (result,receipt)=mpsc::channel();
        let control=std::thread::spawn(move||{
            result.send(client.api(DashboardRequest{method:"POST",target:"/api/job-action?id=42&action=cancel",body:b"",headers:&HashMap::new()})).unwrap();
        });
        waiting.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(receipt.try_recv().is_err(),"mutation must await durable owner result");
        let (done,read)=mpsc::channel();let observer=Arc::clone(&api);
        let reader=std::thread::spawn(move||{
            let jobs=observer.api(DashboardRequest{method:"GET",target:"/api/jobs",body:b"",headers:&HashMap::new()});
            let status=observer.api(DashboardRequest{method:"GET",target:"/api/status",body:b"",headers:&HashMap::new()});
            let stream=observer.subscribe_events();done.send((jobs.status,status.status,stream)).unwrap();
        });
        let (jobs,status,stream)=read.recv_timeout(Duration::from_secs(2))
            .expect("read or SSE subscription waited on queued lifecycle control");
        assert_eq!((jobs,status),(200,200));sse.publish("independent".into());
        assert_eq!(stream.recv_timeout(Duration::from_secs(1)).unwrap(),"independent");
        release.send(()).unwrap();let response=receipt.recv_timeout(Duration::from_secs(3)).unwrap();
        assert_eq!(response.status,200,"{}",String::from_utf8_lossy(&response.body));
        control.join().unwrap();reader.join().unwrap();owner.join().unwrap();
        let store=SQLiteRelayStore::open_without_claim_reset(&db,Some("42")).unwrap();
        assert_eq!(store.load_job("42").unwrap().unwrap()["state"],"CANCELLED");
        store.close().unwrap();drop(api);std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn detached_history_and_router_usage_do_not_serialize_lifecycle_requests(){
        use crate::{dashboard::{DashboardBackend,DashboardRequest},
            relayd_sqlite_write::IsolatedSQLiteWriteHost};
        use std::{io::Read,sync::mpsc};
        let root=std::env::temp_dir().join(format!("relay-detached-{}-{}",
            std::process::id(),Utc::now().timestamp_nanos_opt().unwrap()));
        std::fs::create_dir_all(root.join("stores")).unwrap();
        let mut config=DaemonConfig::from_argv(&[],&json!({})).unwrap();
        config.store_directory=root.join("stores");
        config.graph_directory=Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow");
        config.repositories=vec!["fixture".into()];
        // Never touch real provider/Events Bus services in this test.
        config.event_transport=json!({});
        let db=relay_unified_store_path(&config.store_directory);
        let store=SQLiteRelayStore::open(&db,Some("42")).unwrap();
        store.save_job(&json!({"id":"42","title":"fixture","repository":"fixture",
            "projectRoot":root,"state":"ACTIVE","tasks":[],"plans":[],
            "createdAt":"2026-11-25T09:00:00Z","updatedAt":"2026-11-25T09:00:00Z"})).unwrap();
        store.close().unwrap();
        let listener=TcpListener::bind("127.0.0.1:0").unwrap();
        let address=listener.local_addr().unwrap();
        let (started,seen)=mpsc::channel();
        let (release,gate)=mpsc::channel();
        let server=std::thread::spawn(move||{
            let (mut stream,_)=listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let mut buf=[0;2048];let n=stream.read(&mut buf).unwrap();
            assert!(String::from_utf8_lossy(&buf[..n]).starts_with("GET /events?filter="));
            started.send(()).unwrap();
            let _=gate.recv_timeout(Duration::from_secs(8));
            // Disconnect simulates an unavailable history, not empty success.
        });
        let mut host=IsolatedSQLiteWriteHost::new(config.clone());
        host.set_loopback_event_history_api(&format!("http://{address}/")).unwrap();
        let opts=DashboardApiOptions{graph_directory:config.graph_directory.clone(),
            router_rules_path:config.router_rules_path.clone(),
            troubleshooter_qa_path:troubleshooter_qa_path().unwrap(),webhook_secret:None,
            webhook_repositories:HashSet::new(),webhook_job_id:None};
        let host=Arc::new(Mutex::new(host));
        let mut backend=DaemonDashboardBackend::new(config,Arc::clone(&host),false);
        // Preserve the actual history reader; inject deliberately stalled
        // provider/Decision Engine reads rather than calling real accounts.
        let (signals,signals_rx)=mpsc::channel();
        let gate=Arc::new((Mutex::new(false),std::sync::Condvar::new()));
        let ports=backend.observation_ports.as_mut().unwrap();
        let usage_gate=Arc::clone(&gate);let usage_signal=signals.clone();
        ports.usage=Arc::new(move||{
            usage_signal.send("usage").unwrap();
            let (lock,ready)=&*usage_gate;
            let _state=ready.wait_timeout_while(lock.lock().unwrap(),Duration::from_secs(8),|v|!*v).unwrap();
            Ok(json!({"providers":[]}))
        });
        let router_gate=Arc::clone(&gate);
        ports.router=Arc::new(move|_,_|{
            signals.send("router").unwrap();
            let (lock,ready)=&*router_gate;
            let _state=ready.wait_timeout_while(lock.lock().unwrap(),Duration::from_secs(8),|v|!*v).unwrap();
            Ok(json!({"diagnostic":true}))
        });
        let api=Arc::new(NativeDashboardApi::new(opts,backend));
        let query=|api:&NativeDashboardApi<DaemonDashboardBackend<IsolatedSQLiteWriteHost>>,method:&str,target:&str,body:&[u8]|{
            api.api(DashboardRequest{method,target,body,headers:&HashMap::new()})
        };
        // Cross-task validation is still performed before network access.
        assert_ne!(query(&api,"GET","/api/events?job=42&task=unrelated",b"").status,200);
        assert_eq!(query(&api,"POST","/api/events?job=42",b"").status,405);
        let history=Arc::clone(&api);
        let history_thread=std::thread::spawn(move||query(&history,"GET","/api/mobile/job-activity?id=42&repo=fixture",b""));
        seen.recv_timeout(Duration::from_secs(2)).unwrap();
        let usage=Arc::clone(&api);
        let usage_thread=std::thread::spawn(move||query(&usage,"GET","/api/usage",b""));
        let router=Arc::clone(&api);
        let router_thread=std::thread::spawn(move||query(&router,"POST","/api/router-test",br#"{"jobId":"42","taskId":"1"}"#));
        let mut observed=vec![signals_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            signals_rx.recv_timeout(Duration::from_secs(2)).unwrap()];
        observed.sort();assert_eq!(observed,vec!["router","usage"]);
        {
            let _owner=host.lock().unwrap();
            let (done,wait)=mpsc::channel();
            let api=Arc::clone(&api);
            std::thread::spawn(move||{done.send(query(&api,"GET","/api/status",b"")).unwrap();});
            assert_eq!(wait.recv_timeout(Duration::from_secs(2))
                .expect("status waited on scheduler lock").status,200);
        }
        let (done,wait)=mpsc::channel();
        let concurrent=Arc::clone(&api);
        std::thread::spawn(move||{
            let busy=query(&concurrent,"POST","/api/router-test",br#"{"jobId":"42","taskId":"1"}"#);
            let read=query(&concurrent,"GET","/api/job?id=42",b"");
            let write=query(&concurrent,"POST","/api/job-action?id=42&action=cancel",b"");
            done.send((busy,read,write)).unwrap();
        });
        let (busy,read,write)=wait.recv_timeout(Duration::from_secs(2))
            .expect("independent observations blocked lifecycle");
        assert_ne!(busy.status,200);
        assert!(String::from_utf8_lossy(&busy.body).contains("Observation busy"));
        assert_eq!(read.status,200);
        assert_eq!(write.status,200,"{}",String::from_utf8_lossy(&write.body));
        let store=SQLiteRelayStore::open_without_claim_reset(&db,Some("42")).unwrap();
        assert_eq!(store.load_job("42").unwrap().unwrap()["state"],"CANCELLED");
        store.close().unwrap();
        release.send(()).unwrap();
        {let (lock,ready)=&*gate;*lock.lock().unwrap()=true;ready.notify_all();}
        assert_ne!(history_thread.join().unwrap().status,200);
        assert_eq!(router_thread.join().unwrap().status,200);
        assert_eq!(usage_thread.join().unwrap().status,200);
        server.join().unwrap();
        drop(api);drop(host);std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn local_legacy_publication_and_failure_metadata_remain_in_the_managed_projection(){
        let job=json!({"id":"42","repository":"agents-relay","state":"COMPLETED",
            "updatedAt":"2026-11-25T10:00:00Z","tasks":[]});
        let mut publications=serde_json::Map::new();
        publications.insert("42".into(),json!({"latest":{"version":"2.0.259"},
            "failure":{"stage":"push"},"updatedAt":"2026-11-25T10:01:00Z"}));
        let snapshot=LocalRelayStoreSnapshot{path:PathBuf::from("fixture"),
            jobs:vec![job.clone()],facts:None,publications};
        let projected=managed_view(&snapshot,&job);
        assert_eq!(projected["runtimeStatus"],"COMPLETED");
        assert_eq!(projected["publication"]["version"],"2.0.259");
        assert_eq!(projected["publicationFailure"]["stage"],"push");
        assert_eq!(projected["publicationObservedAt"],"2026-11-25T10:01:00Z");
    }
}
