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
fn verified_release<'a>(row:&'a Value,package:&str)->Option<(&'a Value,&'a str)> {
    let event=row.get("event")?;
    let data=event.get("data")?;
    let job_id=data.get("jobId")?.as_str()?;
    let sha=data.get("sha")?.as_str()?;
    let version=data.get("version")?.as_str()?;
    let source=event.pointer("/source/id")?.as_str()?;
    let timestamp=event.get("timestamp")?.as_str()?;
    static VERSION_PATTERN:std::sync::OnceLock<regex::Regex>=std::sync::OnceLock::new();
    let version_ok=VERSION_PATTERN.get_or_init(||regex::Regex::new(
        r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$").expect("static version pattern"))
        .is_match(version);
    if event.get("kind")?.as_str()?!="release"
        || event.get("type")?.as_str()?!="package.published"
        || event.get("status")?.as_str()?!="succeeded"
        || data.get("registry")?.as_str()?!="native"
        || data.get("package")?.as_str()?!=package
        || event.get("job_id")?.as_str()?!=job_id
        || job_id.is_empty()
        || event.get("event_id")?.as_str()?!=format!(
            "release:{package}:{sha}:package.published")
        || sha.len()!=40 || !sha.bytes().all(|byte|byte.is_ascii_hexdigit())
        || source!=format!("release/{package}/{sha}")
        || !version_ok || chrono::DateTime::parse_from_rfc3339(timestamp).is_err()
    {return None;}
    Some((event,job_id))
}
fn latest_native_publications(package:&str,rows:&[Value])->HashMap<String,Value>{
    let mut latest=HashMap::<String,Value>::new();
    let mut seen=HashSet::new();
    for row in rows{
        let Some((event,job_id))=verified_release(row,package) else{continue;};
        let receipt=field(event,"event_id");
        if receipt.is_empty()||!seen.insert(receipt){continue;}
        let replace=latest.get(job_id).is_none_or(|prior|field(event,"timestamp")>field(prior,"timestamp"));
        if replace{latest.insert(job_id.into(),event.clone());}
    }
    latest
}
fn overlay_publication_index(jobs:&mut [Value],package:&str,latest:&HashMap<String,Value>){
    for job in jobs.iter_mut().filter(|job|field(job,"repository")==package){
        let Some(event)=latest.get(field(job,"id")) else{continue;};
        let timestamp=field(event,"timestamp");
        if !field(job,"publicationObservedAt").is_empty()
            &&field(job,"publicationObservedAt")>=timestamp{continue;}
        job["publication"]=event["data"].clone();
        job["publication"]["publishedAt"]=json!(timestamp);
        job["publicationFailure"]=Value::Null;
        job["publicationObservedAt"]=json!(timestamp);
    }
}
#[cfg(test)]
fn overlay_native_publications(jobs:&mut [Value],package:&str,rows:&[Value]){
    overlay_publication_index(jobs,package,&latest_native_publications(package,rows));
}
// Release receipts enrich the dashboard; they are never a prerequisite
// for a lifecycle read or write. One bounded worker per dashboard owns all
// HTTP calls, with no API/daemon/cache lock held during network I/O.
struct PublicationEntry {
    rows: Arc<HashMap<String,Value>>,
    pending: bool,
    next_refresh: Instant,
}
struct PublicationCache {
    entries: Arc<Mutex<HashMap<String,PublicationEntry>>>,
    queue: std::sync::mpsc::SyncSender<String>,
}
impl PublicationCache {
    fn new(runtime:Value)->Self {
        let entries=Arc::new(Mutex::new(HashMap::<String,PublicationEntry>::new()));
        let weak=Arc::downgrade(&entries);
        let (queue,receive)=std::sync::mpsc::sync_channel::<String>(32);
        std::thread::spawn(move || {
            while let Ok(package)=receive.recv(){
                if weak.strong_count()==0{break;}
                let result=crate::events_bus_runtime::events_bus_release_history(
                    &package,500,&runtime).map(|rows|latest_native_publications(&package,&rows));
                let Some(entries)=weak.upgrade() else{break;};
                let Ok(mut cache)=entries.lock() else{break;};
                if let Some(entry)=cache.get_mut(&package){
                    entry.pending=false;
                    entry.next_refresh=Instant::now()+Duration::from_secs(
                        if result.is_ok(){30}else{10});
                    // A transient failure never erases a previously verified
                    // receipt. SQLite's newer observation still wins.
                    if let Ok(rows)=result{entry.rows=Arc::new(rows);}
                }
            }
        });
        Self{entries,queue}
    }
    fn rows(&self,package:&str)->Arc<HashMap<String,Value>>{
        let Ok(mut entries)=self.entries.lock() else{return Arc::new(HashMap::new());};
        let entry=entries.entry(package.to_owned()).or_insert_with(||PublicationEntry{
            rows:Arc::new(HashMap::new()),pending:false,next_refresh:Instant::now(),
        });
        if !entry.pending&&Instant::now()>=entry.next_refresh{
            // Never block an API thread on a full refresh queue.
            if self.queue.try_send(package.to_owned()).is_ok(){entry.pending=true;}
            else{entry.next_refresh=Instant::now()+Duration::from_secs(1);}
        }
        Arc::clone(&entry.rows)
    }
    fn overlay(&self,jobs:&mut [Value]){
        let packages=jobs.iter().map(|job|field(job,"repository").to_owned())
            .filter(|package|!package.is_empty()).collect::<HashSet<_>>();
        for package in packages{
            let rows=self.rows(&package);
            overlay_publication_index(jobs,&package,&rows);
        }
    }
}
fn dashboard_inventory(config:&DaemonConfig,cache:&PublicationCache)->Result<Vec<Value>,String>{
    let mut jobs=inventory_from_local(config,false)?;
    cache.overlay(&mut jobs);
    Ok(jobs)
}
fn dashboard_job_by_id(config:&DaemonConfig,cache:&PublicationCache,id:&str,repo:Option<&str>)
    ->Result<Option<Value>,String>{
    let snapshot=crate::relay_store_discovery::discover_unified_job_by_id(
        &config.store_directory,id)?;
    let Some(snapshot)=snapshot else{return Ok(None);};
    let Some(source)=snapshot.jobs.first() else{return Ok(None);};
    let mut job=managed_view(&snapshot,source);
    let package=field(&job,"repository");
    if field(&job,"id")!=id||repo.is_some_and(|repo|package!=repo)
        ||(!config.repositories.is_empty()&&!config.repositories.iter().any(|r|r==package)){
        return Ok(None);
    }
    cache.overlay(std::slice::from_mut(&mut job));
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
pub trait DaemonServices:Send{
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
pub struct DaemonDashboardBackend<S:DaemonServices>{
    pub config:DaemonConfig,pub services:Arc<Mutex<S>>,
    publication_cache:PublicationCache,
    read_only:bool,
}
impl<S:DaemonServices+'static> DaemonDashboardBackend<S>{
    pub fn new(config:DaemonConfig,services:Arc<Mutex<S>>,read_only:bool)->Self{
        let publication_cache=PublicationCache::new(config.event_transport.clone());
        Self{config,services,publication_cache,read_only}
    }
}
impl<S:DaemonServices+'static> DashboardApiServices for DaemonDashboardBackend<S>{
    fn supports_indexed_readonly_job(&self)->bool{self.read_only}
    fn supports_indexed_job(&self)->bool{true}
    fn discovered_jobs(&mut self,force:bool)->Result<Vec<Value>,String>{
        let _=force;dashboard_inventory(&self.config,&self.publication_cache)
    }
    fn runtime_jobs(&mut self)->Result<Vec<Value>,String>{
        inventory_from_local(&self.config,false)
    }
    fn exact_job(&mut self,id:&str,repo:Option<&str>)
        ->Result<Option<Value>,String>{
        dashboard_job_by_id(&self.config,&self.publication_cache,id,repo)
    }
    fn control(&mut self,body:&Value)->Result<Value,String>{
        self.services.lock().map_err(|_|"Daemon service lock poisoned")?.control(body)
    }
    fn job_action(&mut self,id:&str,action:&str)->Result<Value,String>{
        self.services.lock().map_err(|_|"Daemon service lock poisoned")?.job_action(id,action)
    }
    fn task_command(&mut self,body:&Value)->Result<Value,String>{
        self.services.lock().map_err(|_|"Daemon service lock poisoned")?.task_command(body)
    }
    fn task_action(&mut self,id:&str,task_id:&str,action:&str)->Result<Value,String>{
        self.services.lock().map_err(|_|"Daemon service lock poisoned")?.task_action(id,task_id,action)
    }
    fn job_set_state(&mut self,id:&str,state:&str,target:&Value)
        ->Result<Value,String>{
        self.services.lock().map_err(|_|"Daemon service lock poisoned")?.job_set_state(id,state,target)
    }
    fn task_set_state(&mut self,id:&str,task_id:&str,state:&str,target:&Value)
        ->Result<Value,String>{
        self.services.lock().map_err(|_|"Daemon service lock poisoned")?.task_set_state(id,task_id,state,target)
    }
    fn events(&mut self,id:&str,task_id:Option<&str>,limit:i64)
        ->Result<Vec<Value>,String>{
        self.services.lock().map_err(|_|"Daemon service lock poisoned")?.event_history(id,task_id,limit)
    }
    fn github_webhook(&mut self,event:&Value)->Result<(),String>{
        self.services.lock().map_err(|_|"Daemon service lock poisoned")?.publish_event(event)
    }
    fn router_test(&mut self,id:&str,task_id:&str)->Result<Value,String>{
        self.services.lock().map_err(|_|"Daemon service lock poisoned")?.router_test(id,task_id)
    }
    fn decision_audit(&mut self)->Result<Vec<Value>,String>{
        self.services.lock().map_err(|_|"Daemon service lock poisoned")?.decision_audit()
    }
    fn runtime_status(&mut self)->Value{
        self.services.lock().map(|mut services|services.status())
            .unwrap_or_else(|_|json!({"error":"Daemon service lock poisoned"}))
    }
    fn account_usage(&mut self)->Result<Value,String>{
        self.services.lock().map_err(|_|"Daemon service lock poisoned")?.account_usage()
    }
    fn github_usage(&mut self)->Result<Option<Value>,String>{
        self.services.lock().map_err(|_|"Daemon service lock poisoned")?.github_usage()
    }
    fn subscribe_events(&mut self)->Receiver<String>{
        self.services.lock().map(|mut services|services.subscribe_events())
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
    let usage=services.account_usage().ok();
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
        webhook_secret:None,webhook_repositories:HashSet::new(),
        webhook_job_id:None,
    };
    let read_only_shadow=services.is_read_only_shadow();
    let services=Arc::new(Mutex::new(services));
    let dashboard=Arc::new(NativeDashboardApi::new(opts,DaemonDashboardBackend::new(
        config.clone(),Arc::clone(&services),read_only_shadow)));
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
        let mut first=true;
        while !stop.load(Ordering::Acquire){
            if read_only_shadow{
                // No background Job scan or model/provider activity in the
                // live store. Dashboard reads use the original strictly
                // read-only connection on demand, with no stale cached Job.
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
            let result=(||->Result<(),String>{
                let inventory=inventory_from_local(&config,true)?;
                // Script/Model Workers commit Graph facts and append identical
                // durable event receipts from separate subprocesses. Flush
                // their outbox before reconciling successors, with a broker
                // round-trip acknowledgment before marking an event delivered.
                // A disconnected Event Bus must not block Script admission.
                if let Err(error)=services.lock()
                    .map_err(|_|"Daemon service lock poisoned")?
                    .flush_workflow_events(){
                    eprintln!("warning: durable Worker EventBus outbox: {error}");
                }
                // The live Model event subscription is a daemon-level
                // observation. A leased QUEUED/RUNNING Task is intentionally
                // not in the Pool's runnable admission set, but still needs
                // task.started/progress/terminal ingestion. Never let an
                // unavailable EventBus block unrelated Script workers.
                for job in inventory.iter().filter(|job|field(job,"state")=="ACTIVE"){
                    let id=field(job,"id");
                    let receipt=services.lock()
                        .map_err(|_|"Daemon service lock poisoned")?
                        .poll_model_events(id);
                    if let Err(error)=receipt{
                        eprintln!("warning: Model EventBus observation for Job {id}: {error}");
                    }
                }
                let overview=inventory.iter().map(|job|json!({"job":job}))
                    .collect::<Vec<_>>();
                pool.reconcile_discovered(&overview,
                    |id|{
                        let mut guard=services.lock()
                            .map_err(|_|"Daemon service lock poisoned")?;
                        guard.load(id).map(Some)
                    },
                    |id,capacity|{
                        let mut guard=services.lock()
                            .map_err(|_|"Daemon service lock poisoned")?;
                        reconcile_one_daemon_job(
                            &config,&mut *guard,id,capacity,|snapshot|{
                                make_reconciler(snapshot)
                            })
                    })?;
                // Only the canonical Job Lifecycle may authorize local Git
                // merge or COMPLETE. Reconcile after Task results are durably
                // written; never infer completion from a Worker receipt.
                for job in inventory.iter().filter(|j|field(j,"state")=="ACTIVE"){
                    let mut guard=services.lock()
                        .map_err(|_|"Daemon service lock poisoned")?;
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
                    let result=services.lock()
                        .map_err(|_|"Daemon service lock poisoned")?
                        .observe_committed_job_snapshot(id);
                    if let Err(error)=result{
                        eprintln!("warning: Dashboard SQLite observation for Job {id}: {error}");
                    }
                }
                // Optional remote push is a distinct, durable projection.
                // A historic COMPLETED Job without a matching marker never
                // enters this effect queue, not even for metadata inspection.
                for job in remote_delivery_candidates(&config)?{
                    let id=field(&job,"id");
                    let mut guard=services.lock()
                        .map_err(|_|"Daemon service lock poisoned")?;
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
                if services.lock()
                    .map_err(|_|"Daemon service lock poisoned")?
                    .has_pending_model_events(){
                    // NATS already queued immutable rows. Re-run the same
                    // lifecycle owner now instead of waiting up to 5 minutes.
                    // No side effect is trusted until exact SQLite CAS.
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
        dashboard_shutdown.store(true,Ordering::Release);
        dash.join().map_err(|_|"Dashboard server thread panicked".to_owned())?
    })
}

#[cfg(test)]
mod dashboard_projection_tests {
    use super::*;
    fn receipt(job:&str,sha:&str,version:&str,timestamp:&str)->Value{
        json!({"event":{"kind":"release","type":"package.published",
            "status":"succeeded","event_id":format!("release:agents-relay:{sha}:package.published"),
            "job_id":job,"timestamp":timestamp,"source":{"id":format!("release/agents-relay/{sha}")},
            "data":{"package":"agents-relay","jobId":job,"sha":sha,
                "version":version,"registry":"native"}}})
    }
    #[test]
    fn stalled_release_history_never_blocks_indexed_reads_or_job_cancel(){
        use crate::{dashboard::{DashboardBackend,DashboardRequest},
            relayd_sqlite_write::IsolatedSQLiteWriteHost};
        use std::{io::{Read,Write},sync::mpsc};
        let root=std::env::temp_dir().join(format!("relay-pub-nonblocking-{}-{}",
            std::process::id(),Utc::now().timestamp_nanos_opt().unwrap()));
        std::fs::create_dir_all(root.join("stores")).unwrap();
        let mut config=DaemonConfig::from_argv(&[],&json!({})).unwrap();
        config.store_directory=root.join("stores");
        config.graph_directory=Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow");
        config.repositories=vec!["agents-relay".into()];
        let db=relay_unified_store_path(&config.store_directory);
        let store=SQLiteRelayStore::open(&db,Some("42")).unwrap();
        store.save_job(&json!({"id":"42","title":"fixture","repository":"agents-relay",
            "projectRoot":root,"state":"ACTIVE","tasks":[],"plans":[],
            "createdAt":"2026-11-25T09:00:00Z","updatedAt":"2026-11-25T09:00:00Z"})).unwrap();
        store.close().unwrap();
        let listener=TcpListener::bind("127.0.0.1:0").unwrap();
        config.event_transport=json!({"apiUrl":format!("http://{}",listener.local_addr().unwrap())});
        let (started,seen)=mpsc::channel();
        let (release,gate)=mpsc::channel();
        let response=json!({"package":"agents-relay","events":[
            receipt("42",&"a".repeat(40),"2.0.263","2026-11-25T10:00:00Z")]}).to_string();
        let server=std::thread::spawn(move ||{
            let (mut stream,_)=listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let mut buf=[0;2048];let n=stream.read(&mut buf).unwrap();
            assert!(String::from_utf8_lossy(&buf[..n]).starts_with("GET /releases?package=agents-relay&limit=500 "));
            started.send(()).unwrap();
            if gate.recv_timeout(Duration::from_secs(8)).is_ok(){
                let _=write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",response.len(),response);
            }
        });
        let opts=DashboardApiOptions{graph_directory:config.graph_directory.clone(),
            router_rules_path:config.router_rules_path.clone(),webhook_secret:None,
            webhook_repositories:HashSet::new(),webhook_job_id:None};
        let host=Arc::new(Mutex::new(IsolatedSQLiteWriteHost::new(config.clone())));
        let api=Arc::new(NativeDashboardApi::new(opts,DaemonDashboardBackend::new(config,host,false)));
        let query=|api:&NativeDashboardApi<DaemonDashboardBackend<IsolatedSQLiteWriteHost>>,method:&str,target:&str|{
            api.api(DashboardRequest{method,target,body:b"",headers:&HashMap::new()})
        };
        let (first_tx,first_rx)=mpsc::channel();
        let initial=Arc::clone(&api);
        std::thread::spawn(move||{let _=first_tx.send(query(&initial,"GET","/api/jobs"));});
        seen.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(first_rx.recv_timeout(Duration::from_secs(2)).expect("inventory blocked by history").status,200);
        let (done,wait)=mpsc::channel();
        let concurrent=Arc::clone(&api);
        std::thread::spawn(move ||{
            let summary=query(&concurrent,"GET","/api/runtime-summary");
            let read=query(&concurrent,"GET","/api/job?id=42&repo=agents-relay");
            let wrong=query(&concurrent,"GET","/api/job?id=42&repo=other");
            let write=query(&concurrent,"POST","/api/job-action?id=42&action=cancel");
            let _=done.send((summary,read,wrong,write));
        });
        let (summary,read,wrong,write)=wait.recv_timeout(Duration::from_secs(2))
            .expect("control blocked by history");
        assert_eq!(summary.status,200);
        assert_eq!(read.status,200);
        assert_ne!(wrong.status,200);
        assert_eq!(write.status,200,"{}",String::from_utf8_lossy(&write.body));
        let store=SQLiteRelayStore::open_without_claim_reset(&db,Some("42")).unwrap();
        assert_eq!(store.load_job("42").unwrap().unwrap()["state"],"CANCELLED");
        store.close().unwrap();
        release.send(()).unwrap();
        server.join().unwrap();
        let deadline=Instant::now()+Duration::from_secs(2);
        loop{
            let read=query(&api,"GET","/api/job?id=42");
            let snapshot:Value=serde_json::from_slice(&read.body).unwrap();
            assert_eq!(snapshot["state"],"CANCELLED");
            if snapshot["publication"]["version"]=="2.0.263"{break;}
            assert!(Instant::now()<deadline,"verified receipt not visible after refresh");
            std::thread::sleep(Duration::from_millis(10));
        }
        drop(api);std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn native_release_projection_requires_explicit_exact_job_and_repository_correlation(){
        let sha="a".repeat(40);
        let mut jobs=vec![json!({"id":"42","repository":"agents-relay","state":"COMPLETED",
            "publication":null,"publicationFailure":null,"publicationObservedAt":null}),
            json!({"id":"42","repository":"another-project","state":"COMPLETED",
            "publication":null,"publicationFailure":null,"publicationObservedAt":null})];
        let associated=receipt("42",&sha,"2.0.260","2026-11-25T10:00:00Z");
        let mut unassociated=receipt("42",&"b".repeat(40),"2.0.259","2026-11-25T10:01:00Z");
        unassociated["event"]["data"].as_object_mut().unwrap().remove("jobId");
        let unrelated=receipt("43",&"c".repeat(40),"2.0.258","2026-11-25T10:02:00Z");
        overlay_native_publications(&mut jobs,"agents-relay",&[
            associated.clone(),associated,unassociated,unrelated]);
        assert_eq!(jobs[0]["publication"]["version"],"2.0.260");
        assert_eq!(jobs[0]["publicationFailure"],Value::Null);
        assert!(jobs[1]["publication"].is_null());
    }
    #[test]
    fn newest_verified_receipt_wins_and_new_publication_clears_older_failure(){
        let old="a".repeat(40);let new="b".repeat(40);
        let mut jobs=vec![json!({"id":"42","repository":"agents-relay","state":"COMPLETED",
            "publication":null,"publicationFailure":{"stage":"push"},
            "publicationObservedAt":"2026-11-25T09:00:00Z"})];
        let rows=vec![receipt("42",&new,"2.0.260","2026-11-25T10:00:00Z"),
            receipt("42",&old,"2.0.259","2026-11-25T08:00:00Z")];
        overlay_native_publications(&mut jobs,"agents-relay",&rows);
        assert_eq!(jobs[0]["publication"]["version"],"2.0.260");
        assert_eq!(jobs[0]["publicationFailure"],Value::Null);
        assert_eq!(jobs[0]["state"],"COMPLETED");
    }
    #[test]
    fn invalid_release_payloads_and_older_receipts_do_not_replace_metadata(){
        let older="a".repeat(40);let bad="b".repeat(40);
        let mut job=json!({"id":"42","repository":"agents-relay","state":"COMPLETED",
            "publication":{"version":"2.0.260"},"publicationFailure":null,
            "publicationObservedAt":"2026-11-25T10:00:00Z"});
        let mut invalid=receipt("42",&bad,"2.0.261","2026-11-25T11:00:00Z");
        invalid["event"]["status"]=json!("failed");
        overlay_native_publications(std::slice::from_mut(&mut job),"agents-relay",
            &[receipt("42",&older,"2.0.259","2026-11-25T09:00:00Z"),invalid]);
        assert_eq!(job["publication"]["version"],"2.0.260");
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
