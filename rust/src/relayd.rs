// Head-to-head Phase1 port: src/relayd.ts
// Workspace Relay daemon: SQLite-first discovery, one Job ID registry,
// one Pool, optional NATS and optional post-completion remote delivery.
// During Phase1 this is SOURCE ONLY; it must not be launched against live
// Relay. The Dashboard client is served unchanged by dashboard.rs.
use crate::{
    dashboard::{DashboardBackend,DashboardOptions,DashboardServer},
    local_merge_projection::reconcile_completed_local_delivery,
    pool::{RepositoryWorkerPool,runnable_managed_jobs},
    reconciler::{Reconciler,ReconcileResult},
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
    sync::{Arc,Mutex,atomic::{AtomicBool,Ordering}},
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
    pub lease_ms:u64,
    pub no_github:bool,
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
        let lease_ms=value(args,"--lease-ms","300000").parse::<u64>()
            .map_err(|_|"Invalid --lease-ms")?;
        let repositories=roots.repository.into_iter().collect::<Vec<_>>();
        let event_transport=crate::events_bus_runtime::resolve_events_bus_runtime(
            options.get("environment").unwrap_or(&json!({})))?;
        Ok(Self{
            workspace_root:workspace,
            store_directory:get_path("storeDirectory",
                &crate::relay_store::relay_store_directory().to_string_lossy()),
            graph_directory:get_path("graphDirectory","workflows"),
            profile_home:get_path("codexHome",".codex"),
            policy_path:get_path("routingPolicyPath",
                ".agents-relay/routing-policy.json"),
            router_rules_path:get_path("routerRulesPath",
                ".agents-relay/execution-router-rules.md"),
            dashboard_asset:get_path("dashboardAsset",
                "dist/dashboard.html"),
            repositories,port,concurrency,interval_ms,lease_ms,
            no_github:true,event_transport,
        })
    }
}
fn managed_view(snapshot:&LocalRelayStoreSnapshot,job:&Value)->Value{
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
pub fn exact_job(inventory:&[Value],job_id:&str,repo:Option<&str>,
    pr:Option<u64>)->Result<Option<Value>,String>{
    let matches=inventory.iter().filter(|job|
        field(job,"id")==job_id
            &&repo.is_none_or(|repo|field(job,"repository")==repo)
            &&pr.is_none_or(|pr|job.get("prNumber").and_then(Value::as_u64)
                ==Some(pr))).collect::<Vec<_>>();
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
    exact_job(&inventory,job_id,None,None)?.ok_or_else(||format!(
        "Local Job {job_id} not found or ambiguous in SQLite registry"))
}
pub struct DaemonWorkPort<'a>{
    pub load:&'a mut dyn FnMut(&str)->Result<Value,String>,
    pub persist:&'a mut dyn FnMut(&str,&Value,&Value)->Result<Value,String>,
    pub launch:&'a mut dyn FnMut(&Value)->Result<(),String>,
    pub broadcast:&'a mut dyn FnMut(&Value)->Result<(),String>,
}
/// Two-stage reconcile: first compute a version-fenced candidate; only
/// after a successful SQLite transaction execute the selected effect IDs.
pub fn reconcile_durable_job(
    reconciler:&mut Reconciler,job_id:&str,
    verified_head:Option<&str>,project:&Path,roots:&Value,
    adapters:&[Value],registered:&[Value],usage:Option<&Value>,
    ports:&mut DaemonWorkPort<'_>,
)->Result<Value,String>{
    let snapshot=(ports.load)(job_id)?;
    let result=reconciler.reconcile_snapshot(&snapshot,verified_head,
        project,roots,adapters,registered,usage)?;
    let job=if result.changed{
        (ports.persist)(job_id,&snapshot,&result.job)?
    }else{snapshot.clone()};
    for event in &result.events{
        // External transports are telemetry; a publish outage must never
        // reverse a successfully committed authoritative snapshot.
        if let Err(error)=(ports.broadcast)(event){
            eprintln!("warning: Relay event transport unavailable: {error}");
        }
    }
    for action in &result.effects{
        (ports.launch)(action)?;
    }
    for execution in &result.cancel_generations{
        if let Some(task)=snapshot.get("tasks").and_then(Value::as_array)
            .into_iter().flatten().find(|task|
                task.get("executionId").and_then(Value::as_str)
                    ==Some(execution.as_str())){
            reconciler.runtime.cancel_execution_generation(
                job_id,field(task,"id"),execution);
        }
    }
    Ok(job)
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
    fn control(&mut self,body:&Value)->Result<Value,String>;
    fn load(&mut self,id:&str)->Result<Value,String>;
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
    fn router_test(&mut self,id:&str,task_id:&str)->Result<Value,String>;
    fn decision_audit(&mut self)->Result<Vec<Value>,String>;
    fn account_usage(&mut self)->Result<Value,String>;
    fn github_usage(&mut self)->Result<Option<Value>,String>;
    fn status(&mut self)->Value;
    fn registered_agents(&mut self)->Result<Vec<Value>,String>;
    fn effect(&mut self,action:&Value)->Result<(),String>;
}
pub struct DaemonDashboardBackend<S:DaemonServices>{
    pub config:DaemonConfig,pub services:Arc<Mutex<S>>,
}
impl<S:DaemonServices> DashboardBackend for DaemonDashboardBackend<S>{
    fn discovered_jobs(&mut self,force:bool)->Result<Vec<Value>,String>{
        let _=force;inventory_from_local(&self.config,false)
    }
    fn exact_job(&mut self,id:&str,repo:Option<&str>,pr:Option<u64>)
        ->Result<Option<Value>,String>{
        exact_job(&inventory_from_local(&self.config,false)?,id,repo,pr)
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
}
/// Runtime host explicit opt-in: one server, one Pool, SQLite inventory only.
pub fn run_daemon<S:DaemonServices>(
    config:DaemonConfig,services:S,
    stop:&AtomicBool,
    mut make_reconciler:impl FnMut(&Value)->Result<Reconciler,String>,
)->Result<(),String>{
    let opts=DashboardOptions{
        client_asset_path:config.dashboard_asset.clone(),
        dashboard_version:"rust2-phase1".into(),
        graph_directory:config.graph_directory.clone(),
        router_rules_path:config.router_rules_path.clone(),
        webhook_secret:None,webhook_repositories:HashSet::new(),
        webhook_job_id:None,webhook_pr_number:None,
    };
    let services=Arc::new(Mutex::new(services));
    let dashboard=DashboardServer::new(opts,DaemonDashboardBackend{
        config:config.clone(),services:Arc::clone(&services),
    });
    let mut pool=RepositoryWorkerPool::new(
        config.concurrency,config.graph_directory.clone());
    // One native HTTP listener plus one native reconciliation loop. The
    // underlying Store/service is shared and serialized; no extra owner
    // Reconciler or GitHub discovery scheduler is created.
    std::thread::scope(|scope|->Result<(),String>{
        let dash=scope.spawn(||dashboard.serve(config.port,stop));
        let mut first=true;
        while !stop.load(Ordering::Acquire){
            let result=(||->Result<(),String>{
                let inventory=inventory_from_local(&config,true)?;
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
                        let snapshot=guard.load(id)?;
                        let project=resolve_job_project_root(&snapshot)?;
                        let usage=guard.account_usage().ok();
                        let registered=guard.registered_agents()?;
                        let adapters=json!([
                            {"id":"codex","name":"codex","capabilities":["model","codex"]},
                            {"id":"chatgpt/browser-worker","name":"chatgpt","capabilities":["model","chatgpt","webhelm"]},
                            {"id":"z","name":"z","capabilities":["model","z"]}
                        ]);
                        let mut reconciler=make_reconciler(&snapshot)?;
                        reconciler.options["maxConcurrent"]=json!(capacity);
                        let roots=json!({"workspaceRoot":config.workspace_root});
                        let output=reconciler.reconcile_snapshot(
                            &snapshot,snapshot.get("headSha").and_then(Value::as_str),
                            &project,&roots,adapters.as_array().ok_or("Adapters invalid")?,
                            &registered,usage.as_ref())?;
                        let updated=if output.changed{
                            guard.save_exact(id,&snapshot,&output.job)?
                        }else{snapshot.clone()};
                        for event in &output.events{
                            if let Err(error)=guard.publish_event(event){
                                eprintln!("warning: Relay event transport unavailable: {error}");
                            }
                        }
                        for execution in &output.cancel_generations{
                            if let Some(task)=snapshot.get("tasks").and_then(Value::as_array)
                                .into_iter().flatten().find(|task|
                                    task.get("executionId").and_then(Value::as_str)
                                        ==Some(execution.as_str())){
                                reconciler.runtime.cancel_execution_generation(
                                    id,field(task,"id"),execution);
                            }
                        }
                        for effect in &output.effects{
                            guard.effect(effect)?;
                        }
                        Ok(updated)
                    })?;
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
                std::thread::sleep(Duration::from_millis(100));
            }
        }
        dash.join().map_err(|_|"Dashboard server thread panicked".to_owned())?
    })
}
