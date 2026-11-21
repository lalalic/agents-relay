//! Concrete SQLite + Graph mutations for explicitly isolated native daemon
//! acceptance. Uses the same workspace_control()/SQLiteRelayStore paths as
//! production; provider launch, external events and unported actions fail
//! closed until their real adapters are installed. Never use live credentials.
use crate::{
    dashboard_actions::{dashboard_job_set_state,dashboard_task_action,dashboard_task_set_state},
    relayd_dashboard_actions::workspace_task_create_snapshot,
    git_delivery::source_commit_sha,
    local_merge_delivery::{native_merge_effect,reconcile_local_git_completion},
    local_git_merge::{local_source_head,git as checked_local_git},
    local_merge_projection::reconcile_completed_local_delivery,
    agent_script_discovery::discover_script_agent,
    native_script_execution::run_claimed_script_task,
    native_worker_event_ingress::apply_verified_worker_event,
    route_outcome_recording::record_terminal_route_outcome_jsonl,
    daemon_worker_failure::{
        classify_native_launch_phase, DaemonFailureState, DaemonLiveWorkers,
        DaemonWorkerFailurePorts},
    native_browser_execution::{IsolatedWebHelmConfig,submit_claimed_chatgpt_worker},
    native_script_planner::run_isolated_script_planner,
    manual_plan::prepare_manual_plan,
    planner::create_plan_round,
    native_script_worker::configured_script_interpreter,
    reconciler::Reconciler,
    interactive_request::fail_interactive_review,
    relay_store::SQLiteRelayStore,
    relay_store_discovery::relay_unified_store_path,
    relayd::{inventory_from_local,DaemonConfig,DaemonServices},
    relayd_control::{workspace_control,WorkspaceControlBackend},
};
use serde_json::{json,Value};
use std::{cell::{Ref,RefCell,RefMut},collections::{HashMap,HashSet},future::{ready,Future},path::{Path,PathBuf},pin::pin,sync::mpsc::{self,Receiver,Sender},task::{Context,Poll,Waker}};
fn field<'a>(v:&'a Value,key:&str)->&'a str{v.get(key).and_then(Value::as_str).unwrap_or("")}
fn denied(name:&str)->String{format!("Rust isolated-write daemon {name} not bound; refusing unsafe side effect")}

pub struct IsolatedSQLiteWriteHost {
    config:DaemonConfig,
    subscriptions:Vec<Sender<String>>,
    wake_count:u64,
    reconcile_attempts:u64,
    connections:RefCell<HashMap<String,SQLiteRelayStore>>,
    // Node provenance: src/reconciler-runtime.ts failLaunch binding state.
    // Shared with worker threads so launch failures reach the same
    // Graph/SQLite path as Node, not a bare stderr print.
    failure_state:std::sync::Arc<DaemonFailureState>,
    live_workers:std::sync::Arc<std::sync::Mutex<DaemonLiveWorkers>>,
    // Only explicitly injected loopback fixture URLs are permitted by this
    // isolated host; it NEVER reads a user's real notification endpoint.
    escalation_notifier:Option<crate::escalation_notifier::EscalationNotifierConfig>,
}
impl IsolatedSQLiteWriteHost {
    pub fn new(config:DaemonConfig)->Self{
        Self{config,subscriptions:Vec::new(),wake_count:0,reconcile_attempts:0,connections:RefCell::new(HashMap::new()),
            failure_state:std::sync::Arc::new(DaemonFailureState::new()),
            live_workers:std::sync::Arc::new(std::sync::Mutex::new(DaemonLiveWorkers::default())),
            escalation_notifier:None}
    }
    /// Explicit fixture transport only. No environment-derived or public
    /// GitHub/HTTPS notification endpoint can run inside isolated mode.
    pub fn set_test_loopback_escalation_notifier(
        &mut self,config:crate::escalation_notifier::EscalationNotifierConfig,
    )->Result<(),String>{
        if config.url.scheme()!="http"
            ||!matches!(config.url.host_str(),Some("localhost"|"127.0.0.1"|"::1")){
            return Err("Isolated escalation notifier requires an explicit loopback fixture".into());
        }
        self.escalation_notifier=Some(config);
        Ok(())
    }
    fn path(&self)->PathBuf{relay_unified_store_path(&self.config.store_directory)}
    /// Isolated writes must be confined to the same disposable caller-owned
    /// workspace as SQLite. A copied Job snapshot pointing at a live source
    /// checkout cannot authorize either a Script Worker or a Git merge/push.
    fn isolated_project(&self,job:&Value)->Result<PathBuf,String>{
        let root=std::fs::canonicalize(field(job,"projectRoot"))
            .map_err(|e|format!("Invalid isolated Job projectRoot: {e}"))?;
        let base=std::fs::canonicalize(
            self.config.store_directory.parent().ok_or("Isolated store has no parent")?)
            .map_err(|e|e.to_string())?;
        if root==base || !root.starts_with(&base)
            || root.file_name().and_then(|v|v.to_str())!=Some(field(job,"repository"))
            ||!root.join(".git").is_dir(){
            return Err("Isolated Rust daemon refuses Job project outside its own independent Git fixture".into());
        }
        Ok(root)
    }
    fn ensure_scoped(&self,id:&str,allow_create:bool)->Result<(),String>{
        if id.is_empty(){return Err("Immutable Job ID required".into());}
        if self.connections.borrow().contains_key(id){return Ok(());}
        if !allow_create&&!self.path().is_file(){
            return Err(format!("SQLite Job {id} not found"));
        }
        let store=SQLiteRelayStore::open_without_claim_reset(&self.path(),Some(id))?;
        self.connections.borrow_mut().insert(id.to_string(),store);
        Ok(())
    }
    fn scoped(&self,id:&str)->Result<Ref<'_,SQLiteRelayStore>,String>{
        self.ensure_scoped(id,false)?;
        Ok(Ref::map(self.connections.borrow(),|stores|stores.get(id).expect("cached scoped DB")))
    }
    fn scoped_create(&self,id:&str)->Result<RefMut<'_,SQLiteRelayStore>,String>{
        self.ensure_scoped(id,true)?;
        Ok(RefMut::map(self.connections.borrow_mut(),|stores|
            stores.get_mut(id).expect("cached scoped DB")))
    }
    fn all(&self)->Result<Vec<Value>,String>{inventory_from_local(&self.config,false)}
    fn persist_exact(&self,id:&str,prior:&Value,next:&Value)->Result<Value,String>{
        if field(prior,"id")!=id||field(next,"id")!=id{
            return Err("Cross-Job SQLite CAS forbidden".into());
        }
        let expected=prior.clone();let candidate=next.clone();
        self.scoped(id)?.mutate_job(id,|current|{
            if current!=expected{
                return Err("Concurrent Job mutation; recompute from SQLite snapshot".into());
            }
            Ok(candidate)
        })
    }
    fn isolated_origin(&self,project:&Path)->Result<(),String>{
        let names=checked_local_git(project,&["remote"])?;
        if !names.lines().any(|name|name=="origin"){return Ok(());}
        let url=checked_local_git(project,&["remote","get-url","--push","origin"])?;
        let raw=Path::new(&url);
        if !raw.is_absolute(){
            return Err("Isolated native daemon refuses network or relative Git origin delivery".into());
        }
        let origin=std::fs::canonicalize(raw)
            .map_err(|e|format!("Invalid isolated Git origin: {e}"))?;
        let parent=std::fs::canonicalize(
            self.config.store_directory.parent().ok_or("Isolated store parent missing")?)
            .map_err(|e|e.to_string())?;
        if !origin.starts_with(parent){
            return Err("Isolated native daemon refuses delivery outside its own Git fixture".into());
        }
        Ok(())
    }
    /// Internal EventBus adapter port. Caller authentication remains the
    /// responsibility of the future provider transport: source correlation
    /// alone is NOT authentication. Never expose this as an open HTTP/CLI
    /// command or treat a submission receipt as Worker completion.
    pub fn accept_model_worker_event(&mut self,job_id:&str,task_id:&str,
        execution_id:&str,event:&Value)->Result<Value,String>{
        let job=self.scoped(job_id)?.load_job(job_id)?
            .ok_or_else(||format!("SQLite Job {job_id} not found"))?;
        self.isolated_project(&job)?;
        let result=apply_verified_worker_event(&self.path(),&self.config.graph_directory,
            job_id,task_id,execution_id,event)?;
        // This audit is strictly post-Graph/SQLite commit. A rejected or
        // duplicate execution cannot append an outcome, and an audit I/O
        // failure is observational (never rolls back durable Task state).
        if matches!(field(event,"type"),"task.completed"|"task.failed"){
            if let Some(task)=result["tasks"].as_array().into_iter().flatten()
                .find(|task|field(task,"id")==task_id){
                let audit_path=self.config.store_directory.parent()
                    .ok_or("Native isolated store has no parent")?
                    .join("decision-audit.jsonl");
                record_terminal_route_outcome_jsonl(
                    &audit_path,task,event,Some(execution_id));
            }
        }
        // Notifications and scheduling are post-commit effects. A submitted
        // browser receipt or a speculative provider callback must never
        // notify Dashboard that an uncommitted Task succeeded.
        self.emit(event.clone());
        if matches!(field(event,"type"),"task.completed"|"task.failed"){
            self.wake(job_id,"native-model-worker.terminal")?;
        }
        Ok(result)
    }
    pub fn reconcile_remote_delivery(&self,id:&str,expected_sha:&str)->Result<(),String>{
        let job=self.scoped(id)?.load_job(id)?
            .ok_or_else(||format!("SQLite Job {id} not found"))?;
        if job.pointer("/localMerge/mergedCommitSha").and_then(Value::as_str)
            !=Some(expected_sha) || expected_sha.is_empty(){
            return Err("Remote delivery expected SHA no longer matches SQLite completion".into());
        }
        let project=self.isolated_project(&job)?;
        self.isolated_origin(&project)?;
        let graph=self.config.graph_directory.clone();
        reconcile_completed_local_delivery(&graph,id,&project,
            |job_id|self.scoped(job_id)?.load_job(job_id)?
                .ok_or_else(||format!("SQLite Job {job_id} not found")),
            |job_id,mutate|{
                let mut changed=false;
                let saved=self.scoped(job_id)?.mutate_job(job_id,|mut job|{
                    changed=mutate(&mut job)?;
                    Ok(job)
                })?;
                Ok((saved,changed))
            })
    }
    fn apply_dashboard_task_action(&mut self,id:&str,task_id:&str,action:&str)
        ->Result<Value,String>{
        let current=self.scoped(id)?.load_job(id)?
            .ok_or_else(||format!("SQLite Job {id} not found"))?;
        self.isolated_project(&current)?;
        let command=dashboard_task_action(&current,task_id,action)?;
        let result=crate::task_actions::dispatch_task_action(
            &self.config.graph_directory,&*self.scoped(id)?,&command)?;
        self.wake(id,"dashboard.task.action")?;
        Ok(result["job"].clone())
    }
    fn emit(&mut self,value:Value){
        let payload=value.to_string();
        self.subscriptions.retain(|sender|sender.send(payload.clone()).is_ok());
    }
    /// Current Job Graph invokes this effect; the shared local Git module
    /// owns immutable source/target ref checks and completion guard. Each
    /// SQLite snapshot/merge receipt uses an exact CAS, never overwriting
    /// concurrent Task/Review progress.
    pub fn reconcile_git_delivery(&self,id:&str)->Result<bool,String>{
        let mut job=self.scoped(id)?.load_job(id)?
            .ok_or_else(||format!("SQLite Job {id} not found"))?;
        if field(&job,"state")!="ACTIVE"{return Ok(false);}
        let project=self.isolated_project(&job)?;
        let ref_name=job.pointer("/localMerge/sourceRef")
            .and_then(Value::as_str).filter(|s|!s.is_empty());
        let head=ref_name.map(|ref_name|local_source_head(&project,ref_name))
            .transpose()?;
        let timestamp=chrono::Utc::now().timestamp_millis();
        let graph=self.config.graph_directory.clone();
        let prior=RefCell::new(job.clone());
        let save=|candidate:Value,event:Option<Value>|{
            let outcome=(||->Result<Value,String>{
                let expected=prior.borrow().clone();
                let db=self.scoped(id)?;
                let committed=if let Some(event)=event{
                    let key=event.get("event_id").and_then(Value::as_str)
                        .ok_or("Merge result has no durable event identity")?;
                    db.commit_workflow_mutation_and_events(id,|current|{
                        if current!=expected{return Err("Concurrent Job merge receipt CAS conflict".into());}
                        Ok(candidate)
                    },&[json!({"key":key,"event":event})])?
                }else{
                    db.mutate_job(id,|current|{
                        if current!=expected{return Err("Concurrent Job completion CAS conflict".into());}
                        Ok(candidate)
                    })?
                };
                prior.replace(committed.clone());
                Ok(committed)
            })();
            ready(outcome)
        };
        let future=reconcile_local_git_completion(&graph,&mut job,head.as_deref(),
            true,Some(&project),timestamp,save,native_merge_effect);
        // This action's save adapter is entirely synchronous SQLite I/O.
        // A pending Future would be a wiring bug, never a reason to mark
        // a Job complete without committed source/target evidence.
        let mut future=pin!(future);
        let mut ctx=Context::from_waker(Waker::noop());
        match future.as_mut().poll(&mut ctx){
            Poll::Ready(result)=>result,
            Poll::Pending=>Err("Native local Git completion effect unexpectedly suspended".into())
        }
    }
}
impl IsolatedSQLiteWriteHost {
    /// Automatic Reconciler Planner effect, reusing the exact native
    /// PlannerLaunchPorts/finishPlanner Script runner as manual job.plan.
    /// The Plan is already Graph-authorized and durably CAS-committed before
    /// this volatile effect. Never create a second Plan or launch Codex.
    fn launch_graph_planner_effect(&mut self,action:&Value)->Result<(),String>{
        let id=field(action,"jobId");
        let plan_id=field(action,"planId");
        if id.is_empty()||plan_id.is_empty(){
            return Err("Graph Planner launch requires exact Job/Plan ID".into());
        }
        let job=self.scoped(id)?.load_job(id)?
            .ok_or("Graph Planner Job was not committed to SQLite")?;
        let project=self.isolated_project(&job)?;
        let plan=job.get("plans").and_then(Value::as_array)
            .into_iter().flatten().find(|plan|field(plan,"id")==plan_id)
            .ok_or("Graph Planner Plan was not committed to SQLite")?;
        if field(plan,"status")!="PLANNING"{
            // A stale planner effect may arrive after the first generation
            // committed; never start a duplicate execution.
            return Ok(());
        }
        let declared=project.join("agents/.shortcut/planner.agent.mjs");
        let script=std::fs::canonicalize(&declared)
            .map_err(|e|format!("Automatic Planner has no declared trusted Shortcut: {e}"))?;
        if !script.starts_with(&project)||!script.is_file(){
            return Err("Automatic Planner Shortcut escapes canonical Job Git root".into());
        }
        let interpreter=PathBuf::from(configured_script_interpreter()?);
        let timeout=plan.get("timeoutMs").and_then(Value::as_u64)
            .unwrap_or(60_000).clamp(100,86_400_000);
        let graph=self.config.graph_directory.clone();
        let store_directory=self.config.store_directory.clone();
        let db=self.path();
        let job_id=id.to_string();
        let plan_id=plan_id.to_string();
        std::thread::Builder::new().name(format!("rust-automatic-planner-{plan_id}"))
            .spawn(move||{
                if let Err(error)=run_isolated_script_planner(
                    &db,&store_directory,&graph,&job_id,&plan_id,
                    &script,&interpreter,timeout){
                    eprintln!("Native automatic Planner {job_id}/{plan_id}: {error}");
                }
            }).map_err(|e|format!("Cannot spawn isolated automatic Planner: {e}"))?;
        Ok(())
    }
}
impl WorkspaceControlBackend for IsolatedSQLiteWriteHost {
    fn graph_directory(&self)->&Path{&self.config.graph_directory}
    fn store_directory(&self)->&Path{&self.config.store_directory}
    fn repositories(&self)->Vec<String>{self.config.repositories.clone()}
    fn repository_path(&self,repository:&str)->Option<String>{
        self.all().ok()?.into_iter().find(|j|field(j,"repository")==repository)
            .and_then(|j|j.get("projectRoot").and_then(Value::as_str).map(str::to_owned))
    }
    fn known_jobs(&mut self)->Result<Vec<Value>,String>{self.all()}
    fn load_job(&mut self,id:&str)->Result<Value,String>{
        self.scoped(id)?.load_job(id)?.ok_or_else(||format!("SQLite Job {id} not found"))
    }
    fn save_job(&mut self,job:&Value)->Result<Value,String>{
        let id=field(job,"id");
        self.scoped(id)?.save_job(job)?;Ok(job.clone())
    }
    fn create_job_if_absent(&mut self,job:&Value)->Result<Value,String>{
        // Creation is the first point where an untrusted Control request can
        // establish its source root. Refuse outside-fixture roots BEFORE
        // opening or mutating SQLite, rather than relying on later actions.
        self.isolated_project(job)?;
        let id=field(job,"id");
        self.scoped_create(id)?.create_job_if_absent(job)
    }
    fn mutate_job(&mut self,id:&str,reduce:&dyn Fn(&mut Value)->Result<(),String>)
        ->Result<Value,String>{
        self.scoped(id)?.mutate_job(id,|mut job|{reduce(&mut job)?;Ok(job)})
    }
    fn append_task(&mut self,id:&str,task:&Value)->Result<Value,String>{
        if field(task,"jobId")!=id||field(task,"id").is_empty(){
            return Err("Task create requires immutable Job/Task identity".into());
        }
        self.scoped(id)?.mutate_job(id,|mut job|{
            let list=job.get_mut("tasks").and_then(Value::as_array_mut)
                .ok_or("Job Task list unavailable")?;
            if list.iter().any(|row|field(row,"id")==field(task,"id")){
                return Err("Task ID already allocated".into());
            }
            list.push(task.clone());Ok(job)
        })
    }
    fn save_agent(&mut self,id:&str,agent:&Value)->Result<(),String>{
        self.scoped(id)?.upsert_agent(agent)
    }
    fn list_agents(&mut self,id:&str)->Result<Vec<Value>,String>{
        Ok(self.scoped(id)?.load_agents()?.unwrap_or_default())
    }
    fn wake(&mut self,id:&str,reason:&str)->Result<(),String>{
        self.wake_count+=1;
        self.emit(json!({"type":"relay.wake","jobId":id,"reason":reason}));
        Ok(())
    }
    fn refresh_inventory(&mut self)->Result<(),String>{
        // Dashboard reads the authoritative SQLite inventory per request.
        Ok(())
    }
    fn publish(&mut self,event:&Value)->Result<(),String>{
        // SSE is ephemeral observability. A delivery receipt is not a durable
        // execution fact and never advances Task state.
        self.emit(event.clone());Ok(())
    }
    fn manual_plan(&mut self,id:&str,guidance:Option<&str>,force:bool)
        ->Result<Value,String>{
        let current=self.scoped(id)?.load_job(id)?
            .ok_or_else(||format!("SQLite Job {id} not found"))?;
        let project=self.isolated_project(&current)?;
        let declared=project.join("agents/.shortcut/planner.agent.mjs");
        let script=std::fs::canonicalize(&declared).map_err(|e|
            format!("Isolated Planner has no declared Shortcut: {e}"))?;
        if !script.starts_with(&project) || !script.is_file(){
            return Err("Isolated Planner Shortcut escapes the Job project".into());
        }
        let interpreter=PathBuf::from(configured_script_interpreter()?);
        let timeout=60_000u64;
        let graph=self.config.graph_directory.clone();
        let mut scheduled_round=None;
        let committed=self.scoped(id)?.mutate_job(id,|job|{
            let (next,round)=prepare_manual_plan(&graph,&job,guidance,timeout,
                force,|job,guidance,timeout|create_plan_round(&graph,job,guidance,
                    true,Some(timeout),None))?;
            scheduled_round=Some(round);
            Ok(next)
        })?;
        let round=scheduled_round.ok_or("Durable Planner did not create a round")?;
        let plan_id=field(&round,"id").to_owned();
        let job_id=id.to_string();
        let db=self.path();let store=self.config.store_directory.clone();
        std::thread::Builder::new().name(format!("rust-planner-{plan_id}"))
            .spawn(move||{
                if let Err(error)=run_isolated_script_planner(&db,&store,&graph,
                    &job_id,&plan_id,&script,&interpreter,timeout){
                    eprintln!("Native Planner {job_id}/{plan_id}: {error}");
                }
            }).map_err(|e|format!("Cannot launch isolated Planner worker: {e}"))?;
        Ok(json!({"job":committed,"round":round}))
    }
    fn task_update(&mut self,id:&str,task_id:&str,task:&Value,
        expected_updated_at:&str)->Result<Value,String>{
        let original=self.scoped(id)?.load_job(id)?
            .ok_or_else(||format!("SQLite Job {id} not found"))?;
        self.isolated_project(&original)?;
        let scoped=self.scoped(id)?;
        let updated=crate::task_update::apply_managed_task_update(
            &self.config.graph_directory,&scoped,id,task_id,
            task,expected_updated_at)?;
        drop(scoped);
        self.wake(id,"control.task.update")?;
        Ok(updated)
    }
    fn review_targeted(&mut self,id:&str,request:&Value)->Result<Value,String>{
        // Only the exact reviewer execution and immutable reviewed HEAD can
        // submit a correction. Atomic SQLite mutation allocates one numeric
        // child ID, appends the feedback and enqueues the Revision Graph task.
        let mut input=request.clone();
        if input.get("originalTaskId").is_some()
            &&input["originalTaskId"]!=input["taskId"]{
            return Err("Reviewer original Task identity conflicts with requested Task".into());
        }
        input["originalTaskId"]=input["taskId"].clone();
        let directory=self.config.store_directory.clone();
        let graph=self.config.graph_directory.clone();
        self.scoped(id)?.submit_review_revision(&directory,&graph,id,&input)
    }
    fn blocker_ensure(&mut self,request:&Value)->Result<Value,String>{
        // This port accepts only caller-owned independent Git fixtures. The
        // native Graph produces both snapshots, then a single SQLite CAS
        // commits the blocker relation and dependent receipt atomically.
        crate::blocker_recovery::validate_input(request)?;
        let dependent_id=field(request,"dependentJobId");
        let dependent=self.scoped(dependent_id)?.load_job(dependent_id)?
            .ok_or("Dependent Job not found")?;
        self.isolated_project(&dependent)?;
        if field(&dependent,"repository")!=field(request,"dependentRepository"){
            return Err("Blocker dependent repository identity mismatch".into());
        }
        // Validate the target repository's path before allocating any ID.
        let target=json!({"repository":request.get("targetRepository"),
            "projectRoot":request.get("targetProjectRoot")});
        self.isolated_project(&target)?;
        // Inventory discovery projects legacy fields; reload each candidate
        // from its authoritative scoped SQLite snapshot for exact CAS.
        let snapshots=crate::relay_store_discovery::discover_local_relay_store_snapshots(
            &self.config.store_directory)?;
        let mut known=Vec::new();
        for snapshot in snapshots{
            for summary in snapshot.jobs{
                let id=field(&summary,"id");
                let current=self.scoped(id)?.load_job(id)?
                    .ok_or_else(||format!("Discovered blocker Job {id} disappeared"))?;
                known.push(current);
            }
        }
        let plan={
            let future=crate::blocker_recovery::ensure_blocker_recovery(
                &self.config.graph_directory,&self.config.store_directory,
                request,&dependent,&known,request.get("now").and_then(Value::as_str));
            let mut future=pin!(future);
            let mut context=Context::from_waker(Waker::noop());
            match future.as_mut().poll(&mut context){
                Poll::Ready(result)=>result?,
                Poll::Pending=>return Err("Native blocker recovery unexpectedly suspended".into()),
            }
        };
        let blocker_id=field(&plan.blocker,"id").to_owned();
        let prior=known.iter().find(|job|field(job,"id")==blocker_id);
        self.scoped(dependent_id)?.commit_blocker_recovery_pair(
            &dependent,&plan.dependent,prior,&plan.blocker)?;
        self.wake(dependent_id,"blocker.recovery.registered")?;
        self.wake(&blocker_id,"blocker.recovery.registered")?;
        Ok(plan.receipt)
    }
    fn blocker_resolve(&mut self,_:&str,_:&str)->Result<Value,String>{Err(denied("blocker_resolve"))}
    fn local_head(&mut self,job:&Value)->Result<String,String>{source_commit_sha(job)}
    fn fail_interactive(&mut self,id:&str,task:&str,execution:&str,reason:&str)
        ->Result<Value,String>{
        fail_interactive_review(&self.config.graph_directory,&*self.scoped(id)?,id,task,execution,reason)
    }
}
impl DaemonServices for IsolatedSQLiteWriteHost {
    fn control(&mut self,body:&Value)->Result<Value,String>{workspace_control(self,body)}
    fn deliver_pending_escalations(&mut self,id:&str)->Result<(),String>{
        // Node Reconciler calls this before normal Task reconciliation.
        // Isolated tests have NO external notifier credentials: record a
        // durable missing-channel observation, not an invented delivery.
        let current=self.scoped(id)?.load_job(id)?
            .ok_or("Escalation notification Job missing from SQLite")?;
        self.isolated_project(&current)?;
        let notify:Option<Box<dyn Fn(&Value)->Result<Value,String>>>=
            self.escalation_notifier.as_ref().map(|config|{
                let config=config.clone();
                Box::new(move |request:&Value|{
                    crate::escalation_notifier::send_escalation_notification(&config,request)
                }) as Box<dyn Fn(&Value)->Result<Value,String>>
            });
        crate::escalation_notifier::deliver_pending_escalations(
            &current,id,std::time::SystemTime::now(),notify,
            |task_id,escalation_id,mutation|{
                self.scoped(id)?.mutate_job(id,|mut job|{
                    let mut candidate=job.get("tasks").and_then(Value::as_array)
                        .into_iter().flatten().find(|task|field(task,"id")==task_id)
                        .cloned().ok_or("Notification Task absent from SQLite")?;
                    // A verified receipt must go through the canonical
                    // conflict checker even if another worker already marked
                    // it delivered: matching duplicates are idempotent and
                    // contradictory receipts are rejected, never hidden.
                    if let crate::escalation_notifier::NotificationMutation::Delivered{ref receipt}=mutation{
                        return Ok(crate::task_recovery::record_escalation_notification_delivery(
                            &job,task_id,escalation_id,receipt)?["job"].clone());
                    }
                    let escalation=&candidate["escalation"];
                    if field(escalation,"id")!=escalation_id
                        ||field(escalation,"status")!="pending"
                        ||field(&escalation["notification"],"status")=="delivered"{
                        // Failed/no-channel attempts cannot overwrite a
                        // replacement or already delivered escalation.
                        return Ok(job);
                    }
                    match mutation{
                        crate::escalation_notifier::NotificationMutation::Delivered{..}=>{
                            unreachable!("validated delivery handled above")
                        },
                        crate::escalation_notifier::NotificationMutation::MissingChannel=>{
                            let notification=&mut candidate["escalation"]["notification"];
                            if !notification.is_object(){*notification=json!({});}
                            notification["status"]=json!("pending");
                            notification["lastError"]=json!(
                                "Notification delivery channel is not configured");
                        },
                        crate::escalation_notifier::NotificationMutation::Failed{
                            ref message,attempts,ref last_attempt_at,ref next_attempt_at,
                        }=>{
                            let notification=&mut candidate["escalation"]["notification"];
                            if !notification.is_object(){*notification=json!({});}
                            notification["status"]=json!("pending");
                            notification["attempts"]=json!(attempts);
                            notification["lastError"]=json!(message);
                            notification["lastAttemptAt"]=json!(last_attempt_at);
                            notification["nextAttemptAt"]=json!(next_attempt_at);
                        },
                    }
                    let entry=job.get_mut("tasks").and_then(Value::as_array_mut)
                        .and_then(|tasks|tasks.iter_mut().find(|t|field(t,"id")==task_id))
                        .ok_or("Notification Task disappeared before SQLite write")?;
                    *entry=candidate;
                    Ok(job)
                })?;
                Ok(())
            },true)?;
        Ok(())
    }
    fn load(&mut self,id:&str)->Result<Value,String>{WorkspaceControlBackend::load_job(self,id)}
    fn load_execution_process(&mut self,id:&str,task:&str,execution:&str)
        ->Result<Option<Value>,String>{
        self.scoped(id)?.load_execution_process(id,task,execution)
    }
    fn save_exact(&mut self,id:&str,prior:&Value,next:&Value)->Result<Value,String>{
        self.persist_exact(id,prior,next)
    }
    fn job_action(&mut self,id:&str,action:&str)->Result<Value,String>{
        let current=self.scoped(id)?.load_job(id)?
            .ok_or_else(||format!("SQLite Job {id} not found"))?;
        self.isolated_project(&current)?;
        match action {
            "start"=>{
                let next=crate::job_actions::apply_job_activate_action(
                    &self.config.graph_directory,&current)?;
                let saved=self.persist_exact(id,&current,&next)?;
                self.wake(id,"dashboard.job.start")?;
                Ok(saved)
            }
            "cancel"=>{
                let graph=self.config.graph_directory.clone();
                let saved=self.scoped(id)?.mutate_job(id,|fresh|{
                    crate::job_actions::apply_job_cancel_action(&graph,&fresh,None)
                })?;
                self.wake(id,"dashboard.job.cancel")?;
                Ok(saved)
            }
            "reconcile"=>{
                // The same daemon Graph/SQLite Reconciler pass as periodic
                // Pool admission. Never acknowledge only a wake-up.
                let config=self.config.clone();
                let owner=format!("isolated-rust-daemon-{}",std::process::id());
                let runtime_config=config.clone();
                crate::relayd::reconcile_one_daemon_job(
                    &config,self,id,config.concurrency,move |_snapshot|{
                        let config=&runtime_config;
                        Ok(Reconciler::new(
                            config.graph_directory.clone(),
                            config.store_directory.clone(),
                            config.profile_home.clone(),
                            config.policy_path.clone(),
                            config.router_rules_path.clone(),
                            json!({"owner":owner,
                                "maxConcurrent":config.concurrency,
                                "leaseMs":config.lease_ms})))
                    })
            },
            _=>Err(format!("Unsupported Job action {action}")),
        }
    }
    fn task_command(&mut self,body:&Value)->Result<Value,String>{
        let id=field(body,"jobId");
        let task_id=field(body,"taskId");
        match field(body,"action"){
            "retry"|"cancel"=>self.apply_dashboard_task_action(
                id,task_id,field(body,"action")),
            "update"=>{
                let current=self.scoped(id)?.load_job(id)?
                    .ok_or_else(||format!("SQLite Job {id} not found"))?;
                self.isolated_project(&current)?;
                let task=body.get("task").filter(|value|value.is_object())
                    .ok_or("Dashboard Task update requires Task object")?;
                let expected=field(body,"expectedUpdatedAt");
                if task_id.is_empty()||expected.is_empty(){
                    return Err("Dashboard Task update requires identity and version".into());
                }
                let updated=crate::task_update::apply_managed_task_update(
                    &self.config.graph_directory,&*self.scoped(id)?,
                    id,task_id,task,expected)?;
                self.wake(id,"dashboard.task.update")?;
                Ok(updated)
            }
            "create"=>{
                let current=self.scoped(id)?.load_job(id)?
                    .ok_or_else(||format!("SQLite Job {id} not found"))?;
                self.isolated_project(&current)?;
                let task=body.get("task").filter(|value|value.is_object())
                    .ok_or("Dashboard Task create requires Task object")?;
                // No caller-supplied Task ID, no worktree/provider side effects.
                // Allocation is global and idempotent, while Job CAS enforces
                // a single atomic Task append and optional Job activation.
                let overviews=self.all()?.into_iter()
                    .map(|job|json!({"job":job})).collect::<Vec<_>>();
                let (candidate,task_id,existing)=workspace_task_create_snapshot(
                    &self.config.graph_directory,&self.config.store_directory,
                    &overviews,&current,task,
                    body.get("idempotencyKey").and_then(Value::as_str))?;
                let mut updated=if existing{current.clone()}else{
                    self.persist_exact(id,&current,&candidate)?
                };
                if !existing{self.wake(id,"dashboard.task.create")?;}
                updated["createdTaskId"]=json!(task_id);
                Ok(updated)
            }
            _=>Err(denied("unsupported task command")),
        }
    }
    fn task_action(&mut self,id:&str,task_id:&str,action:&str)
        ->Result<Value,String>{
        self.apply_dashboard_task_action(id,task_id,action)
    }
    fn job_set_state(&mut self,id:&str,state:&str,_target:&Value)->Result<Value,String>{
        let original=WorkspaceControlBackend::load_job(self,id)?;
        let (next,remote)=dashboard_job_set_state(&self.config.graph_directory,&original,state)?;
        if remote{return Err(denied("remote job state effect"));}
        self.persist_exact(id,&original,&next)
    }
    fn task_set_state(&mut self,id:&str,task_id:&str,state:&str,target:&Value)
        ->Result<Value,String>{
        let current=self.scoped(id)?.load_job(id)?
            .ok_or_else(||format!("SQLite Job {id} not found"))?;
        self.isolated_project(&current)?;
        if target.get("repository").and_then(Value::as_str)
            .is_some_and(|repo|repo!=field(&current,"repository"))
            ||target.get("prNumber").and_then(Value::as_i64)
                .is_some_and(|pr|pr!=0&&current["prNumber"]!=json!(pr)){
            return Err("Dashboard Task target does not match immutable Job binding".into());
        }
        let command=dashboard_task_set_state(&current,task_id,state)?;
        if command.is_none(){return Ok(current);}
        let result=crate::task_actions::dispatch_task_action(
            &self.config.graph_directory,&*self.scoped(id)?,
            &command.expect("validated Task cancellation"))?;
        self.wake(id,"dashboard.task.setState")?;
        Ok(result["job"].clone())
    }
    fn event_history(&mut self,_:&str,_:Option<&str>,_:i64)->Result<Vec<Value>,String>{
        Err(denied("historical Event query"))
    }
    fn publish_event(&mut self,event:&Value)->Result<(),String>{
        WorkspaceControlBackend::publish(self,event)
    }
    fn subscribe_events(&mut self)->Receiver<String>{
        let (sender,receiver)=mpsc::channel();
        self.subscriptions.push(sender);receiver
    }
    fn router_test(&mut self,_:&str,_:&str)->Result<Value,String>{Err(denied("router_test"))}
    fn decision_audit(&mut self)->Result<Vec<Value>,String>{Err(denied("decision_audit"))}
    fn account_usage(&mut self)->Result<Value,String>{Err(denied("provider account usage"))}
    fn github_usage(&mut self)->Result<Option<Value>,String>{Ok(None)}
    fn status(&mut self)->Value{
        match self.all(){
            Ok(jobs)=>json!({"runtime":"native-rust","mode":"isolated-write",
                "productionReady":false,"jobCount":jobs.len(),"wakeCount":self.wake_count,
                "reconcileAttempts":self.reconcile_attempts,
                "reason":"Script and test-only ChatGPT WebHelm submission bound; authenticated external EventBus and production providers not bound"}),
            Err(error)=>json!({"runtime":"native-rust","mode":"isolated-write",
                "productionReady":false,"error":error}),
        }
    }
    fn reconcile_local_completion(&mut self,id:&str)->Result<bool,String>{
        self.reconcile_git_delivery(id)
    }
    fn prepare_dependency_revisions(&mut self,id:&str)->Result<(),String>{
        let source=self.scoped(id)?.load_job(id)?
            .ok_or("Dependency Revision Job not found")?;
        self.isolated_project(&source)?;
        crate::dependency_revision_execution::reconcile_dependency_revisions(
            &self.config.graph_directory,&self.config.store_directory,
            &*self.scoped(id)?,id)?;
        // Original Node Reconciler retries previously committed Planner
        // cross-Job intents BEFORE scheduling fresh work. A registration
        // error leaves that precise intent pending for the next wake.
        let db=self.path();
        let graph=self.config.graph_directory.clone();
        let stores=self.config.store_directory.clone();
        let mut registrar=|job_id:&str,request:&Value|{
            crate::native_script_planner::register_isolated_planner_unblock(
                &db,&stores,&graph,job_id,request)
        };
        crate::planner_runtime::retry_pending_planner_unblocks(
            &*self.scoped(id)?,id,Some(&mut registrar),true)?;
        Ok(())
    }
    fn registered_agents(&mut self)->Result<Vec<Value>,String>{
        self.reconcile_attempts+=1;
        let mut seen=HashSet::new();let mut agents=Vec::new();
        for job in self.all()?{
            for agent in WorkspaceControlBackend::list_agents(self,field(&job,"id"))?{
                let key=field(&agent,"id").to_owned();
                if seen.insert(key){agents.push(agent)}
            }
        }
        Ok(agents)
    }
    fn effect(&mut self,action:&Value)->Result<(),String>{
        if matches!(field(action,"action"),"planner.launch"|"planner.recoverPending"){
            // Both actions are selected by canonical planner-orchestration
            // Graph. A restart recovery retries the existing Plan without
            // allocating a second round or reusing a stale generation.
            return self.launch_graph_planner_effect(action);
        }
        if field(action,"action")=="effect.remoteDelivery"{
            return self.reconcile_remote_delivery(
                field(action,"jobId"),field(action,"expectedMergedCommitSha"));
        }
        if field(action,"action")!="effect.launchTask"{
            return Err(denied("Planner or unsupported Worker effect"));
        }
        let id=field(action,"jobId");
        let task_id=field(action,"taskId");
        let original=WorkspaceControlBackend::load_job(self,id)?;
        let task=original.get("tasks").and_then(Value::as_array).into_iter().flatten()
            .find(|task|field(task,"id")==task_id)
            .ok_or("Unregistered Worker Task")?;
        // Each adapter must have a real, explicitly isolated source and
        // transport before a Task generation can be reserved. No Node Relay
        // fallback, no implicit production WebHelm, no receipt-based success.
        let adapter=field(task,"adapter");
        if adapter!="script"&&adapter!="chatgpt"{
            return Err(denied("unsupported model Worker adapter"));
        }
        let _project_root=self.isolated_project(&original)?;
        if adapter=="chatgpt"{
            let config=IsolatedWebHelmConfig::from_test_store(&self.config.store_directory)?;
            if task.get("routing").is_none_or(Value::is_null){
                return Err("Native ChatGPT Worker requires verified routing metadata".into());
            }
            let mut reconciler=Reconciler::new(
                self.config.graph_directory.clone(),self.config.store_directory.clone(),
                self.config.profile_home.clone(),self.config.policy_path.clone(),
                self.config.router_rules_path.clone(),
                json!({"owner":format!("isolated-rust-daemon-{}",std::process::id()),
                    "maxConcurrent":self.config.concurrency,"leaseMs":self.config.lease_ms}),
            );
            let claimed=reconciler.claim_task_execution(&original,task_id,
                self.config.lease_ms)?.ok_or("ChatGPT Task no longer eligible for launch")?;
            self.persist_exact(id,&original,&claimed)?;
            let task=claimed.get("tasks").and_then(Value::as_array).into_iter().flatten()
                .find(|task|field(task,"id")==task_id).cloned()
                .ok_or("ChatGPT Task vanished during lease claim")?;
            let db=self.path();let job_id=id.to_string();let task_id=task_id.to_string();
            let execution_id=field(&task,"executionId").to_string();
            let graph=self.config.graph_directory.clone();
            let pool_path=Some(config.pool_db.clone());
            let audit_path=self.config.store_directory.parent()
                .map(|parent|parent.join("decision-audit.jsonl"));
            let profile_home=Some(self.config.profile_home.clone());
            let adapters=json!([
                {"id":"codex","name":"codex","capabilities":["model","codex"]},
                {"id":"chatgpt/browser-worker","name":"chatgpt","capabilities":["model","chatgpt","webhelm"]},
                {"id":"z","name":"z","capabilities":["model","z"]}
            ]).as_array().cloned().ok_or("Daemon adapter inventory invalid")?;
            let failure_state=std::sync::Arc::clone(&self.failure_state);
            let live_workers=std::sync::Arc::clone(&self.live_workers);
            live_workers.lock().expect("daemon live workers lock poisoned")
                .register(&task_id,&execution_id);
            std::thread::Builder::new().name(format!("rust-chatgpt-task-{task_id}"))
                .spawn(move||{
                    let cancelled=std::sync::atomic::AtomicBool::new(false);
                    let outcome=submit_claimed_chatgpt_worker(
                        &db,&job_id,&task,&config,&cancelled);
                    if let Err(error)=&outcome{
                        eprintln!("Native ChatGPT Worker {job_id}/{task_id}: {error}");
                    }
                    if let Ok(_execution)=&outcome{
                        // Node markWorkerStarted: a successful isolated
                        // submission proves the Worker generation started, so
                        // any later failure is not a no-start fallback case.
                        live_workers.lock().expect("daemon live workers lock poisoned")
                            .mark_started(&task_id,&execution_id);
                        return;
                    }
                    let error=outcome.expect_err("outcome is Err");
                    // Node reconciler.ts failLaunch: a Worker launch failure
                    // must reach handleWorkerLaunchFailure so the Graph alone
                    // decides retry, quarantine or terminal; a stderr print
                    // would strand the leased generation forever.
                    let phase=classify_native_launch_phase(&error);
                    let mut ports=DaemonWorkerFailurePorts::new(
                        db.clone(),graph.clone(),Some(job_id.clone()),
                        pool_path.clone(),audit_path.clone(),
                        profile_home.clone(),adapters.clone(),
                        std::sync::Arc::clone(&live_workers),
                        std::sync::Arc::clone(&failure_state));
                    if let Err(port_error)=crate::worker_failure_recovery::
                        handle_worker_launch_failure(&mut ports,&job_id,&task_id,
                            Some(&execution_id),&json!(error),phase){
                        eprintln!("Native ChatGPT Worker failure transition {job_id}/{task_id} failed: {port_error}");
                    }
                }).map_err(|e|format!("Cannot launch isolated WebHelm Worker executor: {e}"))?;
            return Ok(());
        }
        let script=discover_script_agent(field(task,"agentName"),
            field(&original,"projectRoot"),
            self.config.workspace_root.to_str(),None)?
            .ok_or("Source Worker has no declared trusted Shortcut")?;
        if !Path::new(&script).is_file(){return Err("Script Agent module is absent".into());}
        let isolated_parent=std::fs::canonicalize(
            self.config.store_directory.parent().ok_or("Isolated store parent missing")?)
            .map_err(|e|e.to_string())?;
        let output=task.pointer("/output/path").and_then(Value::as_str)
            .ok_or("Native Script Worker requires a declared file output")?;
        let output_parent=Path::new(output).parent()
            .ok_or("Native Script Worker output path has no parent")?;
        let output_existing=output_parent.ancestors()
            .find(|path|path.exists())
            .and_then(|path|std::fs::canonicalize(path).ok())
            .ok_or("Native Script Worker output parent cannot be canonicalized")?;
        if task.pointer("/output/kind")!=Some(&json!("file"))
            || !Path::new(output).is_absolute()
            || !output_existing.starts_with(&isolated_parent){
            return Err("Native Script Worker output must remain inside the isolated job root".into());
        }
        let runtime=configured_script_interpreter()?;
        let mut reconciler=Reconciler::new(
            self.config.graph_directory.clone(),self.config.store_directory.clone(),
            self.config.profile_home.clone(),self.config.policy_path.clone(),
            self.config.router_rules_path.clone(),
            json!({"owner":format!("isolated-rust-daemon-{}",std::process::id()),
                "maxConcurrent":self.config.concurrency,"leaseMs":self.config.lease_ms}),
        );
        let claimed=reconciler.claim_task_execution(&original,task_id,
            self.config.lease_ms)?.ok_or("Script Task no longer eligible for launch")?;
        // One immutable generation claim, committed via same transactional CAS.
        self.persist_exact(id,&original,&claimed)?;
        let task=claimed.get("tasks").and_then(Value::as_array).into_iter().flatten()
            .find(|task|field(task,"id")==task_id).cloned()
            .ok_or("Script Task vanished during lease claim")?;
        let path=self.path();
        let graph=self.config.graph_directory.clone();
        let runtime=PathBuf::from(runtime);
        let timeout=task.get("timeoutMs").and_then(Value::as_u64)
            .unwrap_or(900_000).clamp(100,86_400_000);
        let job_id=id.to_string();let task_id=task_id.to_string();
        std::thread::Builder::new().name(format!("rust-script-task-{task_id}"))
            .spawn(move||{
                if let Err(error)=run_claimed_script_task(
                    &path,&graph,&claimed,&task,&runtime,timeout){
                    eprintln!("Rust Script Worker {job_id}/{task_id}: {error}");
                }
            }).map_err(|e|format!("Cannot launch owned Script Worker executor: {e}"))?;
        Ok(())
    }
}
